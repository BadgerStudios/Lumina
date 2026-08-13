import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";

const activitySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullable().optional(),
  // https only — this URL is third-party code every launcher's browser will execute.
  url: z.string().url().max(500).startsWith("https://", "Activities must be served over https"),
  iconUrl: z.string().url().max(500).nullable().optional(),
});

function serializeActivity(a: {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  url: string;
  iconUrl: string | null;
  createdAt: Date;
  application?: { name: string };
}) {
  return {
    id: a.id,
    applicationId: a.applicationId,
    name: a.name,
    description: a.description,
    url: a.url,
    iconUrl: a.iconUrl,
    appName: a.application?.name,
    createdAt: a.createdAt.toISOString(),
  };
}

async function requireOwnApplication(userId: string, applicationId: string) {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { ownerId: true } });
  if (!app) throw new NotFoundError("Application not found");
  if (app.ownerId !== userId) throw new ForbiddenError("Not your application");
}

/** Mounted under /api. Dev-portal CRUD plus the launcher-facing catalogue. */
export default async function activityRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/applications/:id/activities",
    { schema: { body: activitySchema }, preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await requireOwnApplication(request.userId!, id);
      const body = request.body as z.infer<typeof activitySchema>;
      const activity = await prisma.activity.create({
        data: { applicationId: id, name: body.name, description: body.description ?? null, url: body.url, iconUrl: body.iconUrl ?? null },
      });
      reply.code(201);
      return serializeActivity(activity);
    },
  );

  fastify.delete("/activities/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const activity = await prisma.activity.findUnique({ where: { id }, select: { applicationId: true } });
    if (!activity) throw new NotFoundError("Activity not found");
    await requireOwnApplication(request.userId!, activity.applicationId);
    await prisma.activity.delete({ where: { id } });
    reply.code(204).send();
  });

  /** The launcher catalogue: every registered activity, for any signed-in user. */
  fastify.get("/activities", { preHandler: [requireAuth] }, async () => {
    const activities = await prisma.activity.findMany({
      include: { application: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return activities.map(serializeActivity);
  });
}
