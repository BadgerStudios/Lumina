import type { FastifyRequest } from "fastify";
import { verifyAccessToken } from "./jwt.js";
import { UnauthorizedError } from "./errors.js";

/**
 * Authenticates a media-serving request from EITHER an `Authorization: Bearer` header (API/bot/
 * fetch callers) or a `?token=` query param — the same access token, same short TTL, just a second
 * place it's allowed to travel, scoped to routes whose URL is consumed directly by a native browser
 * element.
 *
 * The query-param path is not a shortcut: `<img src>`, `<video src>` and `<a href>` cannot attach a
 * custom header, so gating these routes on `requireAuth` alone made every attachment permanently
 * unloadable (silent 401 → broken-image icon). That was the real bug behind "uploading is broken" —
 * uploads and sends both worked; the file simply could never be fetched back.
 *
 * Lives here rather than in modules/uploads so the video playback/thumbnail routes share one
 * implementation with attachments instead of copying it and letting the two drift.
 */
export function extractMediaUserId(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  const token = bearer ?? queryToken;
  if (!token) throw new UnauthorizedError("Missing access token");
  try {
    return verifyAccessToken(token).sub;
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }
}
