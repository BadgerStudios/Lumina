import { randomInt } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { checkContact, type ContactCheck } from "../age/service.js";

export type ContactDecision = ContactCheck;

/**
 * Parental pairing and supervision.
 *
 * ## The shape of the rule
 *
 * A minor account exists from the moment it registers, but does nothing at all until an adult
 * redeems its pairing code. Not "sees fewer buttons" — the guard below is consulted server-side by
 * every action that could put the account in front of another person.
 *
 * ## Why a code the child reads out, and not an email invite
 *
 * An emailed invite authenticates an address, not a person, and a child who wants to evade
 * supervision can supply an address they control in about four seconds. A short code that has to
 * be redeemed from inside a *separate, already-adult, age-verified account* is a materially harder
 * thing to fake: the person accepting has themselves passed the 18+ check. It is not proof of
 * parenthood — nothing short of ID is — and this code should not pretend otherwise. What it does
 * establish is that some verified adult has knowingly taken responsibility for this account, which
 * is the honest claim the feature can support.
 */

/** Ambiguous glyphs removed: this code gets read aloud and copied by hand. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export interface MinorState {
  isMinor: boolean;
  /** True when this account is a minor with no adult currently responsible for it. */
  locked: boolean;
  parentUserId: string | null;
  pairingCode: string | null;
}

/**
 * The single source of truth for "may this account act at all".
 *
 * Adults are never locked. A minor is locked unless a link exists in ACTIVE — PENDING and REVOKED
 * both mean nobody is currently accountable, and REVOKED specifically has to re-lock: a parent
 * withdrawing supervision that leaves the child fully active would make revocation meaningless.
 */
export async function getMinorState(userId: string): Promise<MinorState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      isMinor: true,
      ageRecordedAt: true,
      parentLinkAsChild: { select: { status: true, parentUserId: true, pairingCode: true } },
    },
  });
  if (!user) throw new NotFoundError("User not found");
  if (!user.isMinor) return { isMinor: false, locked: false, parentUserId: null, pairingCode: null };

  const link = user.parentLinkAsChild;
  const active = link?.status === "ACTIVE";
  return {
    isMinor: true,
    locked: !active,
    parentUserId: active ? (link?.parentUserId ?? null) : null,
    pairingCode: link && link.status !== "REVOKED" ? link.pairingCode : null,
  };
}

/** Throws if the account is a minor with no responsible adult. Adults pass straight through. */
export async function assertNotLockedMinor(userId: string): Promise<void> {
  const state = await getMinorState(userId);
  if (state.locked) {
    throw new ForbiddenError(
      "This account needs a parent or guardian to accept it before it can be used. Share your pairing code with them from Settings.",
    );
  }
}

/**
 * Mint (or return) the child's pairing code.
 *
 * Idempotent while PENDING so refreshing the settings page does not invalidate a code the child
 * has already read out to someone in another room.
 */
export async function ensurePairingCode(childUserId: string): Promise<{ pairingCode: string; status: string }> {
  const user = await prisma.user.findUnique({
    where: { id: childUserId },
    select: { isMinor: true, parentLinkAsChild: true },
  });
  if (!user) throw new NotFoundError("User not found");
  if (!user.isMinor) throw new BadRequestError("Only a minor account needs a parent link");

  const existing = user.parentLinkAsChild;
  if (existing && existing.status !== "REVOKED") {
    return { pairingCode: existing.pairingCode, status: existing.status };
  }

  // A revoked link is replaced rather than reopened: reusing the old code would let a parent who
  // was removed re-attach with a code they still had written down.
  if (existing) await prisma.parentLink.delete({ where: { id: existing.id } });

  for (let attempt = 0; attempt < 5; attempt++) {
    const pairingCode = generateCode();
    try {
      const link = await prisma.parentLink.create({ data: { childUserId, pairingCode } });
      return { pairingCode: link.pairingCode, status: link.status };
    } catch {
      // Unique collision on the code — vanishingly unlikely at 31^8, retried rather than assumed
      // impossible because the failure mode is a 500 on a child's first-run screen.
    }
  }
  throw new ConflictError("Could not allocate a pairing code, please try again");
}

/**
 * An adult redeems a child's code and becomes responsible for the account.
 *
 * The adult checks are the important part: a minor cannot supervise a minor, and an account with
 * no recorded age cannot supervise anyone, because "unknown" has never been permission anywhere
 * else in this system either.
 */
