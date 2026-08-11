import type { Socket } from "socket.io";
import { verifyAccessToken } from "../../lib/jwt.js";

type ExtendedError = Error & { data?: unknown };

/**
 * Verifies the access token from `socket.handshake.auth.accessToken` using
 * the exact same verifyAccessToken used by Fastify's requireAuth preHandler
 * (plain jsonwebtoken, no Fastify-instance coupling) so REST and realtime
 * share one definition of "valid token".
 */
export function authenticateSocket(socket: Socket, next: (err?: ExtendedError) => void): void {
  const token = socket.handshake.auth?.accessToken as string | undefined;
  if (!token) {
    next(new Error("Missing accessToken in socket handshake auth"));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    socket.data.userId = payload.sub;
    next();
  } catch {
    next(new Error("Invalid or expired access token"));
  }
}
