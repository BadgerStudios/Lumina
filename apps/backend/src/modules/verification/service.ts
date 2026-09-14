import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { ADULT_AGE, ageFromBirthDate } from "../age/service.js";
import { createInquiry, isPersonaConfigured } from "./persona.js";
import {
  createSession as createDiditSession,
  fetchDecision as fetchDiditDecision,
  isDiditAgeConfigured,
  isDiditConfigured,
  readOutcome as readDiditOutcome,
  fetchDiditSelfie,
} from "./didit.js";
import { verifyDeviceAttestation, type AttestationPlatform } from "./attestation.js";
import { banUser } from "../bans/service.js";
import { recordFlag } from "../flags/service.js";

/**
 * Age-assurance service — the one place that records signals and reconciles them into the account's
 * stored age state. The invariants it protects:
 *
 *  - A device band (Apple/Google) may LOCK a suspected minor (band says <18 → treat as minor) but may
 *    NEVER promote a self-declared minor to adult on its own — a minor could be on a parent's device.
 *    Becoming an adult requires DOCUMENT_VERIFIED (Persona or an admin selfie review).
 *  - Assurance level only ever ratchets UP (SELF < DEVICE < DOCUMENT); a weaker later signal never
 *    downgrades a stronger proof.
 *  - Every signal is logged to AgeVerification; User carries only the current best, like isMinor.
 */

const SELFIE_DIR = "age-review";

// ---- band parsing -------------------------------------------------------------------------------

/** Map a provider band string to what it implies about the 18 boundary: true=minor, false=adult,
 * null=can't tell. Accepts the shapes Apple/Google emit ("18+", "16-17", "13-15", "0-12", "UNDER_18"). */
export function bandToMinorSignal(band: string | null | undefined): boolean | null {
  if (!band) return null;
  const b = band.trim().toLowerCase();
  if (!b) return null; // whitespace-only — otherwise Number("") === 0 would falsely read as a minor
  if (b === "18+" || b === "over_18" || b === "18_plus" || b === "adult") return false;
  if (["16-17", "13-15", "0-12", "under_13", "under_16", "under_18", "13_15", "16_17"].includes(b)) return true;
  // "N-M" range. Definitely minor iff the WHOLE range is below 18; definitely adult iff the whole
  // range is 18+. A range that SPANS the boundary (e.g. "16-20", which includes 16/17-year-olds) is
  // genuinely ambiguous → null, so the signal is ignored rather than resolved the unsafe way (the old
  // upper-bound-only check called "16-20" adult, which could strengthen a real minor to adult).
  const m = b.match(/^(\d+)\s*[-_]\s*(\d+)$/);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (hi < ADULT_AGE) return true;
    if (lo >= ADULT_AGE) return false;
    return null;
  }
  const n = Number(b);
  if (Number.isFinite(n)) return n < ADULT_AGE;
  return null;
}

// ---- device signal ------------------------------------------------------------------------------

export type DeviceSignalOutcome =
  | { accepted: false; reason: "attestation-failed" | "unknown-band" }
  | { accepted: true; level: "DEVICE_DECLARED"; isMinor: boolean; locked: boolean };

/**
 * Record a native device age band, gated on attestation. Reconciles per the invariants above.
 */
export async function recordDeviceSignal(
  userId: string,
  platform: AttestationPlatform,
  band: string,
  attestationToken: string | undefined,
): Promise<DeviceSignalOutcome> {
  const attestOk = await verifyDeviceAttestation(platform, attestationToken);
  if (!attestOk) return { accepted: false, reason: "attestation-failed" };

  const minorSignal = bandToMinorSignal(band);
  const source = platform === "android" ? "google_play_age_signals" : "apple_declared_age_range";

  await prisma.ageVerification.create({
    data: { userId, level: "DEVICE_DECLARED", source, band, isMinorSignal: minorSignal, rawStatus: "attested" },
  });

  if (minorSignal === null) return { accepted: false, reason: "unknown-band" };

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { isMinor: true, ageAssuranceLevel: true, identityVerifiedAt: true },
  });

  // A band that says "minor" locks the account (safe direction), regardless of prior self-declaration,
  // UNLESS the account already cleared a document identity step proving adulthood.
  let nextIsMinor = user.isMinor;
  if (minorSignal === true && user.identityVerifiedAt === null) {
    nextIsMinor = true;
  }
  // A band that says "adult" does NOT flip a minor to adult — only strengthens assurance for an
  // account already (self-)declared adult.
  const strengthenOnly = minorSignal === false && user.isMinor === false;
  const shouldUpgradeLevel = user.ageAssuranceLevel === "SELF_DECLARED"; // never downgrade DOCUMENT

  await prisma.user.update({
    where: { id: userId },
    data: {
      isMinor: nextIsMinor,
      ageAssuredBand: band,
      ageAssuredAt: new Date(),
      ageAssuranceSource: source,
      ...(shouldUpgradeLevel && (strengthenOnly || minorSignal === true)
        ? { ageAssuranceLevel: "DEVICE_DECLARED" as const }
        : {}),
    },
  });

  return { accepted: true, level: "DEVICE_DECLARED", isMinor: nextIsMinor, locked: nextIsMinor };
}

