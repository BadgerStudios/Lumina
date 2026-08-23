import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { Permissions } from "@lumina/shared";
import { NotFoundError } from "../../lib/errors.js";
import { enqueueBotInstall } from "./queue.js";

const submitSchema = z.object({
  /** Whatever the admin has: an install link, a repo, an npm package name. */
  sourceUrl: z.string().min(1).max(500),
});

/**
 * Mounted under /api/servers — bot onboarding for one server.
 *
 * MANAGE_SERVER throughout, same bar as adding a bot through the install link: bringing software
 * into a server is an administrator's decision, and this is the same decision made earlier.
 */
/**
 * A READY request stores an applicationId, and the panel turns that into an install link. But an
 * application can be deleted afterwards — from the developer portal, or by an operator cleaning
 * up — and the stored id outlives it. Following that link then lands on "Unknown client_id",
 * which reads as a broken product rather than "the thing this link pointed at is gone".
 *
 * So the id is resolved on read: the panel gets the application's current name or an explicit
 * null, and can say which it is.
 */
async function withApplication<T extends { applicationId: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.applicationId).filter((v): v is string => !!v))];
  const apps = ids.length
    ? await prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const byId = new Map(apps.map((a) => [a.id, a.name]));
  return rows.map((r) => ({
    ...r,
    applicationName: r.applicationId ? (byId.get(r.applicationId) ?? null) : null,
    applicationExists: r.applicationId ? byId.has(r.applicationId) : false,
  }));
}

export default async function botRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/:id/bots/requests",
    {
      schema: { body: submitSchema },
      preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id")), requirePermission(Permissions.MANAGE_SERVER)],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof submitSchema>;
      const created = await prisma.botInstallRequest.create({
        data: { serverId: id, requestedById: request.userId!, sourceUrl: body.sourceUrl.trim() },
      });
      await enqueueBotInstall({ requestId: created.id });
      reply.code(202);
      return created;
    },
  );

  fastify.get(
    "/:id/bots/requests",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id")), requirePermission(Permissions.MANAGE_SERVER)] },
    async (request) => {
      const { id } = request.params as { id: string };
      const rows = await prisma.botInstallRequest.findMany({
        where: { serverId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { recipe: true },
      });
      return withApplication(rows);
    },
  );

  fastify.get(
    "/:id/bots/requests/:requestId",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id")), requirePermission(Permissions.MANAGE_SERVER)] },
    async (request) => {
      const { id, requestId } = request.params as { id: string; requestId: string };
      const row = await prisma.botInstallRequest.findFirst({ where: { id: requestId, serverId: id }, include: { recipe: true } });
      if (!row) throw new NotFoundError("Request not found");
      return (await withApplication([row]))[0];
    },
  );

  /** The bots currently in this server — ordinary members that happen to be bots. */
  fastify.get(
    "/:id/bots",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id")), requirePermission(Permissions.MANAGE_SERVER)] },
    async (request) => {
      const { id } = request.params as { id: string };
      const rows = await prisma.membership.findMany({
        where: { serverId: id, user: { isBot: true } },
        select: { joinedAt: true, user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
        orderBy: { joinedAt: "asc" },
      });
      return rows.map((r) => ({ ...r.user, joinedAt: r.joinedAt }));
    },
  );

  /**
   * The shared catalog: what previous onboardings taught, ranked by real use. Deliberately readable
   * by any authenticated user rather than gated per server — the whole value of the recipe table is
   * that it is common knowledge.
   */
  fastify.get("/bots/catalog", { preHandler: [requireAuth] }, async () => {
    return prisma.botRecipe.findMany({
      orderBy: [{ verified: "desc" }, { installCount: "desc" }],
      take: 50,
    });
  });
}
