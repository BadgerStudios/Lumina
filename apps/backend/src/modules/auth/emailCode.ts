import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { env } from "../../config/env.js";
import { mailConfigured, sendMail } from "../../lib/mail.js";
import { MUTED_TEXT_STYLE } from "../../lib/mailTemplate.js";
import { BadRequestError } from "../../lib/errors.js";

/**
 * Email confirmation by six-digit code.
 *
 * The link flow in emailVerification.ts still exists and still works — this is the one used during
 * sign-up, because a code can be typed into the tab the person is already in. A link asks them to
 * leave the app, and on a phone it frequently opens a different browser than the one holding the
 * half-finished session, which is where sign-ups get abandoned.
 *
 * ## Why the code is hashed
 *
 * Six digits is a million possibilities, which is only meaningful because guesses are capped. The
 * stored value is an HMAC, not the code itself, so a dump of Redis does not hand over live codes
 * for every pending sign-up. Verification recomputes the HMAC and compares in constant time.
 *
 * ## Why this fails CLOSED when Redis is unavailable
 *
 * The link token carries its own signature and can be verified with nothing but the signing key,
 * so that flow can afford to shrug off a Redis outage. A code cannot: the digits are only
 * meaningful next to the stored hash, the attempt counter and the expiry. With no Redis there is
 * nothing to check against, and the only two options are "refuse" or "accept anything". It refuses,
 * and says the check is temporarily unavailable.
 */

/** Local, matching emailVerification.ts — the username is the only interpolated value and it is
 * user-controlled, so it never reaches the HTML body unescaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CODE_TTL_SEC = 15 * 60;
/**
 * Wrong guesses allowed before the code is burned.
 *
 * Six digits with six tries is a 6-in-a-million chance of a blind hit, which is the point of the
 * cap rather than the length. Generous enough to survive a genuine misread of a cramped font
 * (5/S, 1/7) without punishing someone who is doing their best.
 */
const MAX_ATTEMPTS = 6;
const RESEND_COOLDOWN_SEC = 60;

function codeKey(userId: string) {
  return `email-code:${userId}`;
}
function attemptsKey(userId: string) {
  return `email-code:attempts:${userId}`;
}
function cooldownKey(userId: string) {
  return `email-code:cooldown:${userId}`;
}

function hashCode(userId: string, code: string): string {
  // Keyed on the user id as well as the secret, so a hash lifted from one row cannot be replayed
  // against another account that happened to be issued the same six digits.
  return createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(`lumina-email-code-v1:${userId}:${code}`)
    .digest("base64url");
}

/** Uniform over 000000-999999. `randomInt` is rejection-sampled, so no modulo bias, and leading
 * zeros are preserved — "004321" is a perfectly good code and must not become "4321". */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type SendCodeOutcome = "sent" | "not-configured" | "failed" | "too-soon" | "already-verified";

export async function sendEmailCode(params: {
  userId: string;
  email: string;
  username: string;
  /** Sign-up sends unconditionally; a user-triggered resend has to pass the cooldown first. */
  enforceCooldown?: boolean;
}): Promise<SendCodeOutcome> {
  if (!mailConfigured()) return "not-configured";

  if (params.enforceCooldown) {
    try {
      // NX makes this an atomic claim rather than a read-then-write two clicks both win.
      const claimed = await redis.set(cooldownKey(params.userId), "1", "EX", RESEND_COOLDOWN_SEC, "NX");
      if (claimed === null) return "too-soon";
    } catch {
      /* Redis down — let the send through rather than blocking a legitimate request. */
    }
  }

  const code = generateCode();
  try {
    // Issuing a new code retires the previous one and its attempt count, so a resend genuinely
    // gives someone a clean slate rather than leaving them on a burnt counter.
    await redis.set(codeKey(params.userId), hashCode(params.userId, code), "EX", CODE_TTL_SEC);
    await redis.del(attemptsKey(params.userId));
  } catch {
    // Nothing to verify against later, so do not send digits that cannot possibly work.
    return "failed";
  }

  const minutes = Math.round(CODE_TTL_SEC / 60);
  const ok = await sendMail({
    to: params.email,
    subject: `${code} is your Lumina confirmation code`,
    text: [
      `Hi ${params.username},`,
      "",
      "Your Lumina confirmation code is:",
      "",
      code,
      "",
      `It expires in ${minutes} minutes.`,
      "",
      "If you didn't create a Lumina account, you can ignore this email — the code is useless on",
      "its own and the address will not be used again.",
    ].join("\n"),
    html: `
      <p style="margin:0 0 14px">Hi ${escapeHtml(params.username)},</p>
      <p style="margin:0 0 18px">Enter this code to confirm your email address:</p>
      <p style="margin:0 0 18px;font-size:34px;font-weight:700;letter-spacing:.22em;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(code)}</p>
      <p style="${MUTED_TEXT_STYLE};margin:0 0 12px">It expires in ${minutes} minutes.</p>
      <p style="${MUTED_TEXT_STYLE};margin:0">If you didn't create a Lumina account you can ignore
      this email — the code is useless on its own and this address will not be used again.</p>
    `,
  });
  return ok ? "sent" : "failed";
}

export async function resendEmailCode(userId: string): Promise<SendCodeOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, username: true, emailVerifiedAt: true },
  });
  if (!user) throw new BadRequestError("No such account");
  if (user.emailVerifiedAt) return "already-verified";
  return sendEmailCode({ userId, email: user.email, username: user.username, enforceCooldown: true });
}

export type VerifyCodeOutcome =
  | { ok: true; alreadyVerified: boolean }
  | { ok: false; reason: "invalid" | "expired" | "too-many-attempts" | "unavailable" };

export async function verifyEmailCode(userId: string, presented: string): Promise<VerifyCodeOutcome> {
  const code = presented.trim();
  // Shape-checked before anything else so junk never reaches the attempt counter — otherwise a
  // client bug sending an empty string on every render would burn a real person's six tries.
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (!user) throw new BadRequestError("No such account");
  if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };

  let stored: string | null;
  let attempts: number;
  try {
    stored = await redis.get(codeKey(userId));
    attempts = Number((await redis.get(attemptsKey(userId))) ?? 0);
  } catch {
    // See the header: with no Redis there is nothing to check against, and accepting anything
    // would be worse than making the person try again in a minute.
    return { ok: false, reason: "unavailable" };
  }

  if (stored === null) return { ok: false, reason: "expired" };
  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too-many-attempts" };

  const expected = Buffer.from(stored);
  const actual = Buffer.from(hashCode(userId, code));
  // Length-checked first: timingSafeEqual throws on a length mismatch instead of returning false.
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!match) {
    try {
      const next = await redis.incr(attemptsKey(userId));
      // Expire the counter alongside the code so a burnt count cannot outlive the code it guarded
      // and poison the next one.
      if (next === 1) await redis.expire(attemptsKey(userId), CODE_TTL_SEC);
      if (next >= MAX_ATTEMPTS) await redis.del(codeKey(userId));
    } catch {
      /* Counter unavailable — the wrong code is still refused, which is the part that matters. */
    }
    return { ok: false, reason: attempts + 1 >= MAX_ATTEMPTS ? "too-many-attempts" : "invalid" };
  }

  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  try {
    await redis.del(codeKey(userId), attemptsKey(userId));
  } catch {
    /* The address is confirmed in Postgres; a stale Redis key is harmless and expires by itself. */
  }
  return { ok: true, alreadyVerified: false };
}
