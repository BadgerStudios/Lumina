import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, hasPermission } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { computeEffectivePermissions, isServerOwner } from "../../permissions/permissionService.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { listServerEvents } from "./service.js";

const eventBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional().nullable(),
  channelId: z.string().optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional().nullable(),
});

/** MANAGE_EVENTS is the dedicated bit; MANAGE_SERVER implies it so existing moderator role
 * setups (which predate the bit) can schedule events without anyone re-editing roles. */
async function assertCanManageEvents(userId: string, serverId: string): Promise<void> {
  if (await isServerOwner(userId, serverId)) return;
  const effective = await computeEffectivePermissions(userId, serverId);
  if (hasPermission(effective, Permissions.MANAGE_EVENTS) || hasPermission(effective, Permissions.MANAGE_SERVER)) return;
  throw new ForbiddenError("Missing permission: MANAGE_EVENTS");
}

async function assertEventChannel(serverId: string, channelId: string | null | undefined): Promise<void> {
  if (!channelId) return;
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true, type: true } });
  // A channel from another server must not be nameable — that is how event listings would leak
  // channel ids across servers.
  if (!channel || channel.serverId !== serverId) throw new NotFoundError("Channel not found");
  if (channel.type === "CATEGORY") throw new BadRequestError("Events cannot be held in a category");
}

/** Mounted under /api/servers. */
export default async function eventRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/events",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => listServerEvents(request.serverId!, request.userId!),
  );

  fastify.post(
    "/:id/events",
    { schema: { body: eventBodySchema }, preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request, reply) => {
      const body = request.body as z.infer<typeof eventBodySchema>;
      await assertCanManageEvents(request.userId!, request.serverId!);
      if (body.startsAt.getTime() < Date.now() - 60_000) throw new BadRequestError("Events cannot start in the past");
      if (body.endsAt && body.endsAt <= body.startsAt) throw new BadRequestError("An event must end after it starts");
      await assertEventChannel(request.serverId!, body.channelId);

      const event = await prisma.serverEvent.create({
        data: {
          serverId: request.serverId!,
          creatorId: request.userId!,
          name: body.name,
          description: body.description ?? null,
          channelId: body.channelId ?? null,
          location: body.location ?? null,
          startsAt: body.startsAt,
          endsAt: body.endsAt ?? null,
          // The creator is obviously going; seeding the RSVP means the reminder reaches them too.
          rsvps: { create: { userId: request.userId!, status: "GOING" } },
        },
      });
      reply.code(201);
      return { id: event.id };
    },
  );

  fastify.patch(
    "/:id/events/:eventId",
    { schema: { body: eventBodySchema.partial() }, preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const body = request.body as Partial<z.infer<typeof eventBodySchema>>;
      const event = await prisma.serverEvent.findUnique({ where: { id: eventId } });
      if (!event || event.serverId !== request.serverId) throw new NotFoundError("Event not found");
      if (event.creatorId !== request.userId) await assertCanManageEvents(request.userId!, request.serverId!);
      if (body.channelId !== undefined) await assertEventChannel(request.serverId!, body.channelId);

      const startsAt = body.startsAt ?? event.startsAt;
      const endsAt = body.endsAt === undefined ? event.endsAt : body.endsAt;
      if (endsAt && endsAt <= startsAt) throw new BadRequestError("An event must end after it starts");

      await prisma.serverEvent.update({
        where: { id: eventId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.channelId !== undefined ? { channelId: body.channelId } : {}),
          ...(body.location !== undefined ? { location: body.location } : {}),
          // Rescheduling re-arms the reminder for the new time.
          ...(body.startsAt !== undefined ? { startsAt: body.startsAt, remindedAt: null } : {}),
          ...(body.endsAt !== undefined ? { endsAt: body.endsAt } : {}),
        },
      });
      return { ok: true };
    },
  );

  fastify.delete(
    "/:id/events/:eventId",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: string };
      const event = await prisma.serverEvent.findUnique({ where: { id: eventId } });
      if (!event || event.serverId !== request.serverId) throw new NotFoundError("Event not found");
      if (event.creatorId !== request.userId) await assertCanManageEvents(request.userId!, request.serverId!);
      // Cancel rather than delete: RSVPs deserve to see "cancelled", not a vanished event.
      await prisma.serverEvent.update({ where: { id: eventId }, data: { canceledAt: new Date() } });
      reply.code(204).send();
    },
  );

  fastify.put(
    "/:id/events/:eventId/rsvp",
    {
      schema: { body: z.object({ status: z.enum(["GOING", "INTERESTED"]) }) },
      preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))],
    },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const { status } = request.body as { status: "GOING" | "INTERESTED" };
      const event = await prisma.serverEvent.findUnique({ where: { id: eventId }, select: { serverId: true, canceledAt: true } });
      if (!event || event.serverId !== request.serverId) throw new NotFoundError("Event not found");
      if (event.canceledAt) throw new BadRequestError("This event was cancelled");
      await prisma.serverEventRsvp.upsert({
        where: { eventId_userId: { eventId, userId: request.userId! } },
        create: { eventId, userId: request.userId!, status },
        update: { status },
      });
      return { ok: true };
    },
  );

  fastify.delete(
    "/:id/events/:eventId/rsvp",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: string };
      await prisma.serverEventRsvp.deleteMany({ where: { eventId, userId: request.userId! } });
      reply.code(204).send();
    },
  );
}
