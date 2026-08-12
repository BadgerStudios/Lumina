import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { env } from "../../config/env.js";
import { mailConfigured, sendMail } from "../../lib/mail.js";
import { MUTED_TEXT_STYLE, button } from "../../lib/mailTemplate.js";
import { BadRequestError } from "../../lib/errors.js";

/**
 * Email verification.
 *
 * ## The token is stateless AND revocable
 *
 * It carries `userId.expiry.hmac`, signed with a key derived from JWT_ACCESS_SECRET — so a forged
 * or altered token fails the signature check without a database round trip. But the *most recent*
 * token per user is also recorded in Redis, and redemption requires the presented token to match
 * it.
 *
 * That second half is what makes "resend" behave the way people expect: asking for a new link
 * invalidates the old one. Without it, every link ever sent stays live until it expires, so an
 * address that received three emails has three working keys — and the oldest, most likely to have
 * leaked into a forwarded message or a shared inbox, works just as well as the newest.
 *
 * ## What verification gates: nothing, for now
 *
 * Deliberate. Every existing account is unverified, and gating anything on this would lock out the
 * entire user base the moment it shipped. It records a fact and shows a banner. Making it a
 * requirement is a policy decision to take separately, once most accounts have confirmed — and one
 * that needs a working mail server first, or it locks everyone out permanently.
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Resend rate limit. Generous enough for a genuinely lost email, tight enough that the endpoint
 * cannot be used to send someone a hundred messages. */
const RESEND_COOLDOWN_SEC = 60;

function signingKey(): Buffer {
  return createHmac("sha256", env.JWT_ACCESS_SECRET).update("lumina-email-verification-v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function mintToken(userId: string): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  // A nonce makes two tokens minted in the same millisecond for the same user differ, so "resend
  // invalidates the previous link" holds even for a double-click on the resend button.
  const nonce = randomBytes(8).toString("base64url");
  const payload = `${userId}.${expiry}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

interface ParsedToken {
  userId: string;
  expiry: number;
}

function parseToken(token: string): ParsedToken | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, expiryRaw, nonce, signature] = parts;
  const payload = `${userId}.${expiryRaw}.${nonce}`;

  const expected = Buffer.from(sign(payload));
  const presented = Buffer.from(signature);
  // Length-checked first: timingSafeEqual throws on a length mismatch rather than returning false.
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;

  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  return { userId, expiry };
}

function currentTokenKey(userId: string) {
  return `email-verify:current:${userId}`;
}

function cooldownKey(userId: string) {
  return `email-verify:cooldown:${userId}`;
}

/**
 * Sends (or re-sends) the verification email.
 *
 * Returns what happened rather than throwing on the unconfigured case, so registration can call it
 * unconditionally and the owner console can tell "no mail server" apart from "sent".
 */
export async function sendVerificationEmail(params: {
  userId: string;
  email: string;
  username: string;
}): Promise<"sent" | "not-configured" | "failed"> {
  if (!mailConfigured()) return "not-configured";

  const token = mintToken(params.userId);
  try {
    await redis.set(currentTokenKey(params.userId), token, "PX", TOKEN_TTL_MS);
  } catch {
    // Redis down: the token still verifies on its signature alone. Losing the single-use property
    // is a far better outcome than being unable to verify at all.
  }

  const url = `${primaryAppOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  const ok = await sendMail({
    to: params.email,
    subject: "Confirm your email for Lumina",
    text: [
      `Hi ${params.username},`,
      "",
      "Confirm this address to finish setting up your Lumina account:",
      url,
      "",
      "The link works for 24 hours. If you didn't create this account you can ignore this email —",
      "nothing will happen until the link is used.",
    ].join("\n"),
    // Body only — lib/mail.ts wraps this in the Lumina letterhead.
    html: `
      <p style="margin:0 0 14px">Hi ${escapeHtml(params.username)},</p>
      <p style="margin:0">Confirm this address to finish setting up your Lumina account.</p>
      ${button(escapeHtml(url), "Confirm my email")}
      <p style="${MUTED_TEXT_STYLE};margin:0 0 12px">The link works for 24 hours. If you didn't
      create this account you can ignore this email — nothing will happen until the link is used.</p>
      <p style="${MUTED_TEXT_STYLE};margin:0">If the button doesn't work, paste this into your
      browser:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>
    `,
  });
  return ok ? "sent" : "failed";
}

/** Same first-origin logic as the passkey relying party: PUBLIC_APP_URL is a comma-separated list
 * of every origin this instance answers on, and a link must point at exactly one of them. */
function primaryAppOrigin(): string {
  const origins = env.PUBLIC_APP_URL.split(",").map((o) => o.trim()).filter(Boolean);
  return origins.find((o) => o.startsWith("https://") && !o.includes("localhost")) ?? origins[0] ?? "";
}

export async function requestResend(userId: string): Promise<"sent" | "not-configured" | "failed" | "too-soon" | "already-verified"> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, username: true, emailVerifiedAt: true },
  });
  if (!user) throw new BadRequestError("No such account");
  if (user.emailVerifiedAt) return "already-verified";

  try {
    // NX: only sets when absent, so this is an atomic "claim the cooldown or fail" rather than a
    // read-then-write that two concurrent clicks both pass.
    const claimed = await redis.set(cooldownKey(userId), "1", "EX", RESEND_COOLDOWN_SEC, "NX");
    if (claimed === null) return "too-soon";
  } catch {
    /* Redis down — allow the send rather than blocking a legitimate request */
  }

  return sendVerificationEmail({ userId, email: user.email, username: user.username });
}

export async function verifyToken(token: string): Promise<{ userId: string }> {
  const parsed = parseToken(token);
  if (!parsed) throw new BadRequestError("That link is invalid or has expired");

  // The stored-token check makes a resend invalidate every earlier link. Skipped when Redis has no
  // record — the signature and expiry still stand, and refusing a structurally valid token because
  // a cache entry is missing would strand users after any restart that lost the key.
  try {
    const current = await redis.get(currentTokenKey(parsed.userId));
    if (current && current !== token) {
      throw new BadRequestError("That link has been replaced by a newer one — use the latest email");
    }
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
  }

  const user = await prisma.user.findUnique({
    where: { id: parsed.userId },
    select: { id: true, emailVerifiedAt: true },
  });
  if (!user) throw new BadRequestError("That link is invalid or has expired");

  // Idempotent: clicking a link twice, or a mail client prefetching it, must not look like a
  // failure to the person who did nothing wrong.
  if (!user.emailVerifiedAt) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }

  try {
    await redis.del(currentTokenKey(parsed.userId));
  } catch {
    /* best effort */
  }

  return { userId: user.id };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
