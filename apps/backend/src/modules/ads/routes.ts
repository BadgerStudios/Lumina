import type { FastifyInstance } from "fastify";
import { assertTrustedOrigin } from "../risk/service.js";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireStaff } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { recordClick, recordImpression } from "./delivery.js";
import { getStripe } from "../billing/stripe.js";
import { primaryAppOrigin } from "../../lib/appOrigin.js";

/**
 * The advertiser console and the staff review queue. Mounted under /api/ads.
 *
 * Campaigns are reviewed by the same staff tier that reviews videos, and for the same reason: the
 * creative is a video in the public feed either way, so splitting it across two review surfaces
 * would mean two standards.
 */

/** Floor price. Not a revenue decision — it stops a campaign bidding a fraction of a cent, winning
 * slots by volume and paying essentially nothing for them. */
const MIN_CPM_CENTS = 100;
const MIN_BUDGET_CENTS = 500;
const MAX_BUDGET_CENTS = 5_000_000;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  videoId: z.string().min(1),
  cpmCents: z.number().int().min(MIN_CPM_CENTS).max(100_000),
  totalBudgetCents: z.number().int().min(MIN_BUDGET_CENTS).max(MAX_BUDGET_CENTS),
  startsAt: z.string(),
  endsAt: z.string(),
  targetTags: z.array(z.string().min(1).max(40)).max(10).optional(),
});