// ---- Persona budget -----------------------------------------------------------------------------

function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Atomically claim one unit of this month's Persona budget. Returns false when the cap is reached. */
export async function tryConsumePersonaBudget(): Promise<boolean> {
  const periodYm = currentPeriod();
  const limit = env.PERSONA_MONTHLY_LIMIT;
  // Ensure the row exists, then conditionally increment only while under the cap — the WHERE guard
  // makes the check-and-increment atomic against concurrent starts (no over-spend under a burst).
  await prisma.personaBudget.upsert({
    where: { periodYm },
    create: { periodYm, used: 0 },
    update: {},
  });
  const claimed = await prisma.personaBudget.updateMany({
    where: { periodYm, used: { lt: limit } },
    data: { used: { increment: 1 } },
  });
  return claimed.count === 1;
}

// ---- start verification -------------------------------------------------------------------------

export type StartOutcome =
  | { mode: "didit"; sessionId: string; link: string }
  | { mode: "persona"; inquiryId: string; link: string | null }
  | { mode: "manual_review" };

/**
 * Begin the document/identity step for a user. Uses Persona while the monthly budget lasts; once the
 * cap is hit (or Persona is unconfigured) it falls back to the admin selfie-review path. If a Persona
 * inquiry can't actually be created, the budget unit is refunded and we fall back rather than block.
 */
/**
 * How far above 18 an estimate has to sit before it is allowed to settle the question on its own.
 *
 * Facial age estimation is a model producing a point estimate, and published error for these sits
 * around three to five years either way. Clearing someone the moment it reads "18" would be
 * treating a number with that much give in it as a fact. The margin means a pass is a pass because
 * the model was not close to the line, and anyone nearer it goes to a person instead.
 */
const AGE_ESTIMATE_ADULT_MARGIN = 5;

/**
 * Start an age check: a selfie the provider estimates an age from, not an identity document.
 *
 * Separate from startVerification, which proves WHO someone is and asks for a government document
 * to do it. When the only open question is whether an account holder is over 18, asking for a
 * passport is a bigger intrusion than the question warrants — and one many people will simply
 * refuse, which turns "verify to continue" into "leave".
 *
 * Falls back to the document workflow when no age workflow is configured, so the route works before
 * anyone has set DIDIT_AGE_WORKFLOW_ID — just more heavily than it should.
 */
export async function startAgeCheck(userId: string): Promise<StartOutcome> {
  // The switch is read here rather than at the route, so every future caller inherits it: an age
  // check that can be started from somewhere that forgot to check a flag is not switched off.
  if (!env.AGE_CHECK_ENABLED) return { mode: "manual_review" };
  if (!isDiditConfigured()) return { mode: "manual_review" };
  try {
    const session = await createDiditSession(userId, undefined, env.DIDIT_AGE_WORKFLOW_ID);
    if (session) {
      await prisma.ageVerification.create({
        data: {
          userId,
          // Not DOCUMENT_VERIFIED: nothing here proves identity, and recording it as though it did
          // would overstate what the account has actually cleared.
          level: "SELF_DECLARED",
          source: isDiditAgeConfigured() ? "didit_age_estimation" : "didit",
          inquiryId: session.sessionId,
          rawStatus: session.rawStatus,
        },
      });
      return { mode: "didit", sessionId: session.sessionId, link: session.url };
    }
  } catch {
    /* nothing to fall back to for an age check — the caller reports it as unavailable */
  }
  return { mode: "manual_review" };
}

