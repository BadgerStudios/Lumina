import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { saveProfileImage, deleteProfileImage } from "../../lib/profileImage.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { serializeSticker } from "../../lib/serialize.js";

/**
 * Stickers — server-scoped images sent as a whole message.
 *
 * ## Why MANAGE_EMOJI and not a new permission bit
 *
 * Adding a MANAGE_STICKERS bit would mean nobody holds it: every existing role's bitfield was
 * written before the bit existed, so on the day this shipped, every server on the instance would
 * have stickers that only the owner could manage until an admin went and edited each role by hand.
 * Discord itself folded these into one "Manage Expressions" permission for the same reason. Emoji,
 * stickers and soundboard clips are the same act — uploading a small asset to a server's shared
 * palette — and one bit governs all three.
 *
 * ## The cap
 *
 * Same reasoning as the emoji cap, with a smaller number because the pixels are ~6x larger. This
 * is a per-server disk limit on a single-host deployment with no object storage.
 */

const MAX_STICKERS_PER_SERVER = 50;

const createSchema = z.object({
  // Looser than an emoji name: a sticker is picked from a grid, never typed as `:name:`, so there
  // is no syntax to protect. Still bounded, and still trimmed, so a name of pure whitespace or one
  // long enough to break the picker layout cannot be stored.
  name: z.string().trim().min(2).max(32),
  description: z.string().trim().max(200).optional(),
});

/** Mounted under /api/servers, sharing the :id param with the rest of server management. */
export default async function stickerRoutes(fastify: FastifyInstance) {
  /** Any member: the client needs the whole set to render a sticker already sent in the channel. */
  fastify.get(
    "/:id/stickers",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const stickers = await prisma.sticker.findMany({
        where: { serverId: request.serverId! },
        orderBy: { name: "asc" },
      });
      return stickers.map(serializeSticker);
    },
  );

  fastify.post(
    "/:id/stickers",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_EMOJI),
      ],
    },
    async (request) => {
      const parts = request.parts();
      let name = "";
      let description = "";
      let filePart: Awaited<ReturnType<typeof request.file>> | undefined;

      // The fields arrive alongside the image in one multipart stream, so all of it is read here.
      // Breaking on the file part is not optional — the async iterator cannot advance past a file
      // whose body has not been consumed, so anything after it would hang.
      for await (const part of parts) {
        if (part.type === "field" && part.fieldname === "name") {
          name = String(part.value);
        } else if (part.type === "field" && part.fieldname === "description") {
          description = String(part.value);
        } else if (part.type === "file") {
          filePart = part as never;
          break;
        }
      }

      const parsed = createSchema.safeParse({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.errors[0]?.message ?? "Invalid sticker name");
      }
      if (!filePart) throw new BadRequestError("An image is required");

      const count = await prisma.sticker.count({ where: { serverId: request.serverId! } });
      if (count >= MAX_STICKERS_PER_SERVER) {
        throw new BadRequestError(`This server has reached the ${MAX_STICKERS_PER_SERVER} sticker limit`);
      }

      const clash = await prisma.sticker.findUnique({
        where: { serverId_name: { serverId: request.serverId!, name: parsed.data.name } },
      });
      if (clash) throw new BadRequestError(`A sticker called "${parsed.data.name}" already exists here`);

      const animated = (filePart as { mimetype?: string }).mimetype === "image/gif";
      const imageUrl = await saveProfileImage(
        `${request.serverId!}-${parsed.data.name.replace(/[^a-zA-Z0-9]+/g, "-")}`,
        "stickers",
        "sticker",
        filePart,
        "Sticker",
      );

      const sticker = await prisma.sticker.create({
        data: {
          serverId: request.serverId!,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          imageUrl,
          animated,
          uploaderId: request.userId!,
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "sticker.create",
        targetId: sticker.id,
        targetType: "sticker",
        metadata: { name: sticker.name },
      });

      return serializeSticker(sticker);
    },
  );

  fastify.delete(
    "/:id/stickers/:stickerId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_EMOJI),
      ],
    },
    async (request, reply) => {
      const { stickerId } = request.params as { stickerId: string };
      // Scoped to the server from the path, not looked up by id alone: without the serverId in the
      // where clause, anyone with MANAGE_EMOJI in *any* server could delete a sticker from *any
      // other* server by id.
      const existing = await prisma.sticker.findFirst({
        where: { id: stickerId, serverId: request.serverId! },
      });
      if (!existing) throw new NotFoundError("Sticker not found");

      await prisma.sticker.delete({ where: { id: stickerId } });
      // After the row is gone, not before: a failed delete would otherwise destroy the image of a
      // sticker that still exists. Messages that used it keep their row (Message.stickerId is
      // SetNull) and render as a message whose sticker is gone.
      await deleteProfileImage(existing.imageUrl);

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "sticker.delete",
        targetId: stickerId,
        targetType: "sticker",
        metadata: { name: existing.name },
      });

      reply.code(204);
    },
  );
}
