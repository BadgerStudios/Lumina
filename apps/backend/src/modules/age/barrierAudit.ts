import { prisma } from "../../db/prisma.js";
import { recordFlag } from "../flags/service.js";
import { checkContact, type ContactCheck } from "./service.js";
import { checkContactWithApprovals } from "../parental/service.js";

/**
 * Finds contact across the age line that the barrier was supposed to prevent.
 *
 * The separation is enforced in several places — starting a DM, adding someone to a group DM,
 * sending a friend request — and each of those is a gate someone has to pass THROUGH. None of them
 * can tell you about contact that never went through a gate: a conversation that predates the rule,
 * a pair whose ages changed after they met, a path nobody thought to gate. Those are the leaks worth
 * knowing about, and by definition no gate will report them.
 *
 * So this looks from the other end. Rather than asking "should this be allowed", it asks "this
 * already happened — should it have been able to?" and records the answer where the owner will see
 * it. It never blocks anything: a detector that also enforces is a detector you stop trusting the
 * moment it costs someone a legitimate conversation, and the point here is to find out what is
 * actually leaking before deciding what to close.
 *
 * ## What counts as a leak
 *
 * Only `age-mismatch` — a genuine adult/minor pair. `unknown-self` and `unknown-other` mean one
 * side has no recorded age, which on this platform is a legacy account from before age collection
 * rather than a hidden minor. Treating those as leaks would bury the handful of real ones under
 * every pre-collection account on the platform, which is the same as having no detector.
 *
 * Parent-approved contacts are not leaks either. An approval is the barrier being used as designed.
 */

/** Where the contact was found, so a leak can be traced back to the path that allowed it. */
export type BarrierSurface = "dm_message" | "dm_conversation" | "group_dm" | "friendship";

interface AgeFacts {
  id: string;
  isMinor: boolean;
  ageRecordedAt: Date | null;
  isOfficial?: boolean;
}

/**
 * Whether this pair is contact that should not have been possible.
 *
 * Returns the reason when it is a leak, and null when it is not — including the two "unknown"
 * outcomes and any pair a parent has explicitly approved.
 */
export async function classifyContact(a: AgeFacts, b: AgeFacts): Promise<ContactCheck | null> {
  // Official accounts are exempt by design: they are first-party support identities, and a minor
  // who cannot reach support is worse off, not safer. Same carve-out the visibility filter makes.
  if (a.isOfficial || b.isOfficial) return null;

  const base = checkContact(a, b);
  if (base !== "age-mismatch") return null;

  // An approval is the barrier working, not failing.
  const withApprovals = await checkContactWithApprovals(a, b);
  return withApprovals === "ok" ? null : base;
}

/**
 * Record a leak.
 *
 * Written as an AccountFlag rather than to a log line, for two reasons: the owner console already
 * lists and resolves flags, so this needs no new surface to be actionable; and a log line in a
 * container that gets replaced on every deploy is not somewhere a safety finding should live.
 *
 * Flagged against BOTH accounts. Which of the two is "the problem" is not something this can know —
 * that is the judgement the flag exists to prompt — and a flag on only one of them makes the other
 * side invisible when someone looks at that account.
 */
export async function recordBarrierLeak(params: {
  surface: BarrierSurface;
  reason: ContactCheck;
  minorUserId: string;
  adultUserId: string;
  detail?: string;
}): Promise<void> {
  const detail = [
    `surface=${params.surface}`,
    `reason=${params.reason}`,
    `minor=${params.minorUserId}`,
    `adult=${params.adultUserId}`,
    params.detail,
  ]
    .filter(Boolean)
    .join(" ");

  for (const userId of [params.minorUserId, params.adultUserId]) {
    await recordFlag({ userId, reasonCode: "AGE_BARRIER_LEAK", detail });
  }
}

/**
 * Check a pair that has just interacted, and record it if it should not have been able to.
 *
 * Never throws and never blocks: it runs alongside contact that has already happened, and a
 * detector that can fail the thing it is watching is worse than no detector.
 */
export async function auditContact(
  surface: BarrierSurface,
  userIdA: string,
  userIdB: string,
  detail?: string,
): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: [userIdA, userIdB] } },
      select: { id: true, isMinor: true, ageRecordedAt: true, isOfficial: true },
    });
    if (users.length !== 2) return;
    const [a, b] = users;
    const reason = await classifyContact(a, b);
    if (!reason) return;

    const minor = a.isMinor ? a : b;
    const adult = a.isMinor ? b : a;
    await recordBarrierLeak({
      surface,
      reason,
      minorUserId: minor.id,
      adultUserId: adult.id,
      detail,
    });
  } catch {
    /* a detector must never be able to break the thing it is observing */
  }
}

/**
 * Sweep for leaks that are already standing, rather than waiting for one to happen.
 *
 * The per-event audit above only sees pairs that interact again. A conversation nobody has written
 * in since the rule changed, or a friendship formed before it, is exactly the kind of leak that
 * never triggers an event — and exactly the kind worth finding.
 *
 * Bounded per run: this walks pairs, and the point is a steady trickle of findings rather than one
 * enormous scan that either times out or floods the flag table on its first execution.
 */
export async function sweepBarrierLeaks(limit = 200): Promise<number> {
  let found = 0;

  // 1:1 DM conversations. Group DMs are deliberately not treated as leaks here — the product
  // already allows a group containing people you could not DM individually, and flagging every one
  // would report a design decision as a fault.
  const conversations = await prisma.dMConversation.findMany({
    where: { isGroup: false },
    select: {
      id: true,
      participants: {
        select: { user: { select: { id: true, isMinor: true, ageRecordedAt: true, isOfficial: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  for (const conversation of conversations) {
    if (conversation.participants.length !== 2) continue;
    const [a, b] = conversation.participants.map((p) => p.user);
    const reason = await classifyContact(a, b);
    if (!reason) continue;

    // Only once per pair per surface. Without this every sweep re-flags the same standing leak and
    // the queue becomes a clock rather than a list of things to deal with.
    const already = await prisma.accountFlag.findFirst({
      where: {
        reasonCode: "AGE_BARRIER_LEAK",
        resolvedAt: null,
        // Matches the prefix recordBarrierLeak writes, not a reconstructed one — the reason
        // sits between the two fields, so a longer guess would never match anything.
        detail: { startsWith: "surface=dm_conversation" },
        userId: a.isMinor ? a.id : b.id,
      },
      select: { id: true },
    });
    if (already) continue;

    await recordBarrierLeak({
      surface: "dm_conversation",
      reason,
      minorUserId: a.isMinor ? a.id : b.id,
      adultUserId: a.isMinor ? b.id : a.id,
      detail: `conversation=${conversation.id}`,
    });
    found++;
  }

  return found;
}
