import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";

/**
 * Choosing which promoted video a viewer sees, and charging for it honestly.
 *
 * ## Where ads appear
 *
 * Interleaved into the organic For You feed at fixed positions, as the same card component with a
 * "Sponsored" label. Not a separate rail, not a different shape — a distinct ad widget is a thing
 * people learn to skip in about a day, and it would also mean maintaining two card renderers.
 *
 * ## What stops this being adversarial
 *
 * - **A fixed, sparse cadence.** One ad, then a gap of at least AD_INTERVAL organic videos. The
 *   density cannot rise with demand, so more advertisers means a longer queue for the same slots
 *   rather than a worse feed. This is the single most important line in the file.
 * - **Ads are ordinary approved videos.** The creative went through the same human review as
 *   everything else in the feed before it could ever be promoted.
 * - **No behavioural targeting.** Optional tag targeting only, matched against the video's own
 *   tags — never against the viewer's taste profile. Building an ad product on top of the
 *   personalisation profile is the step that turns "we rank your feed" into "we sell access to
 *   what we learned about you", and it is not a step to take by accident.
 */

/** Position of the first ad, then one every AD_INTERVAL cards after it. Deliberately generous. */
const AD_FIRST_SLOT = 3;
const AD_INTERVAL = 8;

/** An impression from the same viewer for the same campaign is only billable once inside this
 * window. Without it, scrolling up and down bills an advertiser repeatedly for one person. */
const IMPRESSION_DEDUPE_SEC = 6 * 60 * 60;

export interface EligibleCampaign {
  id: string;
  videoId: bigint;
  cpmCents: number;
  advertiserId: string | null;
  targetTags: string[];
}

/**
 * Campaigns that may deliver right now.
 *
 * Date and budget are evaluated here rather than trusted from `status`, because a status that has
 * to be swept by a cron to stay truthful is a status that is regularly wrong — a campaign whose
 * budget ran out thirty seconds ago must stop immediately, not at the next sweep.
 */
export async function eligibleCampaigns(): Promise<EligibleCampaign[]> {
  const now = new Date();
  const rows = await prisma.adCampaign.findMany({
    where: {
      status: "APPROVED",
      // The check that makes payment mean something. Approval is a moderation decision and says
      // nothing about money; without this an advertiser could get a campaign approved and have it
      // serve its full budget having paid nothing. PENDING (a checkout opened and abandoned) is
      // deliberately excluded alongside UNFUNDED and REFUNDED.
      fundingStatus: "FUNDED",
      startsAt: { lte: now },
      endsAt: { gte: now },
      videoId: { not: null },
      // The video must still be publicly approved. A campaign whose creative was taken down
      // between approval and delivery must stop showing it — this is the check that makes a
      // moderation decision actually reach the ad system.
      video: { is: { status: "APPROVED" } },
    },
    select: { id: true, videoId: true, cpmCents: true, advertiserId: true, targetTags: true, spentCents: true, totalBudgetCents: true },
    take: 100,
  });

  return rows
    .filter((r) => r.spentCents < r.totalBudgetCents && r.videoId !== null)
    .map((r) => ({
      id: r.id,
      videoId: r.videoId!,
      cpmCents: r.cpmCents,
      advertiserId: r.advertiserId,
      targetTags: r.targetTags,
    }));
}

/**
 * Picks campaigns for one feed page.
 *
 * Selection is a weighted draw by bid rather than "highest bid always wins": a strict auction on an
 * instance this size means one advertiser with a slightly higher CPM takes every slot forever, and
 * every other advertiser sees zero delivery and leaves. Weighting keeps a higher bid genuinely
 * better without making it absolute.
 */
export function selectForSlots(
  campaigns: EligibleCampaign[],
  slots: number,
  viewerId: string,
  viewerTags: string[],
): EligibleCampaign[] {
  const pool = campaigns.filter((c) => {
    // Never show someone their own ad — they cannot be persuaded by it and it would bill them
    // for reaching themselves.
    if (c.advertiserId === viewerId) return false;
    if (c.targetTags.length === 0) return true;
    return c.targetTags.some((t) => viewerTags.includes(t));
  });

  const chosen: EligibleCampaign[] = [];
  const remaining = [...pool];
  for (let i = 0; i < slots && remaining.length > 0; i++) {
    const total = remaining.reduce((sum, c) => sum + Math.max(1, c.cpmCents), 0);
    let roll = Math.random() * total;
    let index = 0;
    for (; index < remaining.length; index++) {
      roll -= Math.max(1, remaining[index].cpmCents);
      if (roll <= 0) break;
    }
    // One campaign never fills two slots on the same page — the same ad twice in one scroll reads
    // as a bug even when it is the only campaign running.
    chosen.push(remaining.splice(Math.min(index, remaining.length - 1), 1)[0]);
  }
  return chosen;
}

