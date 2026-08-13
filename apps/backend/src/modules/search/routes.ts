import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { filterVisibleChannels } from "../../permissions/permissionService.js";
import { serializeMessage } from "../../lib/serialize.js";
// Imported rather than redeclared: this used to be a local copy of
// `{ author, attachments, reactions }`, which silently stopped being the full set the moment
// messages gained stickers, polls and link embeds. A hand-written include that drifts does not
// fail — it serializes the missing relations as "this message has none", and a MESSAGE_UPDATE
// built from it wipes a live poll off every client that receives it.
import { messageInclude } from "../messages/service.js";

const querySchema = z.object({ q: z.string().min(1).max(200) });


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

      // Search has to respect channel overwrites explicitly. It queries Message directly rather
      // than going through any channel-scoped permission check, so without this a member could
      // read the contents of a private channel simply by searching for a word in it — the exact
      // leak that makes "private channel" mean nothing.
      const all = await prisma.channel.findMany({ where: { serverId: request.serverId! }, select: { id: true } });
      const visible = await filterVisibleChannels(request.userId!, request.serverId!, all);
      if (visible.length === 0) return [];
      const visibleIds = visible.map((c) => c.id);

      const rows = await prisma.$queryRaw<{ id: bigint }[]>`
        SELECT m.id
        FROM "Message" m
        JOIN "Channel" c ON m."channelId" = c.id
        WHERE c."serverId" = ${request.serverId!}
          AND c.id IN (${Prisma.join(visibleIds)})
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
