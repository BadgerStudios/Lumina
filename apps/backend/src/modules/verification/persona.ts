import crypto from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Persona (withpersona.com) client — the document+selfie identity/age step-up.
 *
 * Follows the exact graceful-degradation contract of billing/stripe.ts: nothing here throws at import
 * time, and every call is a no-op returning null when unconfigured, so the build and the whole test
 * suite run with no Persona credentials. The feature goes live by setting PERSONA_* env vars.
 *
 * We talk to the REST API directly with fetch rather than pulling an SDK — the surface we need is two
 * calls (create an inquiry, mint a one-time hosted link) plus HMAC webhook verification, and adding a
 * dependency for that is not worth it.
 */

const PERSONA_BASE = "https://withpersona.com/api/v1";
// Pinned like Stripe's apiVersion — Persona is date-versioned; a floating version is a latent break.
const PERSONA_VERSION = "2023-01-05";

export function isPersonaConfigured(): boolean {
  return Boolean(env.PERSONA_API_KEY && env.PERSONA_TEMPLATE_ID);
}

/** Whether inbound webhooks can be signature-verified. Without it we refuse to process any webhook. */
export function isPersonaWebhookConfigured(): boolean {
  return Boolean(env.PERSONA_WEBHOOK_SECRET);
}

async function personaFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${PERSONA_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PERSONA_API_KEY}`,
      "Persona-Version": PERSONA_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Persona ${path} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

export interface CreatedInquiry {
  inquiryId: string;
  oneTimeLink: string | null;
}

/**
 * Create an inquiry for a user and mint a one-time hosted link to send them. `referenceId` is our
 * user id — Persona echoes it back on the webhook so we can attribute the result without storing any
 * PII on our side. Returns null when Persona is unconfigured (caller falls back to manual review).
 */
export async function createInquiry(referenceId: string): Promise<CreatedInquiry | null> {
  if (!isPersonaConfigured()) return null;
  const created = await personaFetch("/inquiries", {
    method: "POST",
    body: JSON.stringify({
      data: {
        attributes: {
          "inquiry-template-id": env.PERSONA_TEMPLATE_ID,
          "reference-id": referenceId,
        },
      },
    }),
  });
  const inquiryId: string = created?.data?.id;
  if (!inquiryId) throw new Error("Persona inquiry create returned no id");

  let oneTimeLink: string | null = null;
  try {
    const link = await personaFetch(`/inquiries/${inquiryId}/generate-one-time-link`, { method: "POST" });
    oneTimeLink = link?.data?.attributes?.["one-time-link"] ?? null;
  } catch {
    // A missing link is recoverable — the client can still resume by inquiry id via the SDK. Don't
    // fail the whole start over it.
    oneTimeLink = null;
  }
  return { inquiryId, oneTimeLink };
}

/**
 * Verify a Persona webhook signature. Persona signs the RAW body with HMAC-SHA256 and sends
 * `Persona-Signature: t=<unix>,v1=<hex>[ v1=<hex> ...]` (multiple v1 values during secret rotation).
 * We recompute HMAC over `t.rawBody` and constant-time compare against each candidate. Mirrors the
 * Stripe verification shape so the webhook route reads the same as billing's.
 */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!env.PERSONA_WEBHOOK_SECRET || !header) return false;
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || sigs.length === 0) return false;

  const expected = crypto
    .createHmac("sha256", env.PERSONA_WEBHOOK_SECRET)
    .update(`${t}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return sigs.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}
