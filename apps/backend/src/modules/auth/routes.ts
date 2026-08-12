import type { FastifyInstance } from "fastify";
import type { PlatformRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { hashRefreshToken } from "../../lib/jwt.js";
import { signAccessToken } from "../../lib/jwt.js";
import { serializeMe, serializeSession } from "../../lib/serialize.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { env } from "../../config/env.js";
import {
  clearRefreshCookie,
  issueTokenPair,
  readDeviceFingerprint,
  readIncomingRefreshToken,
  sendTokenResponse,
} from "./service.js";
import { checkIdentifierBans } from "../bans/service.js";
import { BannedError, BadRequestError, BlockedError } from "../../lib/errors.js";
import { checkAge } from "../age/service.js";
import { hasPlatformRole } from "../../lib/platformRole.js";
import { requestCountry } from "../site/routes.js";
import { recordFlag, isSignupBlocked } from "../flags/service.js";
import { recordOriginFlag } from "../risk/service.js";
import {
  beginEnrolment,
  confirmEnrolment,
  disable as disableMfa,
  issueMfaTicket,
  redeemMfaTicket,
  status as mfaStatus,
  verifySecondFactor,
} from "./mfa.js";
import {
  requestResend as requestVerificationResend,
  sendVerificationEmail,
  verifyToken as verifyEmailToken,
} from "./emailVerification.js";
import {
  beginAuthentication as beginPasskeyAuthentication,
  beginRegistration as beginPasskeyRegistration,
  deletePasskey,
  finishAuthentication as finishPasskeyAuthentication,
  finishRegistration as finishPasskeyRegistration,
  listPasskeys,
} from "./passkeys.js";
import type { AgeBracket } from "@prisma/client";

// Registration logs the user in immediately and sends a confirmation email in the background.
// Verification currently gates NOTHING — see modules/auth/emailVerification.ts for why: every
// account predating it is unverified, so making it a requirement would lock out the whole user
// base on the day it shipped.

const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, "username may only contain letters, numbers, underscore"),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(64).optional(),
  // Both REQUIRED. These were briefly optional so older clients and test scripts kept working, and
  // that made the entire age gate bypassable by simply omitting a field — a request with no bracket
  // skipped the check and created the account regardless of the birth date. An age gate with an
  // opt-out is not an age gate.
  ageBracket: z.enum(["UNDER_18", "AGE_18_24", "AGE_25_34", "AGE_35_49", "AGE_50_PLUS"], {
    required_error: "Please select your age range",
  }),
  birthDate: z.string().min(1, "Please enter your date of birth"),
});

const loginSchema = z.object({
  // Trimmed: a pasted or autofilled identifier routinely carries a leading/trailing space, and
  // nobody has ever intended one. The password is deliberately NOT trimmed — whitespace can be a
  // real part of a password, and silently altering it would reject a correct one.
  emailOrUsername: z.string().min(1).transform((s) => s.trim()),
  password: z.string().min(1),
});

