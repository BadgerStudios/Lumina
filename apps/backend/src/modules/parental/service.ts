import { randomInt } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { checkContact, ageFromBirthDate, ADULT_AGE, type ContactCheck } from "../age/service.js";

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
  // parentUserId must be non-null, not just status ACTIVE: ParentLink.parent is onDelete: SetNull,
  // so a supervising parent deleting their account nulls parentUserId while leaving status ACTIVE.
  // Reading active off status alone would leave the minor fully unlocked with nobody responsible —
  // exactly the state the lock exists to prevent. (Account deletion now also REVOKEs these links so
  // the minor can re-pair; this guard is the belt-and-suspenders for any other SetNull path.)
  const active = link?.status === "ACTIVE" && link.parentUserId !== null;
  return {
    isMinor: true,
    locked: !active,
    parentUserId: active ? (link?.parentUserId ?? null) : null,
    pairingCode: link && link.status !== "REVOKED" ? link.pairingCode : null,
  };
}

/**
 * Recompute `isMinor` from `birthDate`, and on a minor→adult transition end supervision.
 *
 * `isMinor` is stored rather than derived per request (it gates hot paths), which means it goes
 * stale: a 17-year-old who turns 18 would otherwise stay flagged a minor — locked, feed-restricted,
 * parent-supervised — indefinitely, because nothing re-derived it. (The schema comment claimed it
 * was "refreshed on login"; nothing actually did.) This is that refresh: called on login and from a
 * daily worker sweep for accounts that age up without logging in.
 *
 * When an account crosses into adulthood its ParentLink is deleted — otherwise a former guardian
 * keeps read access to a now-adult's private account, since requireActiveLink authorizes on link
 * status alone and never re-checks minority. Deleting the link cascades its approved-contact rows
 * away too. Returns the effective isMinor so a caller (login) can reflect it without a re-read.
 */
export async function refreshMinorStatus(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isMinor: true, birthDate: true },
  });
  if (!user || user.birthDate === null) return user?.isMinor ?? false;
  const shouldBeMinor = ageFromBirthDate(user.birthDate) < ADULT_AGE;
  if (shouldBeMinor === user.isMinor) return shouldBeMinor;

  await prisma.user.update({ where: { id: userId }, data: { isMinor: shouldBeMinor } });
  if (!shouldBeMinor) {
    // Aged into adulthood — end any parental supervision (cascades ParentApprovedContact).
    await prisma.parentLink.deleteMany({ where: { childUserId: userId } });
  }
  return shouldBeMinor;
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

/**
 * The adult side of the reverse-direction flow: a persistent "family code" the adult keeps in
 * Family Settings, which a minor (or a parent on the minor's locked screen) enters to link the
 * minor to THIS adult. Kept ALONGSIDE the child-generated pairingCode, not replacing it — the two
 * are the same handshake from opposite ends, and different households find one or the other more
 * natural.
 *
 * Minted lazily and idempotently: the first read allocates one, every later read returns the same
 * value, so a code an adult has already handed out never silently rotates from under them.
 * Adult-and-age-verified only, for exactly the reason redeemPairingCode checks the same thing — a
 * code that is supposed to identify a responsible adult must not be mintable by a minor or an
 * unknown-age account.
 */
export async function ensureFamilyCode(adultUserId: string): Promise<{ familyCode: string }> {
  const user = await prisma.user.findUnique({
    where: { id: adultUserId },
    select: { isMinor: true, ageRecordedAt: true, familyCode: true },
  });
  if (!user) throw new NotFoundError("User not found");
  if (user.ageRecordedAt === null) throw new ForbiddenError("Confirm your own age before using a family code");
  if (user.isMinor) throw new ForbiddenError("Only an adult account has a family code");
  if (user.familyCode) return { familyCode: user.familyCode };

  for (let attempt = 0; attempt < 5; attempt++) {
    const familyCode = generateCode();
    try {
      // Guarded on familyCode still being null so two concurrent first-reads can't each mint a
      // different code and leave the client holding a stale one — the loser reads back the winner's.
      const claimed = await prisma.user.updateMany({
        where: { id: adultUserId, familyCode: null },
        data: { familyCode },
      });
      if (claimed.count === 1) return { familyCode };
      const fresh = await prisma.user.findUnique({ where: { id: adultUserId }, select: { familyCode: true } });
      if (fresh?.familyCode) return { familyCode: fresh.familyCode };
    } catch {
      // Unique collision against another user's code — vanishingly unlikely at 31^8, retried.
    }
  }
  throw new ConflictError("Could not allocate a family code, please try again");
}

