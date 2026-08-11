import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiryDate,
  signAccessToken,
} from "../../lib/jwt.js";

export const REFRESH_COOKIE_NAME = "lumina_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";

// "mobile" (Capacitor WebView) and "desktop" (Electron) both load the app from an origin that
// shares no cookie jar with the API (capacitor://localhost / file:// vs. the API's https://
// origin) — same problem, same fix: the refresh token travels in the JSON body instead of an
// httpOnly cookie. Plain web is the only client type with a real same-origin/proxied setup.
export function usesBodyRefreshToken(request: FastifyRequest): boolean {
  const header = request.headers["x-client-type"];
  const value = Array.isArray(header) ? header[0] : header;
  const v = value?.toLowerCase();
  return v === "mobile" || v === "desktop";
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Reads the client-computed device fingerprint header (see frontend lib/deviceFingerprint.ts).
 *
 * Bounded to 128 chars because it is attacker-controlled input on an unauthenticated route — an
 * unbounded header would otherwise be a free way to write arbitrarily large rows.
 */
export function readDeviceFingerprint(request: FastifyRequest): string | null {
  const raw = request.headers["x-device-fingerprint"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 128);
  return trimmed || null;
}

export async function issueTokenPair(userId: string, request: FastifyRequest): Promise<IssuedTokens> {
  const accessToken = signAccessToken(userId);
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);
  const expiresAt = refreshTokenExpiryDate();

  const userAgentHeader = request.headers["user-agent"];

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: userAgentHeader ?? null,
      ipAddress: request.ip ?? null,
      // Recorded per session because a RefreshToken row already IS "one device this account is
      // signed in on" — this is what lets a platform ban cover the machine, not just the account.
      // Client-supplied and therefore trivially forgeable; it raises the cost of casual ban evasion
      // and is never treated as proof of identity.
      deviceFingerprint: readDeviceFingerprint(request),
    },
  });

  return { accessToken, refreshToken };
}

/**
 * Sends the token pair in the transport appropriate to the client: mobile
 * clients get the refresh token in the JSON body (no server-side cookie
 * store on-device), web clients get it as an httpOnly cookie scoped to
 * /api/auth so it never rides along on unrelated requests.
 *
 * NOTE: `secure` is gated on NODE_ENV=production. In production this is
 * always true per spec (httpOnly + Secure + SameSite=Lax). In local dev over
 * plain HTTP we relax `secure` so cookie-jar based smoke tests (curl -c/-b)
 * can exercise the refresh-rotation flow without standing up TLS.
 */
export function sendTokenResponse(
  reply: FastifyReply,
  request: FastifyRequest,
  userDto: unknown,
  tokens: IssuedTokens,
): void {
  if (usesBodyRefreshToken(request)) {
    reply.send({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: userDto });
    return;
  }

  reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    maxAge: 60 * 60 * 24 * 30,
  });
  reply.send({ accessToken: tokens.accessToken, user: userDto });
}

export function readIncomingRefreshToken(request: FastifyRequest): string | undefined {
  if (usesBodyRefreshToken(request)) {
    const body = request.body as { refreshToken?: string } | undefined;
    return body?.refreshToken;
  }
  return request.cookies?.[REFRESH_COOKIE_NAME];
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}
