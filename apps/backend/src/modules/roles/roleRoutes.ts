import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeRole } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { checkRoleHierarchy, deleteOverwritesForTarget } from "../../permissions/permissionService.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

const updateRoleSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.number().int().nullable().optional(),
  permissions: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  position: z.number().int().positive().optional(),
  mentionable: z.boolean().optional(),
});

/** Mounted under /api/roles */
export default async function roleRoutes(fastify: FastifyInstance) {
  fastify.patch(
    "/:id",
    {
      schema: { body: updateRoleSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromRoleParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof updateRoleSchema>;

      const role = await prisma.role.findUnique({ where: { id } });
      if (!role) throw new NotFoundError("Role not found");

      await checkRoleHierarchy(request.userId!, request.serverId!, role.position);

      if (role.isDefault && (body.name !== undefined || body.position !== undefined)) {
        throw new BadRequestError("Cannot rename or reposition the @everyone role");
      }

      if (body.position !== undefined) {
        // moving this role also subject to hierarchy vs the *new* position
        await checkRoleHierarchy(request.userId!, request.serverId!, body.position);
      }

      const updated = await prisma.role.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.permissions !== undefined ? { permissions: BigInt(body.permissions) } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.mentionable !== undefined ? { mentionable: body.mentionable } : {}),
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "role.update",
        targetId: id,
        targetType: "role",
        metadata: body,
      });

      const dto = serializeRole(updated);
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.ROLE_UPDATE, dto);
      return dto;
    },
  );

  fastify.delete(
    "/:id",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromRoleParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const role = await prisma.role.findUnique({ where: { id } });
      if (!role) throw new NotFoundError("Role not found");

      if (role.isDefault) throw new BadRequestError("Cannot delete the @everyone role");

      await checkRoleHierarchy(request.userId!, request.serverId!, role.position);

      await prisma.role.delete({ where: { id } });
      // ChannelPermissionOverwrite.targetId is polymorphic and so has no foreign key to cascade
      // from (see the schema comment). Left behind, these rows would keep applying to a role that
      // no longer exists — and would attach to a future role that reused the id.
      await deleteOverwritesForTarget(id);

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "role.delete",
        targetId: id,
        targetType: "role",
      });

      getIO().to(`server:${request.serverId}`).emit(ServerEvents.ROLE_DELETE, { id, serverId: request.serverId });
      reply.code(204).send();
    },
  );
}
