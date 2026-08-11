import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeInvite } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { generateInviteCode } from "../../lib/nanoid.js";
import { recordAuditLog } from "../../lib/auditLog.js";

// preprocess so a request with no body at all (previously handled by `.parse(request.body ??
// {})` in the handler) still validates now that the schema is attached to Fastify's own
// `schema.body` — the fastify-type-provider-zod validator calls `schema.parse(request.body)`
// directly with whatever Fastify parsed (possibly `undefined` for a bodyless request).
const createInviteSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    maxUses: z.number().int().positive().nullable().optional(),
    expiresInSeconds: z.number().int().positive().nullable().optional(),
  }),
);

/** Mounted under /api/servers */
export default async function serverInvitesRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/:id/invites",
    {
      schema: { body: createInviteSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.CREATE_INVITE),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createInviteSchema>;

      const invite = await prisma.invite.create({
        data: {
          code: generateInviteCode(),
          serverId: request.serverId!,
          creatorId: request.userId!,
          maxUses: body.maxUses ?? null,
          expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null,
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "invite.create",
        targetId: invite.code,
        targetType: "invite",
      });

      reply.code(201);
      return serializeInvite(invite);
    },
  );

  fastify.get(
    "/:id/invites",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.CREATE_INVITE),
      ],
    },
    async (request) => {
      const invites = await prisma.invite.findMany({
        where: { serverId: request.serverId!, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return invites.map(serializeInvite);
    },
  );
}
