import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { saveProfileImage, deleteProfileImage } from "../../lib/profileImage.js";
import { recordAuditLog } from "../../lib/auditLog.js";

/**
 * Custom emoji.
 *
 * ## Names are per-server, not global
 *
 * `@@unique([serverId, name])`, so two servers can both define `:blob:` and a member of both sees
 * the right one in each. Every resolution path is therefore server-scoped, which is also why a
 * `:name:` typed in a DM cannot resolve — there is no server to resolve it against.
 *
 * ## Why a cap exists
 *
 * Emoji are uploaded images with no per-user quota behind them: MANAGE_EMOJI is a server-level
 * permission, so anyone holding it could otherwise fill the disk one 256KB PNG at a time. The cap
 * is per server rather than global because the disk pressure scales with servers, not instances.
 */

const MAX_EMOJI_PER_SERVER = 100;

const createSchema = z.object({
  // Discord's own rule, kept so copied message text and muscle memory both work.
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers and underscores only"),
});

const renameSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers and underscores only"),
});

function serialize(e: {
  id: string;
  name: string;
  imageUrl: string;
  animated: boolean;
  uploaderId: string | null;
  createdAt: Date;
}) {
  return {
    id: e.id,
    name: e.name,
    imageUrl: e.imageUrl,
    animated: e.animated,
    uploaderId: e.uploaderId,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Mounted under /api/servers (shares the :id param with the rest of server management). */
export default async function emojiRoutes(fastify: FastifyInstance) {
  /** Readable by any member — the client needs the whole set to render `:name:` in message text. */
  fastify.get(
    "/:id/emojis",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const emojis = await prisma.customEmoji.findMany({
        where: { serverId: request.serverId! },
        orderBy: { name: "asc" },
      });
      return emojis.map(serialize);
    },
  );

  fastify.post(
    "/:id/emojis",
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
      let filePart: Awaited<ReturnType<typeof request.file>> | undefined;

      // The name arrives as a multipart field alongside the image, so both are read from one stream.
      for await (const part of parts) {
        if (part.type === "field" && part.fieldname === "name") {
          name = String(part.value);
        } else if (part.type === "file") {
          filePart = part as never;
          break; // the file must be consumed before the iterator advances past it
        }
      }

      const parsed = createSchema.safeParse({ name: name.trim().toLowerCase() });
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.errors[0]?.message ?? "Invalid emoji name");
      }
      if (!filePart) throw new BadRequestError("An image is required");

      const count = await prisma.customEmoji.count({ where: { serverId: request.serverId! } });
      if (count >= MAX_EMOJI_PER_SERVER) {
        throw new BadRequestError(`This server has reached the ${MAX_EMOJI_PER_SERVER} emoji limit`);
      }

      const clash = await prisma.customEmoji.findUnique({
        where: { serverId_name: { serverId: request.serverId!, name: parsed.data.name } },
      });
      if (clash) throw new BadRequestError(`:${parsed.data.name}: already exists in this server`);

      // GIFs keep their animation; everything else is normalised by the shared image pipeline.
      const animated = (filePart as { mimetype?: string }).mimetype === "image/gif";
      const imageUrl = await saveProfileImage(
        `${request.serverId!}-${parsed.data.name}`,
        "emojis",
        "emoji",
        filePart,
        "Emoji",
      );

      const emoji = await prisma.customEmoji.create({
        data: {
          serverId: request.serverId!,
          name: parsed.data.name,
          imageUrl,
          animated,
          uploaderId: request.userId!,
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "emoji.create",
        targetId: emoji.id,
        targetType: "emoji",
        metadata: { name: emoji.name },
      });

      return serialize(emoji);
    },
  );

  fastify.patch(
    "/:id/emojis/:emojiId",
    {
      schema: { body: renameSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_EMOJI),
      ],
    },
    async (request) => {
      const { emojiId } = request.params as { emojiId: string };
      const body = request.body as z.infer<typeof renameSchema>;
      const name = body.name.trim().toLowerCase();

      const existing = await prisma.customEmoji.findFirst({
        where: { id: emojiId, serverId: request.serverId! },
      });
      if (!existing) throw new NotFoundError("Emoji not found");

      const clash = await prisma.customEmoji.findUnique({
        where: { serverId_name: { serverId: request.serverId!, name } },
      });
      if (clash && clash.id !== emojiId) {
        throw new BadRequestError(`:${name}: already exists in this server`);
      }

      const emoji = await prisma.customEmoji.update({ where: { id: emojiId }, data: { name } });
      // Existing reactions keep pointing at this row by customEmojiId, so a rename does not split
      // one reaction into two — that is the whole reason Reaction carries the FK.
      return serialize(emoji);
    },
  );

  fastify.delete(
    "/:id/emojis/:emojiId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_EMOJI),
      ],
    },
    async (request, reply) => {
      const { emojiId } = request.params as { emojiId: string };
      const existing = await prisma.customEmoji.findFirst({
        where: { id: emojiId, serverId: request.serverId! },
      });
      if (!existing) throw new NotFoundError("Emoji not found");

      await prisma.customEmoji.delete({ where: { id: emojiId } });
      // After the row is gone, not before: if the delete fails we would otherwise have destroyed
      // the image for an emoji that still exists.
      await deleteProfileImage(existing.imageUrl);

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "emoji.delete",
        targetId: emojiId,
        targetType: "emoji",
        metadata: { name: existing.name },
      });

      reply.code(204);
    },
  );
}