/**
 * Apply an age-estimation result.
 *
 * Deliberately asymmetric, because the two directions carry very different costs when wrong.
 *
 * Comfortably over 18 → recorded as assurance, and any open age suspicion on the account is
 * resolved, which is the entire point of offering the check to someone under suspicion.
 *
 * Anywhere near or below 18 → flagged for a person to look at. Never an automatic block: acting on
 * a model's point estimate would mean throwing people off the platform because of how old they
 * look, with no way to argue. The flag says what the estimate was and leaves the decision with the
 * owner.
 */
export async function applyAgeEstimate(userId: string, estimatedAge: number | null): Promise<void> {
  if (estimatedAge === null) return;
  const clearlyAdult = estimatedAge >= 18 + AGE_ESTIMATE_ADULT_MARGIN;

  await prisma.ageVerification.create({
    data: {
      userId,
      level: "SELF_DECLARED",
      source: "didit_age_estimation",
      band: clearlyAdult ? "18+" : `~${Math.round(estimatedAge)}`,
      isMinorSignal: clearlyAdult ? false : null,
      rawStatus: `estimated_age=${Math.round(estimatedAge)}`,
    },
  });

  if (clearlyAdult) {
    await prisma.user.update({
      where: { id: userId },
      data: { ageAssuredBand: "18+", ageAssuredAt: new Date(), ageAssuranceSource: "didit_age_estimation" },
    });
    // The check was offered to settle a doubt; passing it settles it.
    await prisma.accountFlag.updateMany({
      where: { userId, reasonCode: { in: ["AGE_MISMATCH", "AGE_SUSPECTED_MINOR"] }, resolvedAt: null },
      data: { active: false, resolvedAt: new Date() },
    });
    return;
  }

  await recordFlag({
    userId,
    reasonCode: "AGE_SUSPECTED_MINOR",
    detail: `age estimation returned ~${Math.round(estimatedAge)}; below the ${18 + AGE_ESTIMATE_ADULT_MARGIN} threshold for an automatic pass`,
  });
}

/**
 * Poll the provider for an age check this account started, and apply whatever came back.
 *
 * Separate from pollDiditForUser because the two look at different sessions and mean different
 * things: that one reads an identity decision, this one reads an age estimate. Sharing a poller
 * would mean an age session could be mistaken for proof of identity.
 */
export async function pollAgeCheckForUser(
  userId: string,
): Promise<{ status: string; estimatedAge: number | null } | null> {
  if (!env.AGE_CHECK_ENABLED) return null;
  if (!isDiditConfigured()) return null;
  const latest = await prisma.ageVerification.findFirst({
    where: { userId, source: "didit_age_estimation", inquiryId: { not: null } },
    select: { inquiryId: true },
    orderBy: { createdAt: "desc" },
  });
  if (!latest?.inquiryId) return null;

  const decision = await fetchDiditDecision(latest.inquiryId);
  if (!decision) return null;

  const outcome = readDiditOutcome(decision);
  // Only once it has settled. Applying a mid-flight estimate would act on a number the provider has
  // not finished producing.
  if (!outcome.pending) await applyAgeEstimate(userId, outcome.estimatedAge);
  return { status: outcome.rawStatus, estimatedAge: outcome.estimatedAge };
}

export async function startVerification(userId: string): Promise<StartOutcome> {
  // Didit is tried FIRST when configured. Its workflow clears someone automatically, while Persona's
  // fallback is an admin selfie queue that a human has to work — and on this instance that queue has
  // never had a single row while being the only route through the gate. Preferring the automated
  // provider is what keeps "verification required" from meaning "verification impossible".
  //
  // A failure here falls through to Persona and then to manual review, exactly as before.
  if (isDiditConfigured()) {
    try {
      const session = await createDiditSession(userId);
      if (session) {
        // Logged at creation with the eventual level, matching the Persona branch below: this table
        // is the append-only attempt log, and User.ageAssuranceLevel — updated only by
        // markDocumentVerified — is what any decision actually reads.
        await prisma.ageVerification.create({
          data: {
            userId,
            level: "DOCUMENT_VERIFIED",
            source: "didit",
            inquiryId: session.sessionId,
            rawStatus: session.rawStatus,
          },
        });
        return { mode: "didit", sessionId: session.sessionId, link: session.url };
      }
    } catch {
      // fall through to Persona / manual review
    }
  }

  if (isPersonaConfigured() && (await tryConsumePersonaBudget())) {
    try {
      const inquiry = await createInquiry(userId);
      if (inquiry) {
        await prisma.user.update({
          where: { id: userId },
          data: { personaInquiryId: inquiry.inquiryId, personaStatus: "created" },
        });
        await prisma.ageVerification.create({
          data: { userId, level: "DOCUMENT_VERIFIED", source: "persona", inquiryId: inquiry.inquiryId, rawStatus: "created" },
        });
        return { mode: "persona", inquiryId: inquiry.inquiryId, link: inquiry.oneTimeLink };
      }
    } catch {
      // fall through to manual review
    }
    // Refund the claimed budget unit — the inquiry didn't happen.
    await prisma.personaBudget.updateMany({
      where: { periodYm: currentPeriod(), used: { gt: 0 } },
      data: { used: { decrement: 1 } },
    });
  }
  return { mode: "manual_review" };
}

