import type { Socket } from "socket.io";
import { verifyAccessToken, hashRefreshToken } from "../../lib/jwt.js";
import { prisma } from "../../db/prisma.js";

type ExtendedError = Error & { data?: unknown };

/**
 * Verifies the access token from `socket.handshake.auth.accessToken` using
 * the exact same verifyAccessToken used by Fastify's requireAuth preHandler
 * (plain jsonwebtoken, no Fastify-instance coupling) so REST and realtime
 * share one definition of "valid token".
 *
 * ## Bot tokens
 *
 * Bots were REST-only: `requireAuth` accepted `Bot <token>` on HTTP, but this handshake accepted
 * nothing but a human JWT, so a bot could never hold a socket. That was fine while bots only
 * *reacted* to things they polled for — it stops being fine with slash commands, where the whole
 * interaction model is the server pushing "someone just ran your command" and waiting a few seconds
 * for an answer. Polling cannot meet a 3-second response window without hammering the API.
 *
 * A bot connects with `auth: { botToken }` instead of `accessToken`, and from that point on the
 * socket is indistinguishable from any other — `socket.data.userId` is the bot's own User row, the
 * same row `requireAuth` sets on the REST side, so room membership and every handler treat it like
 * any other member. That is the same "no parallel bot-permission system" property the HTTP side
 * documents, and it is worth preserving here.
 */
export function authenticateSocket(socket: Socket, next: (err?: ExtendedError) => void): void {
  const botToken = socket.handshake.auth?.botToken as string | undefined;
  if (botToken) {
    void (async () => {
      try {
        const application = await prisma.application.findFirst({
          where: { botTokenHash: hashRefreshToken(botToken) },
          select: { id: true, botUser: { select: { id: true } } },
        });
        if (!application?.botUser) {
          next(new Error("Invalid bot token"));
          return;
        }
        socket.data.userId = application.botUser.id;
        // Recorded so interaction responses can be checked against the application that owns the
        // interaction — a bot must not be able to answer another bot's interaction.
        socket.data.applicationId = application.id;
        socket.data.isBot = true;
        next();
      } catch {
        next(new Error("Bot authentication failed"));
      }
    })();
    return;
  }

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
