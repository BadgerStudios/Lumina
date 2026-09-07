import type { FastifyRequest } from "fastify";
import { verifyAccessToken } from "./jwt.js";
import { UnauthorizedError } from "./errors.js";

/**
 * The web client's access token also travels as an httpOnly cookie, scoped to /api, read ONLY by
 * extractMediaUserId below. Set beside the refresh cookie in modules/auth/service.ts
 * sendTokenResponse; every other route still demands the Bearer header, so a cross-site request
 * that happens to carry this cookie can at most stream media its owner could already see.
 */
export const MEDIA_COOKIE_NAME = "lumina_media";
export const MEDIA_COOKIE_PATH = "/api";

/**
 * Authenticates a media-serving request — a route whose URL is consumed directly by a native
 * browser element. `<img src>`, `<video src>` and `<a href>` cannot attach a custom header, so
 * gating these routes on `requireAuth` alone made every attachment permanently unloadable (silent
 * 401 → broken-image icon). That was the real bug behind "uploading is broken" — uploads and sends
 * both worked; the file simply could never be fetched back.
 *
 * The same access token, same short TTL, accepted from three places:
 *   1. `Authorization: Bearer` — API, bot and fetch callers.
 *   2. `?token=` — the native apps. Capacitor's and Electron's WebViews load from an origin that
 *      shares no cookie jar with the API (see usesBodyRefreshToken), so the URL is the only
 *      channel they have. Checked before the cookie so a still-cached older web bundle, which
 *      appends the token it holds, keeps behaving exactly as it did.
 *   3. the `lumina_media` cookie — the web client. A token in a URL ends up wherever URLs go:
 *      cloudflared writes the full request URL to its log on every client-cancelled stream, so
 *      each scrubbed-through video used to leave 15 minutes of account access in journald. The
 *      web build no longer puts the token in the URL at all; the browser sends this cookie on
 *      its own. Natives are the remaining gap, closed once they have a media-scoped token.
 *
 * Lives here rather than in modules/uploads so the video playback/thumbnail routes share one
 * implementation with attachments instead of copying it and letting the two drift.
 */
export function extractMediaUserId(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  const cookieToken = request.cookies?.[MEDIA_COOKIE_NAME];
  const token = bearer ?? queryToken ?? cookieToken;
  if (!token) throw new UnauthorizedError("Missing access token");
  try {
    return verifyAccessToken(token).sub;
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }
}