// ---- Persona webhook result ---------------------------------------------------------------------

const PERSONA_APPROVED = new Set(["completed", "approved"]);

/**
 * Apply a Persona inquiry result. Approved/completed → DOCUMENT_VERIFIED + identityVerifiedAt, and if
 * the proven birthdate is present, reconcile minor status from it (document proof outranks the
 * self-declared birthday). Declined/failed → record and leave the account gated. Idempotent: replays
 * of the same terminal status are harmless.
 */
export async function applyPersonaResult(
  inquiryId: string,
  status: string,
  provenBirthDate: Date | null,
): Promise<void> {
  // Find the user this inquiry belongs to. Primary: User.personaInquiryId. Fallback: the append-only
  // AgeVerification log, keyed on the same inquiry id — because a user who calls /persona/start twice
  // overwrites User.personaInquiryId with the newer id, which would otherwise orphan (and silently
  // drop) the FIRST inquiry's approval webhook. Persona inquiry ids are globally unique, so the log
  // lookup can only ever resolve to the one correct user.
  let userId = (await prisma.user.findUnique({ where: { personaInquiryId: inquiryId }, select: { id: true } }))?.id;
  if (!userId) {
    const logged = await prisma.ageVerification.findFirst({
      where: { inquiryId, source: "persona" },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });
    userId = logged?.userId;
  }
  if (!userId) return; // unknown inquiry (or a reference we never stored) — nothing to do

  await prisma.ageVerification.create({
    data: { userId, level: "DOCUMENT_VERIFIED", source: "persona", inquiryId, rawStatus: status },
  });

  if (!PERSONA_APPROVED.has(status.toLowerCase())) {
    await prisma.user.update({ where: { id: userId }, data: { personaStatus: status } });
    return;
  }

  const isMinorNow = provenBirthDate ? ageFromBirthDate(provenBirthDate) < ADULT_AGE : undefined;
  await markDocumentVerified(userId, "persona", provenBirthDate, isMinorNow);
  await prisma.user.update({ where: { id: userId }, data: { personaStatus: status } });
}

// ---- Didit result -------------------------------------------------------------------------------

/**
 * Apply a Didit decision. Safe to call repeatedly — it is the polling path's write step, so it has
 * to be.
 *
 * Attribution goes through the append-only AgeVerification log rather than a column on User. There
 * deliberately is no `User.diditSessionId`: the log is already indexed on inquiryId, a user may open
 * several sessions, and a single column would silently orphan every session but the newest — which
 * is the exact bug applyPersonaResult carries a fallback to work around.
 */
