import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerFolderDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { NotFoundError } from "../../lib/errors.js";

/**
 * Per-user sidebar folders. Entirely a personal organising device: a folder groups some of the
 * caller's own spaces (via Membership.folderId), confers no permissions, and is never visible to
 * anyone else. Every route is scoped to request.userId — there is no cross-user access to reason
 * about. Mounted under /api/server-folders.
 */

const createSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(32).nullable().optional(),
});
const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.string().max(32).nullable().optional(),
});
const placementSchema = z.object({ folderId: z.string().nullable() });

async function listFolders(userId: string): Promise<ServerFolderDTO[]> {
  const folders = await prisma.serverFolder.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { memberships: { select: { serverId: true }, orderBy: { joinedAt: "asc" } } },
  });
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    color: f.color,
    serverIds: f.memberships.map((m) => m.serverId),
  }));
}

async function serializeOne(id: string, userId: string): Promise<ServerFolderDTO> {
  const f = await prisma.serverFolder.findFirst({
    where: { id, userId },
    include: { memberships: { select: { serverId: true }, orderBy: { joinedAt: "asc" } } },
  });
  if (!f) throw new NotFoundError("Folder not found");
  return { id: f.id, name: f.name, color: f.color, serverIds: f.memberships.map((m) => m.serverId) };
}

export default async function serverFolderRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => listFolders(request.userId!));

  fastify.post("/", { schema: { body: createSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof createSchema>;
    const max = await prisma.serverFolder.aggregate({ where: { userId: request.userId! }, _max: { position: true } });
    const folder = await prisma.serverFolder.create({
      data: {
        userId: request.userId!,
        name: body.name.trim(),
        color: body.color ?? null,
        position: (max._max.position ?? -1) + 1,
      },
    });
    reply.code(201);
    return { id: folder.id, name: folder.name, color: folder.color, serverIds: [] } satisfies ServerFolderDTO;
  });

  fastify.patch("/:id", { schema: { body: updateSchema }, preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof updateSchema>;
    const existing = await prisma.serverFolder.findFirst({ where: { id, userId: request.userId! }, select: { id: true } });
    if (!existing) throw new NotFoundError("Folder not found");
    await prisma.serverFolder.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
      },
    });
    return serializeOne(id, request.userId!);
  });

  fastify.delete("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // deleteMany scoped to the owner rather than delete-by-id: a folder that isn't the caller's
    // simply deletes nothing (and 404s), never someone else's. Contained servers loosen via the
    // Membership.folderId FK's onDelete: SetNull.
    const res = await prisma.serverFolder.deleteMany({ where: { id, userId: request.userId! } });
    if (res.count === 0) throw new NotFoundError("Folder not found");
    reply.code(204).send();
  });

  // Set (or clear, folderId: null) which folder one of the caller's own servers sits in — the single
  // move endpoint the sidebar needs for drag-in, drag-between, and drag-out.
  fastify.put(
    "/placements/:serverId",
    { schema: { body: placementSchema }, preHandler: [requireAuth] },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };
      const { folderId } = request.body as z.infer<typeof placementSchema>;
      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId: request.userId!, serverId } },
        select: { id: true },
      });
      if (!membership) throw new NotFoundError("You are not in that server");
      if (folderId !== null) {
        const folder = await prisma.serverFolder.findFirst({ where: { id: folderId, userId: request.userId! }, select: { id: true } });
        if (!folder) throw new NotFoundError("Folder not found");
      }
      await prisma.membership.update({
        where: { userId_serverId: { userId: request.userId!, serverId } },
        data: { folderId },
      });
      reply.code(204).send();
    },
  );
}