/**
 * Rotate the adult's family code — for when one has leaked or been shared too widely.
 *
 * Deliberately does NOT touch existing links: a family code is not stored on the ParentLink (the
 * link records the parent, not the code that created it), so rotating only invalidates the code
 * for FUTURE redemptions and never kicks out a child already linked. That is the point — an adult
 * can retire a code that got around without severing supervision of the accounts it already made.
 */
export async function regenerateFamilyCode(adultUserId: string): Promise<{ familyCode: string }> {
  const user = await prisma.user.findUnique({
    where: { id: adultUserId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  if (!user) throw new NotFoundError("User not found");
  if (user.ageRecordedAt === null) throw new ForbiddenError("Confirm your own age before using a family code");
  if (user.isMinor) throw new ForbiddenError("Only an adult account has a family code");

  for (let attempt = 0; attempt < 5; attempt++) {
    const familyCode = generateCode();
    try {
      const updated = await prisma.user.update({ where: { id: adultUserId }, data: { familyCode } });
      return { familyCode: updated.familyCode! };
    } catch {
      // Unique collision — retried.
    }
  }
  throw new ConflictError("Could not allocate a family code, please try again");
}

/**
 * The minor side of the reverse-direction flow: the locked minor submits an adult's family code
 * and, if it belongs to a real age-verified adult, becomes linked to them — the same end state as
 * an adult redeeming the child's pairingCode, reached from the other direction.
 */
export async function redeemFamilyCode(childUserId: string, code: string) {
  const child = await prisma.user.findUnique({
    where: { id: childUserId },
    select: { isMinor: true, parentLinkAsChild: { select: { id: true, status: true } } },
  });
  if (!child) throw new NotFoundError("User not found");
  if (!child.isMinor) throw new BadRequestError("Only a minor account needs a parent link");

  const adult = await prisma.user.findUnique({
    where: { familyCode: code.trim().toUpperCase() },
    select: { id: true, isMinor: true, ageRecordedAt: true, username: true, displayName: true, avatarUrl: true },
  });
  // Same non-committal message whether the code is unknown or belongs to an ineligible account, so
  // this can't be used to probe which codes exist or which accounts are adults.
  if (!adult || adult.ageRecordedAt === null || adult.isMinor) {
    throw new NotFoundError("That family code is not valid");
  }
  if (adult.id === childUserId) throw new BadRequestError("An account cannot supervise itself");

  const existing = child.parentLinkAsChild;
  if (existing?.status === "ACTIVE") throw new ConflictError("This account already has a parent linked");

  if (existing) {
    // Conditional so a concurrent redemption (family code and child pairing code race each other)
    // can't leave two adults both believing they are responsible.
    const claimed = await prisma.parentLink.updateMany({
      where: { id: existing.id, status: { in: ["PENDING", "REVOKED"] } },
      data: { parentUserId: adult.id, status: "ACTIVE", acceptedAt: new Date(), revokedAt: null },
    });
    if (claimed.count === 0) throw new ConflictError("This account already has a parent linked");
    // Reactivating a REVOKED link keeps the SAME row, so any ParentApprovedContact rows the PREVIOUS
    // guardian added would silently carry over to this new guardian — adults approved by A would keep
    // bypassing the age barrier under B, who never approved them. Purge them so the new guardian
    // starts from a clean allowlist. (The child-generated-code path deletes+recreates the link, so
    // its approvals cascade away; this in-place reactivation is the one that needs an explicit purge.)
    await prisma.parentApprovedContact.deleteMany({ where: { parentLinkId: existing.id } });
  } else {
    // No link row yet (one is only created when the child views their own pairing code). Create it
    // straight into ACTIVE. pairingCode is a required, unique column even though this direction
    // doesn't use it, so a fresh value is generated purely to satisfy the row.
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const pairingCode = generateCode();
      try {
        await prisma.parentLink.create({
          data: { childUserId, pairingCode, parentUserId: adult.id, status: "ACTIVE", acceptedAt: new Date() },
        });
        created = true;
      } catch (err) {
        // childUserId is @unique: if a link appeared concurrently, stop and report the conflict
        // rather than burning all retries on a pairingCode regeneration that can never win.
        if ((err as { code?: string }).code === "P2002" && String((err as { meta?: { target?: string[] } }).meta?.target ?? "").includes("childUserId")) {
          throw new ConflictError("This account already has a parent linked");
        }
        // Otherwise a pairingCode collision — retried.
      }
    }
    if (!created) throw new ConflictError("Could not link this account, please try again");
  }

  return { parent: { id: adult.id, username: adult.username, displayName: adult.displayName, avatarUrl: adult.avatarUrl } };
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
