import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { serializeUser, serializeMe } from "../../lib/serialize.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";
import { listMyMentions } from "../messages/service.js";
import { saveProfileImage, deleteProfileImage } from "../../lib/profileImage.js";

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(64).nullable().optional(),
  statusText: z.string().max(128).nullable().optional(),
  statusEmoji: z.string().max(16).nullable().optional(),
  bio: z.string().max(190).nullable().optional(),
  pronouns: z.string().max(40).nullable().optional(),
  allowDmsFromNonFriends: z.boolean().optional(),
  allowFriendRequests: z.boolean().optional(),
});

const presenceSchema = z.object({
  presence: z.enum(["ONLINE", "IDLE", "DND", "OFFLINE"]),
});

const updateUsernameSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, "username may only contain letters, numbers, underscore"),
  currentPassword: z.string().min(1),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const deleteMeSchema = z.object({
  currentPassword: z.string().min(1),
});

export default async function usersRoutes(fastify: FastifyInstance) {
  fastify.get("/:id", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError("User not found");
    return serializeUser(user);
  });

  fastify.patch("/me", { schema: { body: updateMeSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof updateMeSchema>;
    const user = await prisma.user.update({
      where: { id: request.userId! },
      data: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.statusText !== undefined ? { statusText: body.statusText } : {}),
        ...(body.statusEmoji !== undefined ? { statusEmoji: body.statusEmoji } : {}),
        ...(body.bio !== undefined ? { bio: body.bio } : {}),
        ...(body.pronouns !== undefined ? { pronouns: body.pronouns } : {}),
        ...(body.allowDmsFromNonFriends !== undefined ? { allowDmsFromNonFriends: body.allowDmsFromNonFriends } : {}),
        ...(body.allowFriendRequests !== undefined ? { allowFriendRequests: body.allowFriendRequests } : {}),
      },
    });
    return serializeMe(user);
  });

  // Username changes are security/identity-sensitive (it's also the login handle), so they're
  // split out from the general PATCH /me and gated behind re-entering the current password —
  // same reasoning as the password-change route below, matches how most real platforms treat it.
  fastify.patch("/me/username", { schema: { body: updateUsernameSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof updateUsernameSchema>;
    const me = await prisma.user.findUnique({ where: { id: request.userId! } });
    if (!me) throw new NotFoundError("User not found");
    if (!(await verifyPassword(me.passwordHash, body.currentPassword))) {
      throw new UnauthorizedError("Incorrect password");
    }
    if (body.username !== me.username) {
      const existing = await prisma.user.findUnique({ where: { username: body.username } });
      if (existing) throw new ConflictError("Username already taken");
    }
    const user = await prisma.user.update({ where: { id: request.userId! }, data: { username: body.username } });
    return serializeMe(user);
  });

  fastify.patch("/me/password", { schema: { body: updatePasswordSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof updatePasswordSchema>;
    const me = await prisma.user.findUnique({ where: { id: request.userId! } });
    if (!me) throw new NotFoundError("User not found");
    if (!(await verifyPassword(me.passwordHash, body.currentPassword))) {
      throw new UnauthorizedError("Incorrect current password");
    }
    const passwordHash = await hashPassword(body.newPassword);
    await prisma.user.update({ where: { id: request.userId! }, data: { passwordHash } });
    return { ok: true };
  });

  fastify.get("/me/mentions", { preHandler: [requireAuth] }, async (request) => {
    return listMyMentions(request.userId!);
  });

  fastify.patch("/me/presence", { schema: { body: presenceSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof presenceSchema>;
    const user = await prisma.user.update({
      where: { id: request.userId! },
      data: { presence: body.presence },
    });
    return serializeUser(user);
  });

  // Both image routes below re-encode the upload rather than storing it verbatim — see
  // lib/imageFit.ts for the crop strategy and for why rasterising is also what closes the
  // same-origin SVG hole these routes used to have.
  fastify.post("/me/avatar", { preHandler: [requireAuth] }, async (request) => {
    const avatarUrl = await saveProfileImage(
      request.userId!,
      "avatars",
      "avatar",
      await request.file(),
      "Avatar",
    );

    // Read the URL being replaced off the row itself, so the file deleted below is exactly the
    // one no record points at any more — never a directory glob (see lib/profileImage.ts).
    const previous = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { avatarUrl: true },
    });
    const user = await prisma.user.update({
      where: { id: request.userId! },
      data: { avatarUrl },
    });
    await deleteProfileImage(previous?.avatarUrl);
    return serializeUser(user);
  });

  fastify.post("/me/banner", { preHandler: [requireAuth] }, async (request) => {
    const bannerUrl = await saveProfileImage(
      request.userId!,
      "banners",
      "userBanner",
      await request.file(),
      "Banner",
    );

    const previous = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { bannerUrl: true },
    });
    const user = await prisma.user.update({
      where: { id: request.userId! },
      data: { bannerUrl },
    });
    await deleteProfileImage(previous?.bannerUrl);
    return serializeUser(user);
  });

  // Self-service account deletion. Hard-delete (not a soft "deactivate" flag) — consistent with
  // the existing precedent that a deleted user's content survives on its own (Message.author is
  // nullable with onDelete: SetNull, same as a bot's User row being deleted when its Application
  // is). Password-gated like the username/password change routes above.
  fastify.delete("/me", { schema: { body: deleteMeSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof deleteMeSchema>;
    const me = await prisma.user.findUnique({ where: { id: request.userId! } });
    if (!me) throw new NotFoundError("User not found");
    if (!(await verifyPassword(me.passwordHash, body.currentPassword))) {
      throw new UnauthorizedError("Incorrect password");
    }

    // Server.ownerId has no onDelete rule (a server always needs a real owner) — deleting a
    // user who still owns servers would otherwise fail with a raw FK violation surfaced as a
    // generic 500. Same guard shape as servers/routes.ts's "owner cannot leave their own
    // server" check, just applied account-wide instead of per-server.
    const ownedServerCount = await prisma.server.count({ where: { ownerId: request.userId! } });
    if (ownedServerCount > 0) {
      throw new BadRequestError(
        `Transfer ownership or delete ${ownedServerCount === 1 ? "the server" : "all servers"} you own before deleting your account`,
      );
    }

    await prisma.user.delete({ where: { id: request.userId! } });
    reply.code(204).send();
  });

  // Self-service data export — deliberately reuses serializeMe/plain Prisma reads rather than a
  // parallel export-specific serializer, so this can't silently drift from what /me already
  // returns. Not exhaustive (e.g. reaction history isn't included) but covers the material
  // things: profile, server memberships, authored messages, friends.
  fastify.get("/me/export", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = request.userId!;
    const [user, memberships, channelMessages, dmMessages, friendRows] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.membership.findMany({ where: { userId }, include: { server: true } }),
      prisma.message.findMany({
        where: { authorId: userId, channelId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 5000,
      }),
      prisma.message.findMany({
        where: { authorId: userId, dmConversationId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 5000,
      }),
      prisma.friendRequest.findMany({
        where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { addresseeId: userId }] },
        include: { requester: true, addressee: true },
      }),
    ]);
    if (!user) throw new NotFoundError("User not found");

    const exportData = {
      exportedAt: new Date().toISOString(),
      profile: serializeMe(user),
      serverMemberships: memberships.map((m) => ({
        serverId: m.serverId,
        serverName: m.server.name,
        nickname: m.nickname,
        joinedAt: m.joinedAt.toISOString(),
      })),
      channelMessages: channelMessages.map((m) => ({
        id: m.id.toString(),
        channelId: m.channelId,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt?.toISOString() ?? null,
      })),
      dmMessages: dmMessages.map((m) => ({
        id: m.id.toString(),
        conversationId: m.dmConversationId,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt?.toISOString() ?? null,
      })),
      friends: friendRows.map((f) => (f.requesterId === userId ? f.addressee.username : f.requester.username)),
    };

    reply.header("Content-Disposition", `attachment; filename="lumina-export-${userId}.json"`);
    return exportData;
  });
}