export default async function adRoutes(fastify: FastifyInstance) {
  /** The advertiser's own campaigns, every status. */
  fastify.get("/campaigns", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const campaigns = await prisma.adCampaign.findMany({
      where: { advertiserId: request.userId! },
      orderBy: { createdAt: "desc" },
      include: { video: { select: { id: true, caption: true, thumbnailKey: true } } },
      take: 50,
    });
    return campaigns.map(serializeCampaign);
  });

  fastify.post("/campaigns", { preHandler: [requireAuth, requireAdult] }, async (request, reply) => {
    // Ads move money, so a throwaway account behind a VPN is exactly the shape of a stolen-card
    // purchase. Checked before validation so nothing is created on the way to the refusal.
    await assertTrustedOrigin(request, request.userId!, "ad campaign creation");

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
      );
    }
    const body = parsed.data;

    let videoId: bigint;
    try {
      videoId = BigInt(body.videoId);
    } catch {
      throw new BadRequestError("That isn't a valid video");
    }

    // You may only promote your own, already-approved video. This is what makes ad creative
    // inherit the existing moderation pipeline instead of needing a second one.
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { authorId: true, status: true },
    });
    if (!video || video.authorId !== request.userId) throw new NotFoundError("Video not found");
    if (video.status !== "APPROVED") {
      throw new BadRequestError("That video isn't approved yet — only approved videos can be promoted");
    }

    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new BadRequestError("The end date has to be after the start date");
    }

    const campaign = await prisma.adCampaign.create({
      data: {
        advertiserId: request.userId!,
        videoId,
        name: body.name,
        cpmCents: body.cpmCents,
        totalBudgetCents: body.totalBudgetCents,
        startsAt,
        endsAt,
        targetTags: body.targetTags ?? [],
        // Straight into review. There is no self-approval path — the point of the queue is that a
        // human sees every ad before anyone else does.
        status: "PENDING_REVIEW",
      },
      include: { video: { select: { id: true, caption: true, thumbnailKey: true } } },
    });

    reply.code(201);
    return serializeCampaign(campaign);
  });

  /** Pause or resume your own campaign. Deliberately not a general status setter — an advertiser
   * must never be able to move their own campaign into APPROVED. */
  fastify.patch("/campaigns/:id", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const { id } = request.params as { id: string };
    const { paused } = request.body as { paused?: boolean };
    if (typeof paused !== "boolean") throw new BadRequestError("paused must be true or false");

    const campaign = await prisma.adCampaign.findUnique({ where: { id } });
    if (!campaign || campaign.advertiserId !== request.userId) throw new NotFoundError("Campaign not found");
    if (!["APPROVED", "PAUSED"].includes(campaign.status)) {
      throw new BadRequestError("Only a running campaign can be paused");
    }

    const updated = await prisma.adCampaign.update({
      where: { id },
      data: { status: paused ? "PAUSED" : "APPROVED" },
      include: { video: { select: { id: true, caption: true, thumbnailKey: true } } },
    });
    return serializeCampaign(updated);
  });

  /**
   * Pay for an approved campaign.
   *
   * Campaigns are prepaid, and the charge happens AFTER staff approval rather than on submission.
   * Billing first would mean taking money for creative that might then be rejected, turning every
   * rejection into a refund; this way the platform never holds money for an ad it won't run.
   *
   * The amount comes from the campaign row, never from the request — a client-supplied price is a
   * client-chosen price. Funding is confirmed by the Stripe webhook and nowhere else; the success
   * URL grants nothing, because anyone can visit a success URL.
   */
  fastify.post("/campaigns/:id/checkout", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const stripe = getStripe();
    if (!stripe) throw new BadRequestError("Payments aren't configured on this server");

    const { id } = request.params as { id: string };
    const campaign = await prisma.adCampaign.findUnique({ where: { id } });
    if (!campaign || campaign.advertiserId !== request.userId) {
      throw new NotFoundError("Campaign not found");
    }
    if (campaign.fundingStatus === "FUNDED") throw new BadRequestError("This campaign is already paid for");
    if (campaign.fundingStatus === "REFUNDED") throw new BadRequestError("This campaign was refunded");
    if (campaign.status !== "APPROVED") {
      throw new BadRequestError(
        campaign.status === "PENDING_REVIEW"
          ? "This campaign is still in review — you'll be able to pay once it's approved."
          : "Only an approved campaign can be paid for",
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { email: true },
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user?.email,
      // A price built from the campaign's own budget rather than a preconfigured Stripe Price:
      // every campaign is a different amount, so there is nothing to configure ahead of time.
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: campaign.totalBudgetCents,
            product_data: {
              name: `Lumina ad campaign — ${campaign.name}`,
              description: `${(campaign.cpmCents / 100).toFixed(2)} USD per 1,000 impressions, up to ${(campaign.totalBudgetCents / 100).toFixed(2)} USD`,
            },
          },
        },
      ],
      success_url: `${primaryAppOrigin()}/settings/advertising?checkout=success`,
      cancel_url: `${primaryAppOrigin()}/settings/advertising?checkout=cancelled`,
      // The only trustworthy channel back. `kind` is what lets one webhook handler tell an ad
      // payment apart from a sparks top-up without guessing from the amount.
      metadata: { kind: "ad_campaign", campaignId: campaign.id, advertiserId: request.userId! },
    });

    // PENDING, not FUNDED — an abandoned checkout must never deliver. Only the webhook sets FUNDED.
    await prisma.adCampaign.update({
      where: { id: campaign.id },
      data: { fundingStatus: "PENDING" },
    });

    return { url: session.url };
  });

  /** Impression and click beacons. Authenticated so impressions can be deduped per viewer — an
   * anonymous beacon is one an advertiser cannot be charged for honestly. */
  fastify.post("/campaigns/:id/impression", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const { id } = request.params as { id: string };
    await recordImpression(id, request.userId!);
    return { ok: true };
  });

  fastify.post("/campaigns/:id/click", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const { id } = request.params as { id: string };
    await recordClick(id);
    return { ok: true };
  });

  // ---- staff review ---------------------------------------------------------------------------

  fastify.get("/review", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { status } = request.query as { status?: string };
    const campaigns = await prisma.adCampaign.findMany({
      where: { status: (status as never) ?? "PENDING_REVIEW" },
      orderBy: { createdAt: "asc" },
      include: {
        video: { select: { id: true, caption: true, thumbnailKey: true } },
        advertiser: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      take: 50,
    });
    return campaigns.map((c) => ({ ...serializeCampaign(c), advertiser: c.advertiser }));
  });

  fastify.post("/review/:id", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const { approve, reason } = request.body as { approve?: boolean; reason?: string };
    if (typeof approve !== "boolean") throw new BadRequestError("approve must be true or false");
    if (!approve && !reason?.trim()) throw new BadRequestError("A rejection needs a reason");

    const campaign = await prisma.adCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundError("Campaign not found");

    // Previously neither branch checked the campaign's current status at all — staff could
    // "approve" something already REJECTED, or, worse, reject an already-APPROVED and FUNDED
    // campaign that was actively delivering, with nothing about the transition itself refused.
    // Approving only ever makes sense straight out of the queue. Rejecting is also the only way
    // staff have to pull a campaign that already went live (PAUSED included — pausing is
    // advertiser-initiated and doesn't change the moderation status underneath it), so that stays
    // allowed; what's guarded is APPROVING something that isn't awaiting review.
    if (approve && campaign.status !== "PENDING_REVIEW") {
      throw new BadRequestError(`Cannot approve a campaign that is ${campaign.status}`);
    }
    if (!approve && !["PENDING_REVIEW", "APPROVED", "PAUSED"].includes(campaign.status)) {
      throw new BadRequestError(`Cannot reject a campaign that is ${campaign.status}`);
    }

    // Whether this rejection is pulling money that was already collected and not yet delivered —
    // computed before the update below overwrites `status`.
    const wasFundedAndUnspent =
      !approve && campaign.fundingStatus === "FUNDED" && campaign.paidCents > campaign.spentCents;

    const updated = await prisma.adCampaign.update({
      where: { id },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        reviewedById: request.userId!,
        reviewedAt: new Date(),
        rejectionReason: approve ? null : reason!.slice(0, 300),
      },
      include: { video: { select: { id: true, caption: true, thumbnailKey: true } } },
    });

    // Same append-only trail as video moderation and infrastructure actions — "who let this ad
    // run" has to be answerable.
    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: approve ? "ad.approve" : "ad.reject",
        targetType: "ad_campaign",
        targetId: id,
        reason: reason?.slice(0, 300) ?? null,
      },
    });

    // Rejecting stops delivery immediately — eligibleCampaigns() only ever draws from
    // status: "APPROVED" — but it does not touch Stripe. Issuing a refund is a real-money action
    // this route has no business deciding on its own (full refund vs. the unspent remainder vs.
    // none is a policy call, not a bug fix). What it must not do is let that money go untracked:
    // this is the reconciliation trail — a second, distinctly-typed audit row recording exactly
    // what's owed back — so a paid-and-pulled campaign is a searchable fact instead of silently
    // indistinguishable from an unfunded rejection, which is what let this go unnoticed before.
    if (wasFundedAndUnspent) {
      const unrefundedCents = campaign.paidCents - campaign.spentCents;
      await prisma.staffAuditLog.create({
        data: {
          actorId: request.userId!,
          actionType: "ad.reject_funded_unrefunded",
          targetType: "ad_campaign",
          targetId: id,
          reason: `$${(unrefundedCents / 100).toFixed(2)} paid and undelivered — needs a manual Stripe refund`,
        },
      });
    }

    return serializeCampaign(updated);
  });

  /** Revenue reporting for the owner console. Reads the same rollups delivery writes, so the
   * number shown is the number that was actually accrued rather than a second estimate. */
  fastify.get("/revenue", { preHandler: [requireAuth, requireStaff] }, async () => {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    since.setUTCHours(0, 0, 0, 0);

    const [daily, totals, funded, pending] = await Promise.all([
      prisma.adCampaignDaily.groupBy({
        by: ["day"],
        where: { day: { gte: since } },
        _sum: { impressions: true, clicks: true, spentCents: true },
        orderBy: { day: "asc" },
      }),
      prisma.adCampaign.aggregate({ _sum: { spentCents: true, impressionCount: true, clickCount: true } }),
      // Money actually taken. Summed from paidCents — what Stripe reported collecting — rather than
      // from the campaigns' requested budgets, which are an intention, not a payment.
      prisma.adCampaign.aggregate({
        where: { fundingStatus: "FUNDED" },
        _sum: { paidCents: true, spentCents: true },
        _count: true,
      }),
      prisma.adCampaign.count({ where: { status: "APPROVED", fundingStatus: { in: ["UNFUNDED", "PENDING"] } } }),
    ]);

    const collectedCents = funded._sum.paidCents ?? 0;
    const deliveredAgainstPaid = funded._sum.spentCents ?? 0;

    return {
      // Named `accrued`, not `revenue`: this is delivery that has been earned, not money that has
      // been collected. Calling it revenue before Stripe charges anything would be a lie on a
      // dashboard, which is the worst place for one.
      accruedCents: totals._sum.spentCents ?? 0,
      impressions: totals._sum.impressionCount ?? 0,
      clicks: totals._sum.clickCount ?? 0,
      // Campaigns are prepaid, so collected is money in the bank and accrued is how much of it has
      // been earned by delivery. The difference is a liability — inventory still owed to
      // advertisers — which is why it is reported rather than left to be inferred.
      collected: true,
      collectedCents,
      unearnedCents: Math.max(0, collectedCents - deliveredAgainstPaid),
      fundedCampaigns: funded._count,
      // Approved but not paid for: real demand that has not converted, and the number to watch if
      // checkout is broken.
      awaitingPaymentCampaigns: pending,
      days: daily.map((d) => ({
        day: d.day.toISOString().slice(0, 10),
        impressions: d._sum.impressions ?? 0,
        clicks: d._sum.clicks ?? 0,
        accruedCents: d._sum.spentCents ?? 0,
      })),
    };
  });
}

