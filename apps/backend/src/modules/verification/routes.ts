import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireStaff } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { sendFileWithRange } from "../../lib/sendFile.js";
import { isPersonaConfigured, isPersonaWebhookConfigured, verifyWebhookSignature } from "./persona.js";
import {
  isDiditConfigured,
  isDiditWebhookConfigured,
  verifyWebhookSignature as verifyDiditSignature,
} from "./didit.js";
import {
  recordDeviceSignal,
  startVerification,
  applyPersonaResult,
  applyDiditResult,
  pollDiditForUser,
  createManualReview,
  DOC_RETENTION_HOURS,
  listPendingReviews,
  decideManualReview,
  selfieDiskPath,
  SELFIE_DIR,
} from "./service.js";
import { env } from "../../config/env.js";
import { isTurnstileEnabled } from "../../plugins/turnstile.js";
import path from "node:path";

/**
 * Age-verification HTTP surface. Mounted under /api/verification.
 *
 * Ships inert: with no PERSONA_* / attestation env, /persona/start returns manual_review, the webhook
 * refuses everything (no signing secret), and /device-signal never upgrades assurance (attestation
 * fails closed). Activated purely by adding env vars — same contract as billing.
 */

const deviceSignalSchema = z.object({
  platform: z.enum(["android", "ios"]),
  band: z.string().min(1).max(40),
  attestationToken: z.string().min(1).max(20000).optional(),
});

/**
 * Accounts created from this instant onward must clear identity verification. Everything older is
 * grandfathered: the requirement is for NEW signups, and retroactively locking existing members out
 * of an account they already use is a different product decision than the one that was made.
 *
 * Set to when the requirement shipped. Moving it FORWARD grandfathers more people; moving it
 * BACKWARD will lock out accounts that are currently fine, so change it deliberately.
 */
const IDENTITY_REQUIRED_FROM = env.IDENTITY_REQUIRED_FROM ? new Date(env.IDENTITY_REQUIRED_FROM) : null;

const MAX_SELFIE_BYTES = 8 * 1024 * 1024;
const SELFIE_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;