/** Where ads go in a page of `count` organic videos. */
export function adSlotIndexes(count: number): number[] {
  const slots: number[] = [];
  for (let i = AD_FIRST_SLOT; i < count; i += AD_INTERVAL) slots.push(i);
  return slots;
}

/**
 * Records an impression and accrues its cost.
 *
 * Deduped per viewer per campaign, so scrolling back up does not bill again. The counter and the
 * daily rollup move together in one transaction: a spend figure that can disagree with the
 * impression count it was derived from is a spend figure nobody can defend in a dispute.
 */
export async function recordImpression(campaignId: string, viewerId: string): Promise<void> {
  try {
    const claimed = await redis.set(
      `ad:imp:${campaignId}:${viewerId}`,
      "1",
      "EX",
      IMPRESSION_DEDUPE_SEC,
      "NX",
    );
    if (claimed !== "OK") return;
  } catch {
    // Redis down. Skip rather than bill: over-charging an advertiser because our cache was
    // unavailable is the one error here with a victim.
    return;
  }

  const campaign = await prisma.adCampaign.findUnique({
    where: { id: campaignId },
    select: { cpmCents: true, spentCents: true, totalBudgetCents: true },
  });
  if (!campaign) return;

  // Cost of a single impression at this CPM, in whole cents. Sub-cent impressions would round to
  // zero and deliver free forever, so the accrual is kept in thousandths and only converted when
  // it crosses a cent — see `spendMillis` below.
  const millis = campaign.cpmCents; // cpm / 1000 impressions * 1000 = cpmCents per impression
  const spend = await accrueMillis(campaignId, millis);

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  await prisma.$transaction([
    prisma.adCampaign.update({
      where: { id: campaignId },
      data: { impressionCount: { increment: 1 }, spentCents: { increment: spend } },
    }),
    prisma.adCampaignDaily.upsert({
      where: { campaignId_day: { campaignId, day } },
      create: { campaignId, day, impressions: 1, spentCents: spend },
      update: { impressions: { increment: 1 }, spentCents: { increment: spend } },
    }),
  ]);

  // Stop the campaign the moment the cap is reached, rather than letting it drift over.
  if (campaign.spentCents + spend >= campaign.totalBudgetCents) {
    await prisma.adCampaign.updateMany({
      where: { id: campaignId, status: "APPROVED" },
      data: { status: "COMPLETED" },
    });
  }
}

/**
 * Accrues fractional cents and returns whole cents to bill.
 *
 * A $5 CPM is half a cent per impression. Rounding that to zero delivers free forever; rounding it
 * up to a cent overcharges by 100%. So the remainder is carried in Redis and only whole cents are
 * ever written to the ledger.
 */
async function accrueMillis(campaignId: string, millis: number): Promise<number> {
  try {
    const key = `ad:accrual:${campaignId}`;
    const total = await redis.incrby(key, millis);
    const whole = Math.floor(total / 1000);
    if (whole > 0) await redis.decrby(key, whole * 1000);
    return whole;
  } catch {
    // No accrual store: fall back to charging nothing rather than guessing. Under-billing is
    // recoverable; over-billing is a refund and an apology.
    return 0;
  }
}

export async function recordClick(campaignId: string): Promise<void> {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  // Clicks are counted for reporting only — pricing is CPM, so a click costs nothing and there is
  // no incentive to defraud it.
  await prisma.$transaction([
    prisma.adCampaign.update({ where: { id: campaignId }, data: { clickCount: { increment: 1 } } }),
    prisma.adCampaignDaily.upsert({
      where: { campaignId_day: { campaignId, day } },
      create: { campaignId, day, clicks: 1 },
      update: { clicks: { increment: 1 } },
    }),
  ]);
}