function serializeCampaign(c: {
  id: string;
  name: string;
  status: string;
  cpmCents: number;
  totalBudgetCents: number;
  spentCents: number;
  fundingStatus: string;
  paidCents: number;
  paidAt: Date | null;
  startsAt: Date;
  endsAt: Date;
  targetTags: string[];
  impressionCount: number;
  clickCount: number;
  rejectionReason: string | null;
  createdAt: Date;
  video?: { id: bigint; caption: string | null; thumbnailKey: string | null } | null;
}) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    cpmCents: c.cpmCents,
    totalBudgetCents: c.totalBudgetCents,
    spentCents: c.spentCents,
    // Surfaced so the advertiser console can tell "waiting on review" apart from "waiting on you to
    // pay" — two very different things to be told, and previously indistinguishable.
    fundingStatus: c.fundingStatus,
    paidCents: c.paidCents,
    paidAt: c.paidAt?.toISOString() ?? null,
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    targetTags: c.targetTags,
    impressionCount: c.impressionCount,
    clickCount: c.clickCount,
    rejectionReason: c.rejectionReason,
    createdAt: c.createdAt.toISOString(),
    video: c.video
      ? {
          id: c.video.id.toString(),
          caption: c.video.caption,
          thumbnailUrl: c.video.thumbnailKey ? `/api/videos/${c.video.id}/thumbnail` : null,
        }
      : null,
  };
}
