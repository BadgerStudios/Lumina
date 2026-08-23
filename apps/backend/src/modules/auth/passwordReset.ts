import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { hashPassword } from "../../lib/password.js";
import { mailConfigured, sendMail } from "../../lib/mail.js";
import { MUTED_TEXT_STYLE, button } from "../../lib/mailTemplate.js";
import { primaryAppOrigin } from "../../lib/appOrigin.js";
import { BadRequestError } from "../../lib/errors.js";

/**
 * Self-serve password reset. Mirrors emailVerification.ts, with one deliberate difference that makes
 * a reset link SINGLE-USE with no database table and no Redis dependency:
 *
 *   the token is signed with a key that mixes in the user's CURRENT password hash.
 *
 * So the moment a reset completes (which changes the hash), every outstanding link for that account
 * stops verifying — the classic Django-style reset token. It also means any password change at all
 * invalidates pending links, which is exactly the security property you want. Verification costs one
 * DB read (the hash), which a reset can well afford.
 *
 * Enumeration-safe: `requestPasswordReset` returns the same result whether or not the address exists,
 * so the endpoint can't be used to probe which emails have accounts.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — shorter than email verification; it changes a credential.

function signingKey(passwordHash: string): Buffer {
  // Domain-separated from the email-verification key, and bound to the current credential.
  return createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(`lumina-password-reset-v1:${passwordHash}`)
    .digest();
}

function sign(payload: string, passwordHash: string): string {
  return createHmac("sha256", signingKey(passwordHash)).update(payload).digest("base64url");
}

function mintToken(userId: string, passwordHash: string): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const nonce = randomBytes(8).toString("base64url");
  const payload = `${userId}.${expiry}.${nonce}`;
  return `${payload}.${sign(payload, passwordHash)}`;
}

async function parseToken(token: string): Promise<{ userId: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, expiryRaw, nonce, signature] = parts;

  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) return null;

  const payload = `${userId}.${expiryRaw}.${nonce}`;
  const expected = Buffer.from(sign(payload, user.passwordHash));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  return { userId };
}

/**
 * Send a reset link to `email` if an account exists. Always resolves to "sent" (or "not-configured"
 * when there is no mail server) regardless of whether the address matched — no account enumeration.
 */
export async function requestPasswordReset(email: string): Promise<"sent" | "not-configured"> {
  if (!mailConfigured()) return "not-configured";

  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, email: true, username: true, passwordHash: true },
  });
  // Deliberately send nothing (but report "sent") when there's no match — same externally observable
  // result either way.
  if (!user) return "sent";

  const token = mintToken(user.id, user.passwordHash);
  const url = `${primaryAppOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  // Fire-and-forget, exactly like signup's verification email — and specifically so this endpoint
  // stays enumeration-safe: awaiting the SMTP round-trip only for real accounts made response TIMING
  // a reliable existence oracle (a match took tens–hundreds of ms longer than a miss). Not awaiting
  // equalises the two paths.
  void sendMail({
    to: user.email,
    subject: "Reset your Lumina password",
    text: [
      `Hi ${user.username},`,
      "",
      "We received a request to reset your Lumina password. Use this link to choose a new one:",
      url,
      "",
      "The link works for 1 hour and can be used once. If you didn't request this, you can ignore",
      "this email — your password won't change until the link is used.",
    ].join("\n"),
    html: `
      <p style="margin:0 0 14px">Hi ${escapeHtml(user.username)},</p>
      <p style="margin:0">We received a request to reset your Lumina password. Choose a new one below.</p>
      ${button(escapeHtml(url), "Reset my password")}
      <p style="${MUTED_TEXT_STYLE};margin:0 0 12px">The link works for 1 hour and can be used once.
      If you didn't request this, you can ignore this email — your password won't change until the
      link is used.</p>
      <p style="${MUTED_TEXT_STYLE};margin:0">If the button doesn't work, paste this into your
      browser:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>
    `,
  }).catch(() => undefined);
  return "sent";
}

/**
 * Complete a reset: verify the token, set the new password, and revoke every existing session so a
 * thief who prompted the reset (or who held an old session) is logged out everywhere. Single-use is
 * automatic — changing the hash invalidates this very token.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const parsed = await parseToken(token);
  if (!parsed) throw new BadRequestError("That reset link is invalid or has expired");

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: parsed.userId }, data: { passwordHash } });
  // Log out all sessions — a password reset is exactly when you want every other device signed out.
  await prisma.refreshToken.updateMany({
    where: { userId: parsed.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
