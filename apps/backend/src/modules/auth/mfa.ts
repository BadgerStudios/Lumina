import { createHash } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import {
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateSecret,
  normaliseBackupCode,
  otpauthURI,
  verifyCode,
} from "../../lib/totp.js";
import { redis } from "../../db/redis.js";
import { BadRequestError, UnauthorizedError } from "../../lib/errors.js";

/**
 * Enrolment and verification for TOTP two-factor auth.
 *
 * ## The enrolment order, and why it is this way round
 *
 * A secret is generated and stored **before** it is confirmed, but `totpEnabledAt` stays null until
 * the user proves they can produce a code from it. That ordering matters: enabling on generation
 * would lock out anyone whose authenticator app failed to scan, or who closed the page — the
 * account would demand a second factor the user cannot produce. Requiring proof first means a
 * failed enrolment leaves the account exactly as it was.
 *
 * ## Rate limiting lives here, not only in the route
 *
 * Six digits is a million possibilities, and the acceptance window spans three 30-second steps.
 * Unlimited guessing against a single account is therefore genuinely feasible, so attempts are
 * counted in Redis per user and refused past a threshold. This is deliberately in the service, not
 * the HTTP layer — the login and the settings path both reach it, and a limit applied at only one
 * of them protects only one of them.
 */

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_SEC = 15 * 60;

function attemptKey(userId: string) {
  return `mfa:attempts:${userId}`;
}

async function recordAttempt(userId: string): Promise<number> {
  try {
    const key = attemptKey(userId);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ATTEMPT_WINDOW_SEC);
    return count;
  } catch {
    // Redis down. Returning 0 fails OPEN, which is the right call for a *second* factor: the
    // password has already been verified by this point, so the alternative is locking every 2FA
    // user out of their account whenever the cache hiccups.
    return 0;
  }
}

async function clearAttempts(userId: string): Promise<void> {
  try {
    await redis.del(attemptKey(userId));
  } catch {
    /* nothing to do */
  }
}

async function assertNotThrottled(userId: string): Promise<void> {
  try {
    const raw = await redis.get(attemptKey(userId));
    if (raw && Number(raw) >= MAX_ATTEMPTS) {
      throw new UnauthorizedError(
        "Too many incorrect codes. Wait 15 minutes, or sign in with a backup code.",
      );
    }
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
  }
}

export interface EnrolmentChallenge {
  secret: string;
  otpauthURI: string;
}

/** Step one: mint a secret and hand back the URI to render as a QR code. Not yet in force. */
export async function beginEnrolment(userId: string): Promise<EnrolmentChallenge> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, email: true, totpEnabledAt: true },
  });
  if (!user) throw new UnauthorizedError("Not signed in");
  if (user.totpEnabledAt) {
    throw new BadRequestError("Two-factor authentication is already on for this account");
  }

  const secret = generateSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: encryptSecret(secret) },
  });

  return {
    secret,
    // The account label is the username rather than the email: it is what shows in the
    // authenticator app's list, and an email address there discloses more than needed to anyone
    // glancing at the phone.
    otpauthURI: otpauthURI({ secret, accountName: user.username }),
  };
}

/** Step two: prove the app works, and only then turn it on. Returns the backup codes, once. */
export async function confirmEnrolment(userId: string, token: string): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabledAt: true },
  });
  if (!user?.totpSecret) throw new BadRequestError("Start setup again");
  if (user.totpEnabledAt) throw new BadRequestError("Two-factor authentication is already on");

  const secret = decryptSecret(user.totpSecret);
  if (!secret) throw new BadRequestError("Start setup again");

  await assertNotThrottled(userId);
  if (!verifyCode({ token, secret })) {
    await recordAttempt(userId);
    throw new BadRequestError("That code isn't right. Check your authenticator app and try again.");
  }
  await clearAttempts(userId);

  const codes = generateBackupCodes();
  // Enabling and writing the codes in one transaction: an account marked 2FA-enabled with no
  // recovery codes is one lost phone away from being permanently inaccessible.
  await prisma.$transaction([
    prisma.totpBackupCode.deleteMany({ where: { userId } }),
    prisma.totpBackupCode.createMany({
      data: await Promise.all(
        codes.map(async (code) => ({ userId, codeHash: await hashPassword(normaliseBackupCode(code)) })),
      ),
    }),
    prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } }),
  ]);

  return codes;
}

/**
 * Turning it off requires the password again.
 *
 * Without that, anyone who walks up to an unlocked, already-signed-in session can remove the second
 * factor in two taps — which would make the whole feature decorative against the exact threat it
 * exists for.
 */
export async function disable(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) throw new UnauthorizedError("Not signed in");
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new UnauthorizedError("That password isn't right");
  }

  await prisma.$transaction([
    prisma.totpBackupCode.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabledAt: null },
    }),
  ]);
}

export interface MfaStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

export async function status(userId: string): Promise<MfaStatus> {
  const [user, remaining] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } }),
    prisma.totpBackupCode.count({ where: { userId, usedAt: null } }),
  ]);
  return { enabled: Boolean(user?.totpEnabledAt), backupCodesRemaining: remaining };
}

/**
 * Verifies the second factor at login, accepting either a TOTP code or a backup code.
 *
 * A backup code is consumed on use — checked by marking `usedAt` rather than deleting the row, so
 * "you have three codes left" stays answerable and a support question about a used code has an
 * answer.
 */
export async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
  await assertNotThrottled(userId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabledAt: true },
  });
  if (!user?.totpEnabledAt || !user.totpSecret) return true; // 2FA not on: nothing to verify.

  const secret = decryptSecret(user.totpSecret);
  if (secret && verifyCode({ token: code, secret })) {
    await clearAttempts(userId);
    return true;
  }

  // Backup codes are compared against Argon2 hashes, so every unused code must be checked in turn —
  // there is no way to look one up by value, which is the point of hashing them.
  const normalised = normaliseBackupCode(code);
  if (normalised.length === 10) {
    const candidates = await prisma.totpBackupCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });
    for (const candidate of candidates) {
      if (await verifyPassword(candidate.codeHash, normalised)) {
        await prisma.totpBackupCode.update({
          where: { id: candidate.id },
          data: { usedAt: new Date() },
        });
        await clearAttempts(userId);
        return true;
      }
    }
  }

  await recordAttempt(userId);
  return false;
}

/**
 * A short-lived ticket proving the password step succeeded, so the second step does not have to
 * carry the password again.
 *
 * Held in Redis rather than issued as a JWT: it must be revocable the instant it is spent, and a
 * stateless token cannot be. Five minutes is long enough to fetch a phone and short enough that a
 * ticket left on a shared screen expires before it is useful.
 */
const TICKET_TTL_SEC = 5 * 60;

export async function issueMfaTicket(userId: string): Promise<string> {
  const ticket = createHash("sha256")
    .update(`${userId}:${Date.now()}:${Math.random()}`)
    .digest("base64url");
  await redis.set(`mfa:ticket:${ticket}`, userId, "EX", TICKET_TTL_SEC);
  return ticket;
}

export async function redeemMfaTicket(ticket: string): Promise<string | null> {
  const key = `mfa:ticket:${ticket}`;
  const userId = await redis.get(key);
  if (!userId) return null;
  // Deleted on redemption, not on success: a ticket is one attempt at the second step. Leaving it
  // alive after a wrong code would turn the 15-minute throttle into an inconvenience rather than a
  // limit, since an attacker could keep reusing the same ticket.
  await redis.del(key);
  return userId;
}