export async function applyDiditResult(sessionId: string, decision: unknown): Promise<void> {
  const outcome = readDiditOutcome(decision);

  const logged = await prisma.ageVerification.findFirst({
    where: { inquiryId: sessionId, source: "didit" },
    select: { userId: true },
    orderBy: { createdAt: "asc" },
  });
  const userId = logged?.userId;
  if (!userId) return; // a session we never opened

  // vendor_data is our own user id round-tripped by the provider. When it is present and disagrees
  // with the session we recorded, something is wrong with the attribution and no account moves.
  const vendorData = (decision as { vendor_data?: unknown } | null)?.vendor_data;
  if (typeof vendorData === "string" && vendorData && vendorData !== userId) return;

  // Only log a row when the status actually CHANGES. Without this the polling client writes an
  // audit row every few seconds for the whole time someone is holding up their passport, and the
  // table stops being an audit trail and becomes a log of how long they took.
  const previous = await prisma.ageVerification.findFirst({
    where: { userId, source: "didit", inquiryId: sessionId },
    select: { rawStatus: true },
    orderBy: { createdAt: "desc" },
  });
  if (previous?.rawStatus !== outcome.rawStatus) {
    await prisma.ageVerification.create({
      data: {
        userId,
        level: "DOCUMENT_VERIFIED",
        source: "didit",
        inquiryId: sessionId,
        rawStatus: outcome.rawStatus,
      },
    });
  }

  if (!outcome.approved) {
    // Didit did not clear them. Rather than leaving the account in limbo with the evidence sitting
    // in a third party's console, the captured selfie is pulled across and the case is put in front
    // of a person — which is the whole point of having a review queue.
    //
    // Deliberately NOT done for a clean approval. Copying a face onto our own disk for every check
    // that already passed would mean holding biometric data we have no decision to make about, and
    // the rest of this module is built around not doing that (see DOC_RETENTION_HOURS and the purge
    // sweep). An approval needs no human, so it leaves no picture here.
    if (!outcome.pending) await escalateToManualReview(userId, decision);
    return;
  }

  // A proven birthdate outranks the typed-in one; its absence is normal and simply leaves the
  // self-declared birthday standing, same as the Persona path.
  const isMinorNow = outcome.dateOfBirth ? ageFromBirthDate(outcome.dateOfBirth) < ADULT_AGE : undefined;
  await markDocumentVerified(userId, "didit", outcome.dateOfBirth, isMinorNow);
}

/**
 * Read the caller's most recent Didit session and apply whatever it says.
 *
 * This is the primary path, not a fallback. A webhook needs a shared secret to be verifiable, and an
 * integration that only completes once someone has copied a secret out of a dashboard is one that
 * looks finished and is not. Polling needs nothing beyond the API key.
 */
export async function pollDiditForUser(
  userId: string,
): Promise<{ status: string; approved: boolean; pending: boolean } | null> {
  if (!isDiditConfigured()) return null;
  const latest = await prisma.ageVerification.findFirst({
    where: { userId, source: "didit", inquiryId: { not: null } },
    select: { inquiryId: true },
    orderBy: { createdAt: "desc" },
  });
  if (!latest?.inquiryId) return null;

  const decision = await fetchDiditDecision(latest.inquiryId);
  if (!decision) return null;

  await applyDiditResult(latest.inquiryId, decision);
  const outcome = readDiditOutcome(decision);
  return { status: outcome.rawStatus, approved: outcome.approved, pending: outcome.pending };
}

/**
 * Put a failed automated check in front of a person, with the picture it was judging.
 *
 * Best-effort throughout: a verification outcome must never depend on whether an image download
 * worked. If the selfie cannot be found or fetched, the review is still created — visibly without a
 * picture — because "Didit declined this and here is nobody to look at it" is a worse outcome than
 * "Didit declined this and we could not retrieve the photo".
 *
 * The review carries no ID document on purpose. This path is the AI facial check, not a
 * government-ID one; idDocKey stays null and the queue renders the row without that panel.
 */
