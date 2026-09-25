import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A token that lets one person decline one call without a session.
 *
 * The Decline button on a ringing phone lives in a notification, and a notification has no
 * signed-in session to speak with. So the server hands each person it rings a token bound to that
 * conversation and that person, good for a few minutes, and the phone posts it back when Decline is
 * tapped (android CallDeclineReceiver -> POST /api/voice/calls/decline). It can decline that one
 * call and nothing else: it is not a login, carries no other permission, and expires on its own.
 *
 * Shape: `<userId>.<expiresAtUnixSeconds>.<base64url HMAC-SHA256>` over
 * `call-decline:<conversationId>:<userId>:<expiresAt>`.
 */
export const DECLINE_TOKEN_TTL_SECONDS = 5 * 60;

function mac(secret: string, conversationId: string, userId: string, expiresAt: number): Buffer {
  return createHmac("sha256", secret).update(`call-decline:${conversationId}:${userId}:${expiresAt}`).digest();
}

export function signDeclineToken(secret: string, conversationId: string, userId: string, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + DECLINE_TOKEN_TTL_SECONDS;
  return `${userId}.${expiresAt}.${mac(secret, conversationId, userId, expiresAt).toString("base64url")}`;
}

/** The user the token speaks for, or null when it is malformed, forged, for another call, or expired. */
export function verifyDeclineToken(secret: string, conversationId: string, token: string, nowMs = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expiresAt = Number(exp);
  if (!userId || !Number.isInteger(expiresAt) || expiresAt < Math.floor(nowMs / 1000)) return null;
  const expected = mac(secret, conversationId, userId, expiresAt);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return userId;
}