function parseEmailList(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Reconciles User.platformRole at login.
 *
 * Env is a FLOOR for staff/owner, not an absolute. It used to be absolute in both directions, which
 * quietly made the owner dashboard's grant button cosmetic: granting STAFF wrote to the database,
 * the user logged in to pick it up, and that very login demoted them again because their address
 * wasn't in STAFF_EMAILS. The only way to actually appoint anyone was editing .env and restarting.
 *
 * So:
 *   - MASTER stays env-anchored in BOTH directions. It is the security anchor — no API path can
 *     grant it, and an address removed from MASTER_EMAIL loses it on next login. Without that,
 *     compromising one account could mint a permanent master.
 *   - STAFF/OWNER are database-authoritative. Env promotes someone who is below the listed level
 *     (so bootstrapping still works and a fresh install can appoint its first owner), but never
 *     demotes — revoking is done in the dashboard, which is where it appears to be done.
 *
 * Comparison is case-insensitive and whitespace-tolerant because these are hand-edited in .env.
 */
async function reconcilePlatformRole<T extends { id: string; email: string; platformRole: PlatformRole }>(
  user: T,
): Promise<T> {
  const master = env.MASTER_EMAIL.trim().toLowerCase();
  const owners = parseEmailList(env.OWNER_EMAILS);
  // SITE_ADMIN_EMAILS is the old name for STAFF_EMAILS; both are read so renaming the var doesn't
  // silently strip access on the next deploy.
  const staff = [...parseEmailList(env.STAFF_EMAILS), ...parseEmailList(env.SITE_ADMIN_EMAILS)];
  const email = user.email.toLowerCase();

  const isEnvMaster = Boolean(master) && email === master;
  let target: PlatformRole = user.platformRole;

  if (isEnvMaster) {
    target = "MASTER";
  } else if (user.platformRole === "MASTER") {
    // Holds MASTER but is no longer the configured master — revoked here rather than left standing,
    // since MASTER is the one role the API can never re-grant.
    target = "USER";
  } else {
    // Env as a floor only. hasPlatformRole compares RANK, so someone the dashboard promoted to
    // OWNER is not pulled back down to STAFF just because that's what env lists.
    const envFloor: PlatformRole | null = owners.includes(email)
      ? "OWNER"
      : staff.includes(email)
        ? "STAFF"
        : null;
    if (envFloor && !hasPlatformRole(user.platformRole, envFloor)) target = envFloor;
  }

  if (target === user.platformRole) return user;
  await prisma.user.update({ where: { id: user.id }, data: { platformRole: target } });
  return { ...user, platformRole: target };
}

/** Throws a BannedError carrying the reason, expiry and appeal state if any identifier matches an
 * active ban. The banned person is told why and how to appeal — a bare "denied" gives someone with a
 * false-positive device or IP match no route back. */
async function assertNotBanned(params: {
  userId?: string;
  email?: string;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
}): Promise<void> {
  const result = await checkIdentifierBans(params);
  if (!result.banned) return;
  throw new BannedError({
    reason: result.reason ?? "Access denied",
    scope: result.scope ?? "ACCOUNT",
    expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
    banId: result.banId,
    appealStatus: result.appealStatus,
  });
}

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/register",
    {
      schema: { body: registerSchema },
      // Tighter than the app-wide 300/min default (see plugins/rateLimit.ts) — registration is
      // the one route where a flood is pure abuse (account-creation spam), no legitimate client
      // ever needs anywhere near this often. Keyed by IP (the plugin's own default keyGenerator).
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
    const body = request.body as z.infer<typeof registerSchema>;

    // A device that recently attempted an under-age signup is barred from creating another account
    // for a while. Checked before anything else so a retry with a different birthday goes nowhere.
    const fingerprint = readDeviceFingerprint(request);
    const cooldown = await isSignupBlocked(fingerprint);
    if (cooldown.blocked) throw new BlockedError(cooldown.reasonCode!);

    // Ban evasion is attempted at signup more than anywhere else, so identifiers are checked before
    // an account exists at all — matching on email, IP and device fingerprint.
    await assertNotBanned({
      email: body.email,
      ipAddress: request.ip,
      deviceFingerprint: fingerprint,
    });

    // Case-insensitive too, and not merely for symmetry: login now resolves an identifier without
    // regard to case, so allowing "Alice" alongside "alice" would make that lookup ambiguous and
    // hand one person's login attempt to the other's account. Two accounts differing only by case
    // are also indistinguishable to a human reading a mention.
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: body.email, mode: "insensitive" } },
          { username: { equals: body.username, mode: "insensitive" } },
        ],
      },
    });
    if (existing) {
      throw new ConflictError("Email or username already in use");
    }

    // Age check runs before the account exists, so a blocked signup never creates a row it would
    // then have to clean up. No conditional — both fields are required by the schema above, so
    // there is no path through registration that skips this.
    const birthDate = new Date(body.birthDate);
    if (Number.isNaN(birthDate.getTime())) throw new BadRequestError("That date of birth isn't valid");
    // A date in the future, or absurdly far past, is a typo rather than an age — rejected here so
    // it can't produce a nonsensical bracket.
    const yearsAgo = (Date.now() - birthDate.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (yearsAgo < 0 || yearsAgo > 120) throw new BadRequestError("That date of birth isn't valid");

    const result = checkAge(body.ageBracket, birthDate);
    if (!result.ok) {
      await recordFlag({
        email: body.email,
        ipAddress: request.ip,
        deviceFingerprint: fingerprint,
        reasonCode: result.reasonCode,
        detail: `selected=${body.ageBracket} derived=${result.bracket}`,
      });
      throw new BlockedError(result.reasonCode);
    }
    const ageData = {
      ageBracket: result.bracket,
      birthDate,
      isMinor: result.isMinor,
      ageRecordedAt: new Date(),
    };

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        username: body.username,
        email: body.email,
        passwordHash,
        displayName: body.displayName ?? null,
        signupCountry: requestCountry(request),
        ...ageData,
      },
    });

      // Fire-and-forget, severity INFO: using a VPN is not misconduct, and this is only ever
      // context for a later decision. Never awaited — a signup must not get slower, or fail,
      // because a reputation lookup was slow.
      void recordOriginFlag(request, { userId: user.id, email: user.email });
      // Fire-and-forget: a slow or unreachable SMTP server must never make signup slow or fail.
      // The account exists and works either way — the email only confirms the address.
      void sendVerificationEmail({ userId: user.id, email: user.email, username: user.username });

      const tokens = await issueTokenPair(user.id, request);
      reply.code(201);
      sendTokenResponse(reply, request, serializeMe(user), tokens);
    },
  );

  fastify.post(
    "/login",
    {
      schema: { body: loginSchema },
      // Keyed by IP+username combo (not IP alone) — a flat per-IP limit would let one attacker
      // lock every legitimate user behind the same NAT/office/mobile-carrier IP out of login by
      // just hammering a made-up username from that IP. Slows credential stuffing against any
      // ONE account without collaterally rate-limiting everyone else sharing the attacker's IP.
      // hook: "preHandler" (not the plugin's default "onRequest") so request.body is already
      // parsed by the time this keyGenerator runs.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (request) => {
            const body = request.body as { emailOrUsername?: string } | undefined;
            return `${request.ip}:${body?.emailOrUsername ?? ""}`;
          },
        },
      },
    },
    async (request, reply) => {
    const body = request.body as z.infer<typeof loginSchema>;

    // Case-insensitive on BOTH fields. This was an exact match, which meant a phone keyboard
    // auto-capitalising the first letter turned a correct password into "Invalid credentials" —
    // the master account was locked out of the live site this way, and every mobile user was
    // exposed to it. Emails are case-insensitive by specification anyway, and usernames are
    // display-cased here (104 accounts contain uppercase) but must not be a login trap.
    // Registration below rejects case-duplicates, so this cannot match the wrong account.
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: body.emailOrUsername, mode: "insensitive" } },
          { username: { equals: body.emailOrUsername, mode: "insensitive" } },
        ],
      },
    });
    // Bot accounts have no real password (see modules/applications/service.ts) — reject before
    // even touching verifyPassword, belt-and-suspenders alongside the unusable hash itself.
    // Login diagnostics.
    //
    // The response deliberately says only "Invalid credentials" — telling a stranger whether an
    // account exists is an enumeration oracle. But the *operator* has to be able to tell the two
    // apart, because "no such user" and "wrong password" have completely different fixes, and
    // without this the only way to tell was to guess. Logged at warn so it survives the
    // production log level.
    //
    // The password itself is never logged, in any form. Its length and whether it has edge
    // whitespace are recorded because a pasted credential that picked up a trailing space or
    // newline is the single most common cause of "but I copied it exactly".
    const pwShape = {
      pwLen: body.password.length,
      pwEdgeWhitespace: body.password !== body.password.trim(),
    };

    if (!user || user.isBot) {
      request.log.warn(
        {
          event: "login_rejected",
          reason: user?.isBot ? "bot_account" : "no_such_user",
          identifier: body.emailOrUsername,
          identifierLen: body.emailOrUsername.length,
          ip: request.ip,
          ...pwShape,
        },
        "login rejected",
      );
      throw new UnauthorizedError("Invalid credentials");
    }

    const valid = await verifyPassword(user.passwordHash, body.password);
    if (!valid) {
      request.log.warn(
        {
          event: "login_rejected",
          reason: "wrong_password",
          username: user.username,
          identifier: body.emailOrUsername,
          ip: request.ip,
          ...pwShape,
        },
        "login rejected",
      );
      throw new UnauthorizedError("Invalid credentials");
    }

    request.log.warn(
      { event: "login_ok", username: user.username, ip: request.ip },
      "login succeeded",
    );

    // Checked only after the password verifies, so this can never be used as an oracle to discover
    // whether some other person's email or IP is banned.
    await assertNotBanned({
      userId: user.id,
      email: user.email,
      ipAddress: request.ip,
      deviceFingerprint: readDeviceFingerprint(request),
    });

      void recordOriginFlag(request, { userId: user.id, email: user.email });

      // Second factor, if this account has one. No session is issued here — the response carries a
      // short-lived ticket instead, and /login/verify-mfa exchanges the ticket plus a code for the
      // real tokens. Returning tokens now and "requiring" the code afterwards would be theatre:
      // the client already holds everything it needs to make authenticated calls.
      const mfa = await mfaStatus(user.id);
      if (mfa.enabled) {
        reply.code(200);
        return {
          mfaRequired: true,
          mfaTicket: await issueMfaTicket(user.id),
          backupCodesRemaining: mfa.backupCodesRemaining,
        };
      }

      const reconciled = await reconcilePlatformRole(user);
      const tokens = await issueTokenPair(user.id, request);
      sendTokenResponse(reply, request, serializeMe(reconciled), tokens);
    },
  );

  /**
   * Step two of a 2FA login: ticket + code in exchange for a session.
   *
   * Rate limited on its own budget. The password gate is already behind a per-IP+username limit,
   * but this endpoint takes a six-digit number — the one place in the app where brute force is
   * arithmetically plausible — so it gets a tighter one, on top of the per-user attempt counter in
   * the service that survives an attacker rotating IPs.
   */
  fastify.post(
    "/login/verify-mfa",
    {
      schema: {
        body: z.object({ mfaTicket: z.string().min(1), code: z.string().min(1).max(32) }),
      },
      config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const body = request.body as { mfaTicket: string; code: string };

      const userId = await redeemMfaTicket(body.mfaTicket);
      if (!userId) {
        throw new UnauthorizedError("That sign-in attempt expired. Start again.");
      }

      if (!(await verifySecondFactor(userId, body.code))) {
        request.log.warn({ event: "mfa_rejected", userId, ip: request.ip }, "second factor rejected");
        throw new UnauthorizedError("That code isn't right.");
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new UnauthorizedError("Invalid credentials");

      // Re-checked here rather than trusted from step one: a ban can land in the minutes between
      // the two steps, and the ticket must not be a way to walk past it.
      await assertNotBanned({
        userId: user.id,
        email: user.email,
        ipAddress: request.ip,
        deviceFingerprint: readDeviceFingerprint(request),
      });

      const reconciled = await reconcilePlatformRole(user);
      const tokens = await issueTokenPair(user.id, request);
      sendTokenResponse(reply, request, serializeMe(reconciled), tokens);
    },
  );

  // ---- managing your own second factor -------------------------------------------------------

  // ---- email verification ----------------------------------------------------------------------

  /**
   * Redeems a link from the verification email.
   *
   * Unauthenticated on purpose: the link is often opened on a different device from the one that
   * signed up, and requiring a session would make it fail exactly where it is most needed. The
   * token's signature is the authentication.
   */
  fastify.post(
    "/verify-email",
    {
      schema: { body: z.object({ token: z.string().min(1) }) },
      config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
    },
    async (request) => {
      const { token } = request.body as { token: string };
      await verifyEmailToken(token);
      return { verified: true };
    },
  );

  fastify.post("/verify-email/resend", { preHandler: [requireAuth] }, async (request) => {
    const result = await requestVerificationResend(request.userId!);
    if (result === "too-soon") {
      throw new BadRequestError("A link was just sent — check your inbox, including spam.");
    }
    if (result === "not-configured") {
      // Told plainly rather than pretending to have sent something. An operator running without a
      // mail server needs to know that, and a user waiting for an email that will never arrive
      // needs it more.
      throw new BadRequestError("This server has no mail server configured, so it can't send email.");
    }
    if (result === "failed") throw new BadRequestError("Couldn't send the email. Try again shortly.");
    return { sent: result === "sent", alreadyVerified: result === "already-verified" };
  });

  // ---- passkeys (biometric sign-in) ----------------------------------------------------------

  fastify.get("/passkeys", { preHandler: [requireAuth] }, async (request) =>
    listPasskeys(request.userId!),
  );

  fastify.post("/passkeys/begin", { preHandler: [requireAuth] }, async (request) =>
    beginPasskeyRegistration(request.userId!),
  );

  fastify.post("/passkeys/finish", { preHandler: [requireAuth] }, async (request) => {
    const body = request.body as { response: never; label?: string };
    return finishPasskeyRegistration(request.userId!, body.response, body.label);
  });

  fastify.delete("/passkeys/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deletePasskey(request.userId!, decodeURIComponent(id));
    reply.code(204);
  });

  /** Step one of a passkey sign-in. Unauthenticated by definition — this is the sign-in. */
  fastify.post(
    "/passkeys/login/begin",
    { config: { rateLimit: { max: 30, timeWindow: "5 minutes" } } },
    async () => beginPasskeyAuthentication(),
  );

  fastify.post(
    "/passkeys/login/finish",
    { config: { rateLimit: { max: 30, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = request.body as { handle: string; response: never };
      if (!body?.handle || !body?.response) throw new BadRequestError("Malformed passkey response");

      const userId = await finishPasskeyAuthentication(body.handle, body.response);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new UnauthorizedError("Invalid credentials");

      // Every gate the password path applies, applied here too. A passkey proves possession of a
      // device, not that the account is allowed in — skipping these would make enrolling a passkey
      // a way to walk straight past a ban.
      await assertNotBanned({
        userId: user.id,
        email: user.email,
        ipAddress: request.ip,
        deviceFingerprint: readDeviceFingerprint(request),
      });
      void recordOriginFlag(request, { userId: user.id, email: user.email });

      // No second factor prompt: a platform passkey already required the device's biometric or PIN,
      // so demanding a TOTP code on top is asking for two factors the user has just provided one
      // stronger form of. This mirrors how every major platform treats passkeys.
      const reconciled = await reconcilePlatformRole(user);
      const tokens = await issueTokenPair(user.id, request);
      sendTokenResponse(reply, request, serializeMe(reconciled), tokens);
    },
  );

  fastify.get("/mfa", { preHandler: [requireAuth] }, async (request) => mfaStatus(request.userId!));

  fastify.post("/mfa/begin", { preHandler: [requireAuth] }, async (request) =>
    beginEnrolment(request.userId!),
  );

  fastify.post(
    "/mfa/confirm",
    {
      schema: { body: z.object({ code: z.string().min(6).max(10) }) },
      preHandler: [requireAuth],
    },
    async (request) => {
      const { code } = request.body as { code: string };
      // Shown exactly once. Never stored in readable form, never retrievable again — same handling
      // as bot tokens and generated staff passwords elsewhere in this codebase.
      return { backupCodes: await confirmEnrolment(request.userId!, code) };
    },
  );

  fastify.post(
    "/mfa/disable",
    {
      schema: { body: z.object({ password: z.string().min(1) }) },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { password } = request.body as { password: string };
      await disableMfa(request.userId!, password);
      reply.code(204);
    },
  );

  fastify.post("/refresh", async (request, reply) => {
    const incoming = readIncomingRefreshToken(request);
    if (!incoming) throw new UnauthorizedError("Missing refresh token");

    const tokenHash = hashRefreshToken(incoming);
    const row = await prisma.refreshToken.findFirst({
      where: { tokenHash, revokedAt: null },
    });

    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("Refresh token invalid or expired");
    }

    // Rotate: revoke the old row, issue + persist a new one.
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });

    const user = await prisma.user.findUnique({ where: { id: row.userId } });
    if (!user) throw new UnauthorizedError("User no longer exists");

    const tokens = await issueTokenPair(user.id, request);
    sendTokenResponse(reply, request, serializeMe(user), tokens);
  });

  fastify.post("/logout", async (request, reply) => {
    const incoming = readIncomingRefreshToken(request);
    if (incoming) {
      const tokenHash = hashRefreshToken(incoming);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    clearRefreshCookie(reply);
    reply.code(204).send();
  });

  fastify.get("/me", { preHandler: [requireAuth] }, async (request) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId! } });
    if (!user) throw new UnauthorizedError("User no longer exists");
    return serializeMe(user);
  });

  // Session/device management (RefreshToken already had userAgent/ipAddress/revokedAt with no
  // routes surfacing them at all). Mounted under /api/auth (not /api/users/me) specifically so
  // the web client's httpOnly refresh cookie — scoped to REFRESH_COOKIE_PATH = "/api/auth" — is
  // actually sent along, which is what lets "isCurrent" be determined at all for that client.
  fastify.get("/sessions", { preHandler: [requireAuth] }, async (request) => {
    const incoming = readIncomingRefreshToken(request);
    const currentHash = incoming ? hashRefreshToken(incoming) : null;

    const sessions = await prisma.refreshToken.findMany({
      where: { userId: request.userId!, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    return sessions.map((s) => serializeSession(s, currentHash !== null && s.tokenHash === currentHash));
  });

  fastify.delete("/sessions/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await prisma.refreshToken.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) throw new NotFoundError("Session not found");

    await prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
    reply.code(204).send();
  });

  fastify.post("/sessions/revoke-others", { preHandler: [requireAuth] }, async (request, reply) => {
    const incoming = readIncomingRefreshToken(request);
    const currentHash = incoming ? hashRefreshToken(incoming) : null;

    await prisma.refreshToken.updateMany({
      where: {
        userId: request.userId!,
        revokedAt: null,
        ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    reply.code(204).send();
  });
}

// exported for potential reuse (not required outside module, but keeps a
// single source of truth for signing access tokens post-refresh available
// to tests without re-importing lib/jwt directly).
export { signAccessToken };
