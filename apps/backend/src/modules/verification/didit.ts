import crypto from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Didit (didit.me) client — automated document + liveness + face-match identity verification.
 *
 * Follows the same graceful-degradation contract as persona.ts and billing/stripe.ts: nothing throws
 * at import time, and every call is a no-op returning null when unconfigured, so the build and the
 * test suite run with no Didit credentials. The feature goes live by setting DIDIT_* env vars.
 *
 * ## Why this exists alongside Persona
 *
 * Persona's path falls back to an admin selfie-review queue once its monthly budget is spent. That
 * queue is worked by hand, and on this instance it has had zero rows for its entire lifetime while
 * being the only route through the identity gate — which is how sign-ups were silently dead for five
 * days. Didit's workflow is fully automated (ID_VERIFICATION, LIVENESS, FACE_MATCH, IP_ANALYSIS), so
 * it is the provider that can actually clear someone without a human being awake.
 *
 * ## Polling, not just webhooks
 *
 * The decision is read by POLLING `/decision/` when the user returns, and the webhook is an optional
 * accelerator. That is deliberate: a webhook needs a shared secret to be verifiable, and an
 * integration that only works once someone has copied a secret out of a dashboard is an integration
 * that appears finished and is not. Polling needs nothing beyond the API key that is already set.
 */

/** Didit returns title-case statuses with spaces ("Not Started", "In Review"). Normalised here. */
export type DiditOutcome = {
  /** Provider status verbatim, for the audit row. */
  rawStatus: string;
  approved: boolean;
  declined: boolean;
  /** Still with the provider (or a human at the provider) — neither pass nor fail yet. */
  pending: boolean;
  /** Proven date of birth, when the workflow extracted one. Null is normal and not a failure. */
  dateOfBirth: Date | null;
  /**
   * Estimated age in years from an age-estimation workflow. Null when the workflow does not
   * produce one, which includes every document workflow — absence is normal, never a failure.
   */
  estimatedAge: number | null;
};

export function isDiditConfigured(): boolean {
  return Boolean(env.DIDIT_ENABLED && env.DIDIT_API_KEY && env.DIDIT_WORKFLOW_ID);
}

/** Whether inbound webhooks can be signature-verified. Without it we refuse to process any webhook. */
/** Whether a dedicated age-estimation workflow is configured, as opposed to falling back. */
export function isDiditAgeConfigured(): boolean {
  return Boolean(env.DIDIT_ENABLED && env.DIDIT_API_KEY && env.DIDIT_AGE_WORKFLOW_ID);
}

export function isDiditWebhookConfigured(): boolean {
  return Boolean(env.DIDIT_WEBHOOK_SECRET);
}

