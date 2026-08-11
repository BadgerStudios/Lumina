import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { serializeMessage } from "../../lib/serialize.js";

const querySchema = z.object({ q: z.string().min(1).max(200) });

const messageInclude = { author: true, attachments: true, reactions: true } as const;

/** Mounted under /api/servers */
export default async function searchRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/search",
    {
      schema: { querystring: querySchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.VIEW_CHANNELS),
      ],
    },
    async (request) => {
      const { q } = request.query as z.infer<typeof querySchema>;

      const rows = await prisma.$queryRaw<{ id: bigint }[]>`
        SELECT m.id
        FROM "Message" m
        JOIN "Channel" c ON m."channelId" = c.id
        WHERE c."serverId" = ${request.serverId!}
          AND m."deletedAt" IS NULL
          AND m."searchVector" @@ plainto_tsquery('english', ${q})
        ORDER BY m.id DESC
        LIMIT 50
      `;

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const messages = await prisma.message.findMany({
        where: { id: { in: ids } },
        include: messageInclude,
      });

      const byId = new Map(messages.map((m) => [m.id.toString(), m]));
      return ids
        .map((id) => byId.get(id.toString()))
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
        .map((m) => serializeMessage(m, request.userId!));
    },
  );
}
