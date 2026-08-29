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
};

export function isDiditConfigured(): boolean {
  return Boolean(env.DIDIT_ENABLED && env.DIDIT_API_KEY && env.DIDIT_WORKFLOW_ID);
}

/** Whether inbound webhooks can be signature-verified. Without it we refuse to process any webhook. */
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
export async function createSession(vendorData: string, callbackUrl?: string): Promise<CreatedSession | null> {
  if (!isDiditConfigured()) return null;
  const created = await diditFetch("/v2/session/", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: env.DIDIT_WORKFLOW_ID,
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
  };
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
