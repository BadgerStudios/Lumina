import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

export interface AccessTokenPayload {
  sub: string;
}

/**
 * Access token: short-lived JWT, verified identically by Fastify preHandlers
 * and the Socket.IO auth middleware (plain jsonwebtoken, no Fastify coupling).
 */
export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId } satisfies AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  // Pin the algorithm explicitly. signAccessToken uses HS256 (jsonwebtoken's default for a string
  // secret), so verification must accept ONLY HS256 — never trust the token header's `alg`. Without
  // this, jsonwebtoken accepts any algorithm in its default set; the classic break is a token forged
  // with `alg: none` or an asymmetric-vs-symmetric confusion. The secret here is symmetric so that
  // confusion isn't reachable today, but pinning removes the whole class rather than relying on it.
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
  if (typeof decoded === "string" || !decoded.sub) {
    throw new Error("Invalid access token payload");
  }
  return { sub: decoded.sub as string };
}

/**
 * Refresh token: opaque random value, NOT a JWT. Only its sha256 hash is
 * persisted server-side, so a DB leak alone never yields a usable token.
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiryDate(): Date {
  const ttl = env.REFRESH_TOKEN_TTL;
  const ms = parseDurationToMs(ttl);
  return new Date(Date.now() + ms);
}

function parseDurationToMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * unitMs[unit];
}