async function diditFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${env.DIDIT_BASE_URL}${path}`, {
    ...init,
    headers: {
      // Didit authenticates with x-api-key, NOT a Bearer token — a Bearer is accepted by the
      // transport and then rejected as "Token is inactive or unknown", which reads like a bad key.
      "x-api-key": env.DIDIT_API_KEY!,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Didit ${path} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

export interface CreatedSession {
  sessionId: string;
  /** Hosted flow to send the user to. */
  url: string;
  rawStatus: string;
}

/**
 * Open a verification session for a user.
 *
 * `vendorData` is our user id; Didit echoes it back on both the decision and the webhook, which is
 * how a result is attributed without storing anything about the person on their side. Returns null
 * when unconfigured so the caller can fall through to another provider.
 */
export async function createSession(
  vendorData: string,
  callbackUrl?: string,
  /** Overrides the default workflow — used for the age-estimation one. */
  workflowId?: string,
): Promise<CreatedSession | null> {
  if (!isDiditConfigured()) return null;
  const created = await diditFetch("/v2/session/", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: workflowId ?? env.DIDIT_WORKFLOW_ID,
      vendor_data: vendorData,
      ...(callbackUrl ? { callback: callbackUrl } : {}),
    }),
  });
  const sessionId: string | undefined = created?.session_id;
  const url: string | undefined = created?.url;
  if (!sessionId || !url) throw new Error("Didit session create returned no session_id/url");
  return { sessionId, url, rawStatus: String(created?.status ?? "Not Started") };
}

/** Read the current decision for a session. Null when unconfigured. */
export async function fetchDecision(sessionId: string): Promise<any | null> {
  if (!isDiditConfigured()) return null;
  return await diditFetch(`/v2/session/${encodeURIComponent(sessionId)}/decision/`);
}

const APPROVED = new Set(["approved"]);
const DECLINED = new Set(["declined", "rejected", "failed", "abandoned", "expired"]);

/**
 * Reduce a decision payload to the three outcomes this app acts on.
 *
 * Anything not recognised is treated as PENDING rather than declined. An unknown status is far more
 * likely to be a provider adding a new intermediate state than a refusal, and defaulting to refusal
 * would lock people out of their accounts over a vocabulary change.
 */
export function readOutcome(decision: any): DiditOutcome {
  const rawStatus = String(decision?.status ?? "unknown");
  const status = rawStatus.trim().toLowerCase().replace(/\s+/g, " ");
  const approved = APPROVED.has(status);
  const declined = DECLINED.has(status);
  return {
    rawStatus,
    approved,
    declined,
    pending: !approved && !declined,
    dateOfBirth: extractDateOfBirth(decision),
    estimatedAge: extractEstimatedAge(decision),
  };
}

/**
 * Pull an estimated age out of an age-estimation result.
 *
 * Written the same way extractDateOfBirth is, and for the same reason: the exact key is not pinned
 * by anything observable from an unstarted session, so several plausible spellings are tried and
 * absence is tolerated. Nothing auto-approves on a shape this does not recognise — a missing
 * estimate leaves the account exactly as it was, which is the direction that cannot do harm.
 *
 * The value is a POINT ESTIMATE from a model and should never be read as a fact about someone's
 * age. How it is allowed to be used is decided in the service, not here.
 */
function extractEstimatedAge(decision: any): number | null {
  const blocks = [decision?.age_estimation, decision?.ageEstimation, decision?.age, decision];
  const keys = ["age", "estimated_age", "estimatedAge", "predicted_age", "value"];
  for (const block of blocks) {
    if (block == null) continue;
    if (typeof block === "number" && Number.isFinite(block)) {
      if (block > 0 && block < 120) return block;
      continue;
    }
    if (typeof block !== "object") continue;
    for (const key of keys) {
      const value = (block as Record<string, unknown>)[key];
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (Number.isFinite(n) && n > 0 && n < 120) return n;
    }
  }
  return null;
}

/**
 * Pull a proven date of birth out of the ID_VERIFICATION block.
 *
 * The exact key is not pinned by anything we can see from an unstarted session, so several plausible
 * spellings are tried and absence is tolerated. A missing birthdate is NOT a failure — it means the
 * account is document-verified but its self-declared birthday stands unreconciled, which is exactly
 * how applyPersonaResult already treats the same situation.
 */
function extractDateOfBirth(decision: any): Date | null {
  const blocks = [decision?.id_verification, decision?.expected_details, decision];
  const keys = ["date_of_birth", "dateOfBirth", "dob", "birth_date", "birthDate"];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    for (const key of keys) {
      const value = (block as Record<string, unknown>)[key];
      if (typeof value !== "string" || !value.trim()) continue;
      const parsed = new Date(value);
      // Guard against a provider sending something unparseable or absurd rather than trusting it
      // straight into an age calculation.
      if (Number.isNaN(parsed.getTime())) continue;
      const year = parsed.getUTCFullYear();
      if (year < 1900 || parsed.getTime() > Date.now()) continue;
      return parsed;
    }
  }
  return null;
}

/**
 * Verify a Didit webhook signature: HMAC-SHA256 over the RAW body, hex, in `x-signature`.
 *
 * NOTE: this scheme is implemented from Didit's documented webhook contract and has not been
 * exercised against a real delivery here, because no DIDIT_WEBHOOK_SECRET is configured. Confirm the
 * header name in the Didit dashboard before relying on it. Nothing depends on it working — the
 * decision is read by polling — so a wrong guess here degrades to "webhooks refused", never to
 * "unverified webhooks accepted".
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.DIDIT_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", env.DIDIT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(signature.trim().replace(/^sha256=/, ""), "utf8");
  return givenBuf.length === expectedBuf.length && crypto.timingSafeEqual(givenBuf, expectedBuf);
}

/**
 * The selfie Didit captured, downloaded so a person can look at it.
 *
 * ## Why the key names are guessed at
 *
 * Written exactly the way extractDateOfBirth and extractEstimatedAge are, and for the same reason:
 * the response shape is not pinned by anything observable here, and the account is out of credits
 * so no real decision can be inspected to pin it. Several plausible spellings are tried, absence is
 * tolerated, and nothing about the verification changes when none of them match. A missing image
 * means a review row with no picture — visibly incomplete — rather than a verification that failed
 * for a reason nobody can see.
 *
 * ## Why it is fetched at all
 *
 * Because "approve this person" is a decision somebody has to be able to actually make. A review
 * queue whose rows say "Didit was unsure" and show nothing is a queue where every answer is a
 * guess.
 */
export async function fetchDiditSelfie(
  decision: any,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const url = findImageUrl(decision);
  if (!url) return null;

  try {
    const response = await fetch(url, {
      // Same header the rest of this client uses — Didit authenticates with x-api-key, never a
      // Bearer. The asset URL is on their domain and needs it too.
      headers: env.DIDIT_API_KEY ? { "x-api-key": env.DIDIT_API_KEY } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error(`[didit] could not fetch the captured selfie (${response.status})`);
      return null;
    }
    const contentType = String(response.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    // Only pictures. A provider handing back something else is not a thing to write to disk and
    // then serve back to a moderator's browser.
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    // 12MB is far above any portrait and far below "someone is using this as storage".
    if (buffer.length === 0 || buffer.length > 12 * 1024 * 1024) return null;
    return { buffer, contentType };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[didit] selfie fetch failed:", (error as Error)?.message);
    return null;
  }
}

/**
 * Walk the decision for something that looks like the captured portrait.
 *
 * Breadth-first with a visited set, because the payload is nested and self-referential in places.
 * Keys are checked in preference order — a liveness/portrait capture is the face we want, and a
 * document photo is a last resort that at least shows a person.
 */
function findImageUrl(decision: any): string | null {
  const PREFERRED = [
    "liveness_reference_image", "livenessReferenceImage",
    "face_image", "faceImage", "portrait", "selfie", "selfie_url", "selfieUrl",
    "reference_image", "referenceImage", "face_url", "faceUrl", "image_url", "imageUrl",
    "cropped_face", "croppedFace", "front_image", "frontImage",
  ];

  const seen = new Set<unknown>();
  const queue: unknown[] = [decision];
  const found = new Map<string, string>();

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && /^https:\/\//i.test(value) && !found.has(key)) {
        found.set(key, value);
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  for (const key of PREFERRED) {
    const hit = found.get(key);
    if (hit) return hit;
  }
  // Nothing named like a face. An https URL under a key that merely CONTAINS "image" is the last
  // thing tried, and only when it is not obviously a document scan.
  for (const [key, value] of found) {
    const lower = key.toLowerCase();
    if (lower.includes("image") && !lower.includes("document") && !lower.includes("back")) return value;
  }
  return null;
}