export default async function verificationRoutes(fastify: FastifyInstance) {
  // Capture the Persona webhook body verbatim so the HMAC (computed over raw bytes) verifies —
  // identical to the Stripe webhook's raw-body handling. All other JSON routes parse normally.
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    if (
      req.url.startsWith("/api/verification/persona/webhook") ||
      req.url.startsWith("/api/verification/didit/webhook")
    ) {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8") || "{}"));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /** Public, unauthenticated config the client needs before login — the Turnstile site key (public
   * by design) and whether identity verification is available. Mirrors GET /api/billing/config. The
   * site key is surfaced ONLY when Turnstile is fully enabled (site key AND secret set), so a widget
   * is never rendered without server-side verification behind it. */
  fastify.get("/config", async () => ({
    turnstileSiteKey: isTurnstileEnabled() ? env.TURNSTILE_SITE_KEY ?? null : null,
    personaConfigured: isPersonaConfigured(),
    diditConfigured: isDiditConfigured(),
    // True when ANY automated document path exists. The client should gate its "verify me" UI on
    // this rather than on a specific provider.
    identityVerificationAvailable: isDiditConfigured() || isPersonaConfigured(),
  }));

  /** What the client needs to render the verification UI and gates. */
  fastify.get("/status", { preHandler: [requireAuth] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.userId! },
      select: {
        ageAssuranceLevel: true,
        ageAssuranceSource: true,
        ageAssuredBand: true,
        identityVerifiedAt: true,
        isMinor: true,
        ageBracket: true,
        ageRecordedAt: true,
        personaStatus: true,
        createdAt: true,
      },
    });
    const pendingReview = await prisma.manualAgeReview.findFirst({
      where: { userId: request.userId!, status: "PENDING" },
      select: { id: true },
    });

    // The account is locked as a minor while the person chose an adult bracket. Only a document can
    // settle which is right, so this is the one state that escalates on its own.
    const contradictsSelfDeclaration =
      user.isMinor && user.ageBracket !== null && user.ageBracket !== "UNDER_18";
    return {
      assuranceLevel: user.ageAssuranceLevel,
      assuranceSource: user.ageAssuranceSource,
      band: user.ageAssuredBand,
      identityVerified: user.identityVerifiedAt !== null,
      isMinor: user.isMinor,
      hasAgeOnRecord: user.ageRecordedAt !== null,
      personaStatus: user.personaStatus,
      manualReviewPending: pendingReview !== null,
      personaConfigured: isPersonaConfigured(),
      // Whether THIS account has to clear the identity check to keep using the product.
      //
      // RISK-TRIGGERED, not blanket. Documents are demanded where a signal actually contradicts what
      // the account claims, not from everyone at the front door.
      //
      // Why not everyone: a document check at sign-up lands the heaviest possible friction at the
      // moment a person has the least reason to tolerate it, and it does not stop the case it is
      // aimed at — a teenager holding a parent's ID passes it. It reliably repels honest adults and
      // unreliably catches dishonest minors. The self-declared check already refuses an under-age
      // birthday before any row exists and puts a 30-day cooldown on the device, which is a real
      // control; this is the escalation for when something disagrees with it.
      //
      // The trigger that matters: the account is being treated as a minor (a device band said so and
      // locked it — see recordDeviceSignal) while the person selected an adult bracket. That is the
      // one situation where the two signals cannot both be true, where guessing is harmful in both
      // directions, and where a document is the only thing that resolves it. It doubles as the
      // appeal route for an adult wrongly caught by a shared or mis-reported device.
      //
      // IDENTITY_REQUIRED_FROM is kept as an optional blanket override for a surface or a
      // jurisdiction that genuinely mandates it. Unset means only the risk trigger applies.
      verificationRequired:
        user.identityVerifiedAt === null
        && pendingReview === null
        && (contradictsSelfDeclaration
          || (IDENTITY_REQUIRED_FROM !== null && user.createdAt >= IDENTITY_REQUIRED_FROM)),
      // Lets the client explain WHY it is asking, instead of demanding a passport with no reason.
      verificationReason: contradictsSelfDeclaration
        ? ("age_signal_conflict" as const)
        : IDENTITY_REQUIRED_FROM !== null && user.createdAt >= IDENTITY_REQUIRED_FROM
          ? ("required_for_new_accounts" as const)
          : null,
    };
  });

  /** A native Apple/Google age band from the app. Only upgrades assurance if attestation verifies. */
  fastify.post("/device-signal", { preHandler: [requireAuth] }, async (request) => {
    const body = deviceSignalSchema.parse(request.body);
    const outcome = await recordDeviceSignal(request.userId!, body.platform, body.band, body.attestationToken);
    return outcome;
  });

  /**
   * Begin the document/identity step (the money-surface gate, or a minor disputing). Returns a Persona
   * hosted link while budget lasts, otherwise `manual_review` (client then uploads a selfie).
   */
  fastify.post("/persona/start", { preHandler: [requireAuth] }, async (request) => {
    const outcome = await startVerification(request.userId!);
    return outcome;
  });

  /**
   * Provider-neutral entry point. `/persona/start` predates there being more than one provider and
   * still works identically — both call startVerification, which picks Didit, then Persona, then the
   * manual queue. New clients should call this one; the name is the only difference.
   */
  fastify.post("/identity/start", { preHandler: [requireAuth] }, async (request) => {
    return await startVerification(request.userId!);
  });

  /**
   * Read the caller's latest Didit session and apply whatever it now says.
   *
   * This is the PRIMARY completion path, not a fallback for a broken webhook. The client calls it
   * when the user comes back from the hosted flow, and may poll it while the status is pending. It
   * needs no shared secret, which is what makes the integration work the moment an API key exists.
   */
  fastify.post("/didit/decision", { preHandler: [requireAuth] }, async (request, reply) => {
    if (!isDiditConfigured()) return reply.code(503).send({ error: "Identity verification is not configured" });
    const result = await pollDiditForUser(request.userId!);
    if (!result) return reply.code(404).send({ error: "No verification session to check" });
    return result;
  });

  /**
   * Didit webhook — an accelerator, never the only route to a decision.
   *
   * Same contract as the Persona webhook: 503 while unconfigured so the provider retries rather than
   * treating the delivery as consumed, 400 on a signature that does not verify, 200 otherwise.
   * Because the polling route above is what the product actually depends on, a webhook that is
   * misconfigured costs latency and nothing else.
   */
  fastify.post("/didit/webhook", async (request, reply) => {
    if (!isDiditWebhookConfigured()) return reply.code(503).send({ error: "Webhook not configured" });
    const raw = request.body as Buffer;
    const signature = (request.headers["x-signature"] ?? request.headers["x-didit-signature"]) as string | undefined;
    if (!verifyDiditSignature(raw, signature)) {
      request.log.warn("didit webhook signature verification failed");
      return reply.code(400).send({ error: "Invalid signature" });
    }
    try {
      const payload = JSON.parse(raw.toString("utf8") || "{}");
      const sessionId: unknown = payload?.session_id;
      if (typeof sessionId === "string" && sessionId) {
        await applyDiditResult(sessionId, payload);
      }
    } catch (err) {
      request.log.error({ err }, "didit webhook handler failed");
      // Swallowed deliberately: the decision is still readable by polling, so a malformed delivery
      // must not become a retry storm.
    }
    return reply.code(200).send({ received: true });
  });

  /** Selfie upload for the manual-review fallback. Stored privately; reviewed in the owner suite. */
  /**
   * Age verification upload: a selfie AND a photo of a government ID, in one multipart request.
   *
   * Both or neither. Accepting a partial submission would put a half-built review in front of a
   * reviewer who then cannot decide it, while the applicant believes they are done -- and would
   * leave one identity image sitting on disk with nothing driving its deletion.
   */
  fastify.post("/manual-review", { preHandler: [requireAuth] }, async (request) => {
    if (!request.isMultipart()) throw new BadRequestError("Expected a multipart upload");

    const received: Record<string, { buf: Buffer; ext: string }> = {};
    for await (const part of request.parts({ limits: { fileSize: MAX_SELFIE_BYTES, files: 2 } })) {
      if (part.type !== "file") continue;
      if (part.fieldname !== "selfie" && part.fieldname !== "idDocument") {
        await part.toBuffer().catch(() => undefined);
        continue;
      }
      if (!SELFIE_MIME.test(part.mimetype)) {
        throw new BadRequestError(`Unsupported image type: ${part.mimetype}`);
      }
      const buf = await part.toBuffer();
      if (part.file.truncated) throw new BadRequestError("Image too large (8 MB max)");
      received[part.fieldname] = { buf, ext: part.mimetype.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg" };
    }
    if (!received.selfie) throw new BadRequestError("A selfie is required");
    if (!received.idDocument) throw new BadRequestError("A photo of your ID is required");

    await fs.mkdir(path.join(env.UPLOADS_DIR, SELFIE_DIR), { recursive: true });
    const selfieKey = `${crypto.randomUUID()}.${received.selfie.ext}`;
    const idDocKey = `${crypto.randomUUID()}.${received.idDocument.ext}`;
    await fs.writeFile(selfieDiskPath(selfieKey), received.selfie.buf);
    await fs.writeFile(selfieDiskPath(idDocKey), received.idDocument.buf);

    const reviewId = await createManualReview(request.userId!, selfieKey, idDocKey);
    return { status: "pending", reviewId, retentionHours: DOC_RETENTION_HOURS };
  });

  /**
   * Persona webhook. Mirrors the Stripe webhook contract: 503 unconfigured (provider retries), 400 on
   * a bad/missing signature, dispatch by event, 500 on handler failure (retry), 200 on success.
   */
  fastify.post("/persona/webhook", async (request, reply) => {
    if (!isPersonaWebhookConfigured()) return reply.code(503).send({ error: "Verification not configured" });

    const raw = request.body as Buffer;
    const signature = request.headers["persona-signature"] as string | undefined;
    if (!verifyWebhookSignature(raw, signature)) {
      request.log.warn("persona webhook signature verification failed");
      return reply.code(400).send({ error: "Invalid signature" });
    }

    let event: any;
    try {
      event = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      return reply.code(400).send({ error: "Invalid payload" });
    }

    try {
      const name: string = event?.data?.attributes?.name ?? "";
      if (name.startsWith("inquiry.")) {
        const resource = event?.data?.attributes?.payload?.data;
        const inquiryId: string | undefined = resource?.id;
        const status: string = resource?.attributes?.status ?? name.replace("inquiry.", "");
        const birthdateRaw: string | undefined = resource?.attributes?.birthdate;
        const provenBirthDate = birthdateRaw ? new Date(birthdateRaw) : null;
        if (inquiryId) {
          await applyPersonaResult(
            inquiryId,
            status,
            provenBirthDate && !isNaN(provenBirthDate.getTime()) ? provenBirthDate : null,
          );
        }
      }
    } catch (err) {
      request.log.error({ err }, "persona webhook handler failed");
      return reply.code(500).send({ error: "Handler failed" });
    }

    return reply.code(200).send({ received: true });
  });

  // ---- Owner suite: manual selfie review queue (owner-authenticated) ----------------------------

  const decideSchema = z.object({
    decision: z.enum(["ADULT", "MINOR"]),
    note: z.string().max(500).optional(),
  });

  /** Pending selfie reviews for the owner suite, with a selfie URL per row. */
  // requireStaff, not requireOwner: working the verification queue is the staff suite's job, and an
  // owner-only queue is one that nobody clears. Staff see the images and decide; nothing else about
  // the account is exposed here.
  fastify.get("/owner/age-reviews", { preHandler: [requireAuth, requireStaff] }, async () => {
    const reviews = await listPendingReviews();
    return reviews.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      selfieUrl: r.selfieKey ? `/api/verification/owner/age-reviews/${r.id}/selfie` : null,
      idDocumentUrl: r.idDocKey ? `/api/verification/owner/age-reviews/${r.id}/id-document` : null,
      user: {
        id: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName,
        // The self-declared claim the admin is checking the selfie against.
        birthDate: r.user.birthDate?.toISOString() ?? null,
        ageBracket: r.user.ageBracket,
      },
    }));
  });

  /** Stream one review's selfie or ID photo, staff-only. Sensitive imagery — never cached, never
   *  public, and gone once the retention window closes. */
  fastify.get("/owner/age-reviews/:id/:document", { preHandler: [requireAuth, requireStaff] }, async (request, reply) => {
    const { id, document } = request.params as { id: string; document: string };
    if (document !== "selfie" && document !== "id-document") throw new NotFoundError("Unknown document");
    const review = await prisma.manualAgeReview.findUnique({ where: { id } });
    const key = document === "selfie" ? review?.selfieKey : review?.idDocKey;
    if (!review || !key) throw new NotFoundError("Document not found");
    const filePath = selfieDiskPath(key);
    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      throw new NotFoundError("Document not found on disk");
    }
    const ext = key.split(".").pop() ?? "jpg";
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "heic" || ext === "heif" ? `image/${ext}` : "image/jpeg";
    reply.header("Cache-Control", "no-store");
    return sendFileWithRange(reply, filePath, { mimeType: mime, sizeBytes: size, rangeHeader: request.headers.range, inline: true });
  });

  /** Decide a review: ADULT unlocks the money surface (DOCUMENT_VERIFIED); MINOR locks the account. */
  fastify.post("/owner/age-reviews/:id/decide", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = decideSchema.parse(request.body);
    await decideManualReview(id, request.userId!, body.decision, body.note ?? null);
    return { ok: true };
  });
}