async function escalateToManualReview(userId: string, decision: unknown): Promise<void> {
  try {
    // An open review already means a person has been asked. A second failed attempt should not
    // create a second row for the same question.
    const existing = await prisma.manualAgeReview.findFirst({ where: { userId, status: "PENDING" } });
    if (existing?.selfieKey) return;

    const selfie = await fetchDiditSelfie(decision);
    let selfieKey: string | null = null;
    if (selfie) {
      const extension = selfie.contentType === "image/png" ? "png" : selfie.contentType === "image/webp" ? "webp" : "jpg";
      selfieKey = `${randomUUID()}.${extension}`;
      await fs.mkdir(path.join(env.UPLOADS_DIR, SELFIE_DIR), { recursive: true });
      await fs.writeFile(selfieDiskPath(selfieKey), selfie.buffer);
    }

    if (existing) {
      await prisma.manualAgeReview.update({ where: { id: existing.id }, data: { selfieKey } });
      return;
    }
    await prisma.manualAgeReview.create({ data: { userId, selfieKey } });
    await prisma.ageVerification.create({
      data: { userId, level: "DOCUMENT_VERIFIED", source: "didit_manual_review", rawStatus: "pending" },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[verification] could not escalate to manual review:", (error as Error)?.message);
  }
}

// ---- manual (admin selfie) review ---------------------------------------------------------------

/**
 * How long the images survive a decision. The account holder is told "deleted within 24 hours of
 * approval" at upload time, so this constant IS that promise -- shortening it is always safe,
 * lengthening it makes the product lie. The sweep in purgeExpiredReviewDocuments() enforces it.
 */
export const DOC_RETENTION_HOURS = 24;

/** Create a pending review. One open review per user — a re-submit replaces the open one, and the
 * superseded images are purged immediately rather than waiting for a decision that will now never
 * come for them. */
export async function createManualReview(
  userId: string,
  selfieKey: string,
  idDocKey: string,
): Promise<string> {
  const existing = await prisma.manualAgeReview.findFirst({ where: { userId, status: "PENDING" } });
  if (existing) {
    if (existing.selfieKey && existing.selfieKey !== selfieKey) await purgeDocument(existing.selfieKey);
    if (existing.idDocKey && existing.idDocKey !== idDocKey) await purgeDocument(existing.idDocKey);
    await prisma.manualAgeReview.update({ where: { id: existing.id }, data: { selfieKey, idDocKey } });
    return existing.id;
  }
  const created = await prisma.manualAgeReview.create({ data: { userId, selfieKey, idDocKey } });
  await prisma.ageVerification.create({
    data: { userId, level: "DOCUMENT_VERIFIED", source: "admin_selfie_review", rawStatus: "pending" },
  });
  return created.id;
}

export async function listPendingReviews() {
  return prisma.manualAgeReview.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, username: true, displayName: true, birthDate: true, ageBracket: true } } },
    take: 100,
  });
}

/** Admin decision. ADULT → DOCUMENT_VERIFIED + identity verified + adult. MINOR → locked minor. The
 * selfie is purged either way (we don't retain identity imagery past the decision). */
export async function decideManualReview(
  reviewId: string,
  adminId: string,
  decision: "ADULT" | "MINOR",
  note: string | null,
): Promise<void> {
  const review = await prisma.manualAgeReview.findUnique({ where: { id: reviewId } });
  if (!review || review.status !== "PENDING") return;

  if (decision === "ADULT") {
    await markDocumentVerified(review.userId, "admin_selfie_review", null, false);
  } else {
    // Lumina is 18+: a reviewer concluding "minor" means the account should not exist. The
    // minor flag still goes on first so every contact-separation rule holds during any appeal,
    // and then the ACCOUNT is banned — only the account. Not the email, IP or device: a phone is
    // shared with siblings and parents, a fingerprint collides across identical hardware, and the
    // condition expires on its own (the person is an adult in at most two years). The ban is
    // appealable through the normal route, which is also where a mistaken decision gets undone.
    await setMinor(review.userId, "admin_selfie_review");
    await banUser({
      userId: review.userId,
      actorId: adminId,
      reason: "Under 18 — Lumina is for adults (18+). You're welcome back once you are.",
      expiresAt: null,
      scopes: { email: false, ip: false, device: false },
    });
  }

  // The images are NOT deleted here. They are stamped with a deletion deadline and swept by
  // purgeExpiredReviewDocuments(), which gives a short window to reverse a mistaken decision
  // before the evidence is gone for good. The keys stay set until the sweep actually unlinks the
  // files, so a row can never claim the images are gone while they are still on disk.
  await prisma.manualAgeReview.update({
    where: { id: reviewId },
    data: {
      status: decision === "ADULT" ? "APPROVED" : "REJECTED",
      decision,
      decidedByUserId: adminId,
      decidedAt: new Date(),
      note,
      purgeAfter: new Date(Date.now() + DOC_RETENTION_HOURS * 60 * 60 * 1000),
    },
  });
  // Every other consequential staff/owner action lands in the platform audit trail; this one — a
  // permanent ban, or a verification that unlocks payouts — did not, so a wrong decision left no
  // trace in the views owners actually check (2026-09-08 audit).
  await prisma.staffAuditLog.create({
    data: {
      actorId: adminId,
      actionType: decision === "ADULT" ? "AGE_REVIEW_APPROVE" : "AGE_REVIEW_MINOR",
      targetType: "user",
      targetId: review.userId,
      reason: note ? note.slice(0, 300) : null,
    },
  });
}