export async function redeemPairingCode(parentUserId: string, code: string) {
  const parent = await prisma.user.findUnique({
    where: { id: parentUserId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  if (!parent) throw new NotFoundError("User not found");
  if (parent.ageRecordedAt === null) throw new ForbiddenError("Confirm your own age before accepting a child account");
  if (parent.isMinor) throw new ForbiddenError("A minor account cannot supervise another account");

  const link = await prisma.parentLink.findUnique({
    where: { pairingCode: code.trim().toUpperCase() },
    select: { id: true, status: true, childUserId: true },
  });
  if (!link) throw new NotFoundError("That pairing code is not valid");
  if (link.status === "ACTIVE") throw new ConflictError("That account already has a parent linked");
  if (link.status === "REVOKED") throw new BadRequestError("That pairing code is no longer valid");
  if (link.childUserId === parentUserId) throw new BadRequestError("An account cannot supervise itself");

  // Conditional update rather than read-then-write: two adults redeeming the same code at once must
  // not both come away believing they are the responsible party.
  const claimed = await prisma.parentLink.updateMany({
    where: { id: link.id, status: "PENDING" },
    data: { parentUserId, status: "ACTIVE", acceptedAt: new Date() },
  });
  if (claimed.count === 0) throw new ConflictError("That account already has a parent linked");

  return prisma.parentLink.findUniqueOrThrow({
    where: { id: link.id },
    include: { child: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
}

/** Either party may end supervision. The child re-locks immediately — see getMinorState. */
export async function revokeLink(actorUserId: string, linkId: string) {
  const link = await prisma.parentLink.findUnique({ where: { id: linkId } });
  if (!link) throw new NotFoundError("Link not found");
  if (link.parentUserId !== actorUserId && link.childUserId !== actorUserId) {
    throw new ForbiddenError("Not your link");
  }
  await prisma.parentLink.update({
    where: { id: linkId },
    data: { status: "REVOKED", revokedAt: new Date(), parentUserId: null },
  });
}

export async function listChildren(parentUserId: string) {
  const links = await prisma.parentLink.findMany({
    where: { parentUserId, status: "ACTIVE" },
    include: {
      child: { select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true } },
      approvedContacts: {
        include: { approvedUser: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
      },
    },
    orderBy: { acceptedAt: "asc" },
  });
  return links.map((l) => ({
    linkId: l.id,
    acceptedAt: l.acceptedAt?.toISOString() ?? null,
    child: l.child,
    approvedContacts: l.approvedContacts.map((a) => ({
      id: a.id,
      note: a.note,
      user: a.approvedUser,
    })),
  }));
}

/** Resolves the ACTIVE link for a (parent, child) pair, or throws. Every supervision route starts
 * here so none of them can accidentally read a child the caller is not responsible for. */
export async function requireActiveLink(parentUserId: string, childUserId: string) {
  const link = await prisma.parentLink.findFirst({
    where: { parentUserId, childUserId, status: "ACTIVE" },
  });
  if (!link) throw new NotFoundError("No linked child account");
  return link;
}

export async function approveContact(parentUserId: string, childUserId: string, username: string, note?: string) {
  const link = await requireActiveLink(parentUserId, childUserId);
  const target = await prisma.user.findFirst({
    where: { username: { equals: username.trim(), mode: "insensitive" } },
    select: { id: true, username: true, displayName: true, avatarUrl: true, isMinor: true },
  });
  if (!target) throw new NotFoundError("No user with that username");
  if (target.id === childUserId) throw new BadRequestError("That is the child's own account");

  await prisma.parentApprovedContact.upsert({
    where: { parentLinkId_approvedUserId: { parentLinkId: link.id, approvedUserId: target.id } },
    create: { parentLinkId: link.id, approvedUserId: target.id, note: note?.slice(0, 200) ?? null },
    update: { note: note?.slice(0, 200) ?? null },
  });
  return target;
}

export async function revokeApprovedContact(parentUserId: string, childUserId: string, approvedUserId: string) {
  const link = await requireActiveLink(parentUserId, childUserId);
  await prisma.parentApprovedContact.deleteMany({ where: { parentLinkId: link.id, approvedUserId } });
}

/**
 * Is `adultUserId` on `childUserId`'s parent-approved list?
 *
 * Scoped through the child's OWN link, so an approval granted by one parent can only ever apply to
 * that parent's child. This is the function that makes "bypass the barrier for only that specific
 * user and no others" true rather than aspirational.
 */
export async function isApprovedContact(childUserId: string, adultUserId: string): Promise<boolean> {
  const found = await prisma.parentApprovedContact.findFirst({
    where: {
      approvedUserId: adultUserId,
      parentLink: { childUserId, status: "ACTIVE" },
    },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Contact check with parent approvals layered on top of the age rule.
 *
 * The pure `checkContact` in modules/age/service.ts stays exactly as it is — it answers the age
 * question and nothing else, and its 3×3 matrix is unit-tested on that basis. This wraps it, and
 * only ever RELAXES an `age-mismatch`, never a missing age: an approval is a parent's decision
 * about one specific adult, not a substitute for knowing how old either party is.
 *
 * The approval is looked up against the MINOR's link regardless of which side called, so the
 * answer is the same in both directions. A rule that held one way round would just mean the
 * outcome depended on who clicked first.
 */
export async function checkContactWithApprovals(
  a: { id: string; isMinor: boolean; ageRecordedAt: Date | null },
  b: { id: string; isMinor: boolean; ageRecordedAt: Date | null },
): Promise<ContactDecision> {
  const base = checkContact(a, b);
  if (base !== "age-mismatch") return base;

  const minor = a.isMinor ? a : b;
  const adult = a.isMinor ? b : a;
  // A locked minor is not contactable by anyone, approved or not — no adult is accountable for the
  // account yet, so there is nobody whose approval could mean anything.
  const state = await getMinorState(minor.id);
  if (state.locked) return "age-mismatch";

  return (await isApprovedContact(minor.id, adult.id)) ? "ok" : "age-mismatch";
}

export async function canContactWithApprovals(
  a: { id: string; isMinor: boolean; ageRecordedAt: Date | null },
  b: { id: string; isMinor: boolean; ageRecordedAt: Date | null },
): Promise<boolean> {
  return (await checkContactWithApprovals(a, b)) === "ok";
}
