import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { env } from "../../config/env.js";
import { BadRequestError, UnauthorizedError } from "../../lib/errors.js";

/**
 * Passkeys — biometric sign-in via WebAuthn.
 *
 * ## What this actually gives you
 *
 * Face ID on the iPhone home-screen app, fingerprint on Android Chrome, Windows Hello or Touch ID
 * on desktop. It matters most on iOS, where a PWA is the only shippable form of the app and this is
 * the only route to biometric sign-in there.
 *
 * It is also, unlike a password, **phishing-resistant**: the browser refuses to use a credential on
 * any origin other than the one it was created for, so a convincing copy of the login page at some
 * other domain gets nothing. That property comes from the RP ID check below, not from the biometric
 * — the fingerprint only unlocks the private key locally. Worth being precise about, because
 * "biometric login" is often assumed to send a fingerprint somewhere. Nothing biometric ever leaves
 * the device.
 *
 * ## Relying Party ID
 *
 * `rpID` must be the registrable domain of the origin the browser is on, and the browser enforces
 * it. `lumina.badgerstudios.net` is derived from PUBLIC_APP_URL rather than hardcoded, so a
 * self-hosted instance on another domain works without a code change.
 *
 * The alias `lumina.luxffa.com` therefore **cannot** share credentials with the primary domain —
 * WebAuthn scopes a passkey to one registrable domain, by design, and there is no way around that.
 * A passkey enrolled on one host simply will not be offered on the other. Same reason the Capacitor
 * WebView cannot use this at all: its origin is `capacitor://localhost`, which can never match.
 */

function rpConfig() {
  // PUBLIC_APP_URL is set from CORS_ORIGIN, which is a COMMA-SEPARATED LIST of every origin this
  // instance answers on:
  //
  //   https://lumina.badgerstudios.net,https://lumina.luxffa.com,https://localhost,capacitor://localhost,...
  //
  // `new URL()` on that whole string does not throw — it parses it into a hostname of
  // "lumina.badgerstudios.net,https", which the browser then rejects with "The RP ID ... is invalid
  // for this domain". Silent on the server, fatal in the client. Take the first entry only.
  const origins = env.PUBLIC_APP_URL.split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // The first https:// origin is the canonical one; localhost and capacitor:// entries are for
  // local dev and the native shells and can never be a valid relying party.
  const primary = origins.find((o) => o.startsWith("https://") && !o.includes("localhost")) ?? origins[0];
  const url = new URL(primary);

  return {
    // Hostname only, no port and no scheme — WebAuthn rejects anything else.
    rpID: url.hostname,
    rpName: "Lumina",
    // The full origin, which the browser signs over and the library checks byte-for-byte.
    //
    // Only ONE origin can be the relying party. A passkey enrolled on lumina.badgerstudios.net is
    // simply not offered on lumina.luxffa.com — WebAuthn binds a credential to one registrable
    // domain by design, and that is the property that makes it phishing-resistant. Users on the
    // alias domain see no passkey button rather than a broken one.
    expectedOrigin: url.origin,
  };
}

/**
 * Challenges live in Redis, not in a signed cookie or the client's hands.
 *
 * A WebAuthn challenge is single-use and must be unguessable — its whole job is proving the
 * assertion is fresh rather than replayed. Storing it server-side means it can be *deleted* on use,
 * which a stateless token cannot be.
 */
const CHALLENGE_TTL_SEC = 5 * 60;

async function putChallenge(key: string, challenge: string): Promise<void> {
  await redis.set(`webauthn:${key}`, challenge, "EX", CHALLENGE_TTL_SEC);
}

async function takeChallenge(key: string): Promise<string | null> {
  const redisKey = `webauthn:${key}`;
  const value = await redis.get(redisKey);
  if (value) await redis.del(redisKey);
  return value;
}

// ---- registration ----------------------------------------------------------------------------