// ---- shared transitions -------------------------------------------------------------------------

/** Mark an account identity-verified (the money-surface gate). Optionally reconcile minor status from
 * a proven birthdate; `isMinorOverride` wins when given (e.g. admin decided ADULT). */
async function markDocumentVerified(
  userId: string,
  source: string,
  provenBirthDate: Date | null,
  isMinorOverride: boolean | undefined,
): Promise<void> {
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  // Resolve minor status from the STRONGEST age evidence we have, and NEVER default an unknown age to
  // adult. Order: an explicit human decision (admin ADULT/MINOR) wins; else a proven birthdate; else
  // preserve the account's current status. The old `?? false` default meant a genuine minor who
  // completed a document step with no proven DOB (Persona payload without `birthdate`) was silently
  // promoted to adult and unlinked from their parent — the opposite of the fail-closed posture the
  // rest of the age system takes.
  let isMinor: boolean;
  if (isMinorOverride !== undefined) isMinor = isMinorOverride;
  else if (provenBirthDate) isMinor = ageFromBirthDate(provenBirthDate) < ADULT_AGE;
  else isMinor = current.isMinor;

  await prisma.user.update({
    where: { id: userId },
    data: {
      identityVerifiedAt: new Date(),
      ageAssuranceLevel: "DOCUMENT_VERIFIED",
      ageAssuranceSource: source,
      ageAssuredAt: new Date(),
      ageRecordedAt: current.ageRecordedAt ?? new Date(),
      isMinor,
      // A proven DOB corrects the self-declared one. For a HUMAN adult override with no DOB, clear the
      // stale (wrong) self-declared birthDate — otherwise refreshMinorStatus recomputes isMinor from
      // it on the next login and silently reverts the admin's decision. With birthDate null,
      // refreshMinorStatus returns the stored isMinor, so the decision sticks.
      ...(provenBirthDate ? { birthDate: provenBirthDate } : isMinorOverride === false ? { birthDate: null } : {}),
    },
  });
  // Becoming an adult ends any parental supervision, mirroring refreshMinorStatus's minor→adult path.
  if (isMinor === false) {
    await prisma.parentLink.deleteMany({ where: { childUserId: userId } });
  }
}

async function setMinor(userId: string, source: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      isMinor: true,
      ageAssuranceSource: source,
      ageAssuredAt: new Date(),
      ageRecordedAt: (await hasAgeRecorded(userId)) ? undefined : new Date(),
      // Clear a stale self-declared (adult) birthDate so refreshMinorStatus can't revert an admin's
      // MINOR decision from it on next login — same reasoning as the adult override above.
      birthDate: null,
    },
  });
}

async function hasAgeRecorded(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { ageRecordedAt: true } });
  return u?.ageRecordedAt != null;
}

async function purgeDocument(key: string): Promise<void> {
  try {
    await fs.unlink(path.join(env.UPLOADS_DIR, SELFIE_DIR, key));
  } catch {
    // already gone — fine
  }
}

/**
 * Delete the identity images of every decided review whose retention window has closed, and null
 * the keys so nothing points at a file that no longer exists.
 *
 * Run from the worker. Deliberately deletes the FILE FIRST and only then clears the column: if the
 * process dies between the two, the next sweep retries and unlink-of-a-missing-file is a no-op. The
 * other order would leave an orphan on disk that nothing references and nothing will ever clean up
 * — which, for a photo of someone's passport, is the failure that actually matters.
 *
 * Returns the number of reviews cleared, for the worker log.
 */
export async function purgeExpiredReviewDocuments(): Promise<number> {
  const due = await prisma.manualAgeReview.findMany({
    where: {
      purgeAfter: { lte: new Date() },
      OR: [{ selfieKey: { not: null } }, { idDocKey: { not: null } }],
    },
    select: { id: true, selfieKey: true, idDocKey: true },
    take: 500,
  });
  for (const review of due) {
    if (review.selfieKey) await purgeDocument(review.selfieKey);
    if (review.idDocKey) await purgeDocument(review.idDocKey);
    await prisma.manualAgeReview.update({
      where: { id: review.id },
      data: { selfieKey: null, idDocKey: null },
    });
  }
  return due.length;
}

export function selfieDiskPath(selfieKey: string): string {
  return path.join(env.UPLOADS_DIR, SELFIE_DIR, selfieKey);
}
export { SELFIE_DIR };
