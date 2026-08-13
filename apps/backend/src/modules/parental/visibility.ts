import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

/**
 * Who a given account is allowed to SEE.
 *
 * Contact separation (modules/age/service.ts) already stops a minor and an adult from messaging or
 * friending each other. This is the other half the operator asked for: a minor's profile must not
 * *exist* to adults at all — not in a member list, not in search, not in a mention picker.
 *
 * The two halves are genuinely different and both are needed. Blocking contact alone still leaves
 * a browsable directory of every minor on the platform, searchable by name, which is precisely the
 * artefact you would not want to publish.
 *
 * ## The rule
 *
 * You see your own side of the age line, plus:
 *
 *  - **official accounts**, always. They are first-party support identities rather than people, and
 *    a minor who cannot find support is worse off, not safer. They are already exempted from the
 *    contact rule for the same reason (see master/officialAccounts.ts).
 *  - **parent-approved contacts**, in both directions. A parent clearing a specific adult for their
 *    own child has to make that person findable, or the approval buys nothing.
 *
 * An account with no recorded age is treated as an adult here. Everywhere else in this system
 * "unknown" means "not permission"; the same instinct applies to visibility, since the outcome of
 * guessing wrong in the other direction is a minor surfaced to a stranger.
 */
export async function ageVisibilityFilter(viewerId: string): Promise<Prisma.UserWhereInput> {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  // A viewer we cannot classify is treated as an adult, which is the restrictive answer: it hides
  // minors from them rather than exposing minors to an unknown.
  const viewerIsMinor = Boolean(viewer?.isMinor) && viewer?.ageRecordedAt !== null;

  const approvedIds = viewerIsMinor
    ? // Adults this minor's parent has cleared.
      (
        await prisma.parentApprovedContact.findMany({
          where: { parentLink: { childUserId: viewerId, status: "ACTIVE" } },
          select: { approvedUserId: true },
        })
      ).map((r) => r.approvedUserId)
    : // Minors whose parents have cleared THIS adult. Looked up from the approval side rather than
      // by scanning minors, so the cost tracks how many children approved this person — normally
      // zero, and never the size of the minor population.
      (
        await prisma.parentApprovedContact.findMany({
          where: { approvedUserId: viewerId, parentLink: { status: "ACTIVE" } },
          select: { parentLink: { select: { childUserId: true } } },
        })
      ).map((r) => r.parentLink.childUserId);

  return {
    OR: [
      // Your own cohort.
      viewerIsMinor ? { isMinor: true } : { isMinor: false },
      // Yourself, so a filter can never hide the viewer from their own picker.
      { id: viewerId },
      { isOfficial: true },
      ...(approvedIds.length > 0 ? [{ id: { in: approvedIds } }] : []),
    ],
  };
}

/**
 * The same decision for a list already in memory.
 *
 * Used where the rows come from a query that cannot easily take the filter — a raw SQL ranking, or
 * a relation include. Takes the viewer's filter once and applies it per row, so it stays one round
 * trip regardless of list length.
 */
export async function filterVisibleUsers<T extends { id: string; isMinor: boolean; isOfficial?: boolean }>(
  viewerId: string,
  users: T[],
): Promise<T[]> {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  const viewerIsMinor = Boolean(viewer?.isMinor) && viewer?.ageRecordedAt !== null;

  const candidates = users.filter((u) => u.isMinor !== viewerIsMinor && !u.isOfficial && u.id !== viewerId);
  if (candidates.length === 0) return users;

  const approvals = await prisma.parentApprovedContact.findMany({
    where: viewerIsMinor
      ? { parentLink: { childUserId: viewerId, status: "ACTIVE" }, approvedUserId: { in: candidates.map((c) => c.id) } }
      : { approvedUserId: viewerId, parentLink: { status: "ACTIVE", childUserId: { in: candidates.map((c) => c.id) } } },
    select: { approvedUserId: true, parentLink: { select: { childUserId: true } } },
  });
  const approved = new Set(
    approvals.map((a) => (viewerIsMinor ? a.approvedUserId : a.parentLink.childUserId)),
  );

  return users.filter(
    (u) => u.id === viewerId || u.isOfficial || u.isMinor === viewerIsMinor || approved.has(u.id),
  );
}