export async function beginRegistration(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, displayName: true },
  });
  if (!user) throw new UnauthorizedError("Not signed in");

  const existing = await prisma.passkey.findMany({
    where: { userId },
    select: { id: true, transports: true },
  });

  const { rpID, rpName } = rpConfig();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userDisplayName: user.displayName ?? user.username,
    // Prevents enrolling the same authenticator twice — the browser greys it out rather than
    // creating a duplicate the user then cannot tell apart in their list.
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports ? (JSON.parse(c.transports) as never) : undefined,
    })),
    authenticatorSelection: {
      // "preferred" rather than "required": a device with no biometric or PIN can still enrol and
      // fall back to whatever it has. Requiring it turns "set up Face ID" into a dead end on
      // hardware that cannot comply.
      userVerification: "preferred",
      // Steers toward the built-in authenticator (Face ID / Hello / fingerprint) rather than a
      // USB key, which is what people mean by "biometric login".
      authenticatorAttachment: "platform",
      residentKey: "preferred",
    },
    // No attestation: it would let the server identify the exact authenticator model, which is a
    // privacy cost with no benefit to a self-hosted chat app.
    attestationType: "none",
  });

  await putChallenge(`reg:${userId}`, options.challenge);
  return options;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  label?: string,
) {
  const expectedChallenge = await takeChallenge(`reg:${userId}`);
  if (!expectedChallenge) throw new BadRequestError("That setup attempt expired. Try again.");

  const { rpID, expectedOrigin } = rpConfig();
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new BadRequestError("That passkey couldn't be verified");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await prisma.passkey.create({
    data: {
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      label: label?.slice(0, 60) || null,
    },
  });

  return { verified: true };
}

// ---- authentication --------------------------------------------------------------------------

/**
 * Options for signing in.
 *
 * Deliberately supports the **usernameless** flow: with no identifier supplied, the browser offers
 * whichever passkeys it holds for this domain. That is the good version of this feature — tap the
 * button, look at the phone, you are in — and it is why `residentKey: "preferred"` is set above.
 *
 * The challenge is keyed by a random handle returned to the caller rather than by user id, because
 * at this point there is no authenticated user to key it by, and keying by a client-supplied
 * username would let anyone overwrite another person's pending challenge.
 */
export async function beginAuthentication(): Promise<{ handle: string; options: unknown }> {
  const { rpID } = rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
  });

  const handle = crypto.randomUUID();
  await putChallenge(`auth:${handle}`, options.challenge);
  return { handle, options };
}

export async function finishAuthentication(
  handle: string,
  response: AuthenticationResponseJSON,
): Promise<string> {
  const expectedChallenge = await takeChallenge(`auth:${handle}`);
  if (!expectedChallenge) throw new UnauthorizedError("That sign-in attempt expired. Try again.");

  const passkey = await prisma.passkey.findUnique({ where: { id: response.id } });
  if (!passkey) throw new UnauthorizedError("Unrecognised passkey");

  const { rpID, expectedOrigin } = rpConfig();
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: Number(passkey.counter),
      transports: passkey.transports ? (JSON.parse(passkey.transports) as never) : undefined,
    },
    requireUserVerification: false,
  });

  if (!verification.verified) throw new UnauthorizedError("That passkey couldn't be verified");

  const newCounter = BigInt(verification.authenticationInfo.newCounter);
  // A counter that fails to advance means the credential has been cloned — the one thing this
  // number exists to detect. Exempt when both are zero: Apple's authenticators never implement the
  // counter and report 0 forever, so enforcing it strictly would reject every iPhone.
  if (passkey.counter > 0n && newCounter <= passkey.counter) {
    throw new UnauthorizedError("That passkey looks cloned and has been refused");
  }

  await prisma.passkey.update({
    where: { id: passkey.id },
    data: { counter: newCounter, lastUsedAt: new Date() },
  });

  return passkey.userId;
}

// ---- management ------------------------------------------------------------------------------

export async function listPasskeys(userId: string) {
  const keys = await prisma.passkey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      deviceType: true,
      backedUp: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  return keys.map((k) => ({
    ...k,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function deletePasskey(userId: string, id: string): Promise<void> {
  // Scoped by userId as well as id, so a guessed credential id cannot delete someone else's key.
  const result = await prisma.passkey.deleteMany({ where: { id, userId } });
  if (result.count === 0) throw new BadRequestError("No such passkey");
}
