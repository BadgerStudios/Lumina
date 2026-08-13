import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { filterVisibleUsers } from "../parental/visibility.js";
import { NotFoundError } from "../../lib/errors.js";
import { leaderboard } from "./service.js";
import { xpForLevel } from "../economy/split.js";

const rewardSchema = z.object({ level: z.number().int().min(1).max(500), roleId: z.string().min(1) });

/** Mounted under /api/servers — leaderboard + level-reward config. */
export default async function xpRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/leaderboard",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const board = await leaderboard(request.serverId!, request.userId!);
      // Minor/adult visibility applies to leaderboards exactly as it does to member lists — a
      // ranking is just a member list with numbers on it.
      const visibleTop = await filterVisibleUsers(
        request.userId!,
        board.top.map((r) => ({ ...r, id: r.userId })),
      );
      const visibleIds = new Set(visibleTop.map((v) => v.userId));
      return {
        top: board.top
          .filter((r) => visibleIds.has(r.userId))
          .map(({ isMinor: _m, isOfficial: _o, ...rest }) => rest),
        me: board.me,
        nextLevelXp: board.me ? xpForLevel(board.me.level) : xpForLevel(0),
      };
    },
  );

  fastify.get(
    "/:id/level-rewards",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const rewards = await prisma.levelReward.findMany({
        where: { serverId: request.serverId! },
        include: { role: { select: { id: true, name: true, color: true } } },
        orderBy: { level: "asc" },
      });
      return rewards.map((r) => ({ id: r.id, level: r.level, role: r.role }));
    },
  );

  fastify.post(
    "/:id/level-rewards",
    {
      schema: { body: rewardSchema },
      preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id")), requirePermission(Permissions.MANAGE_ROLES)],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof rewardSchema>;
      const role = await prisma.role.findUnique({ where: { id: body.roleId }, select: { serverId: true, isDefault: true } });
      if (!role || role.serverId !== request.serverId || role.isDefault) throw new NotFoundError("Role not found");
      const reward = await prisma.levelReward.upsert({
        where: { serverId_level_roleId: { serverId: request.serverId!, level: body.level, roleId: body.roleId } },
        create: { serverId: request.serverId!, level: body.level, roleId: body.roleId },
        update: {},
      });
      reply.code(201);
      return { id: reward.id, level: reward.level };
    },
  );

  fastify.delete(
    "/:id/level-rewards/:rewardId",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id")), requirePermission(Permissions.MANAGE_ROLES)] },
    async (request, reply) => {
      const { rewardId } = request.params as { rewardId: string };
      await prisma.levelReward.deleteMany({ where: { id: rewardId, serverId: request.serverId! } });
      reply.code(204).send();
    },
  );
}
