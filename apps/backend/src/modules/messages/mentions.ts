import { Permissions, ServerEvents, hasPermission } from "@lumina/shared";
import type { MessageDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { computeEffectivePermissions } from "../../permissions/permissionService.js";
import { getIO } from "../../realtime/io.js";
import { sendPushToUser } from "../../lib/push.js";
import { shouldNotify } from "../notifications/service.js";

// Usernames are restricted to [a-zA-Z0-9_] at registration (see modules/auth/routes.ts), so a
// single-word token is enough to catch every possible username or "everyone". Role names are
// NOT restricted the same way — a multi-word role (e.g. "Server Admin") can't be mentioned by
// name with this syntax. That's a deliberate v1 scope cut, not an oversight: bracket/autocomplete
// syntax (like Discord's <@id>) would remove the ambiguity but needs composer UI this app
// doesn't have yet.
const MENTION_TOKEN_RE = /@([a-zA-Z0-9_]+)/g;

/**
 * Parses @mentions out of a channel message's content, persists MessageMention rows (the model
 * already existed in the schema but had zero call sites — see packages/shared/src/types.ts /
 * events.ts, both of which already had mention-shaped fields sitting unused), and notifies
 * mentioned users in realtime via ServerEvents.NOTIFICATION_MENTION.
 *
 * Server-channel messages only — DMs have no @mention concept since every participant already
 * sees every message in a conversation they're part of.
 *
 * Idempotent: always clears prior mentions for the message first, so this is safe to call again
 * on edit (re-scanning content is the correct behavior — mentions can be added or removed).
 */
export async function syncMessageMentions(params: {
  messageId: bigint;
  serverId: string;
  channelId: string;
  authorId: string;
  content: string;
  dto: MessageDTO;
}): Promise<void> {
  await prisma.messageMention.deleteMany({ where: { messageId: params.messageId } });

  const tokens = new Set<string>();
  for (const m of params.content.matchAll(MENTION_TOKEN_RE)) tokens.add(m[1].toLowerCase());
  if (tokens.size === 0) return;

  const everyoneRequested = tokens.has("everyone");
  tokens.delete("everyone");
  const tokenList = Array.from(tokens);

  const [members, roles] = await Promise.all([
    tokenList.length > 0
      ? prisma.membership.findMany({
          where: { serverId: params.serverId, user: { username: { in: tokenList, mode: "insensitive" } } },
          select: { userId: true, user: { select: { username: true } } },
        })
      : Promise.resolve([]),
    tokenList.length > 0
      ? prisma.role.findMany({
          where: { serverId: params.serverId, mentionable: true, name: { in: tokenList, mode: "insensitive" } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const memberByUsername = new Map(members.map((m) => [m.user.username.toLowerCase(), m.userId]));
  const roleByName = new Map(roles.map((r) => [r.name.toLowerCase(), r.id]));

  // A token that matches both a username and a role name resolves to the user — matches the
  // intuitive reading of "@name" as addressing a person first.
  const mentionedUserIds = new Set<string>();
  const mentionedRoleIds = new Set<string>();
  for (const token of tokenList) {
    const userId = memberByUsername.get(token);
    if (userId) {
      mentionedUserIds.add(userId);
      continue;
    }
    const roleId = roleByName.get(token);
    if (roleId) mentionedRoleIds.add(roleId);
  }

  let everyoneGranted = false;
  if (everyoneRequested) {
    const server = await prisma.server.findUnique({ where: { id: params.serverId }, select: { ownerId: true } });
    if (server?.ownerId === params.authorId) {
      everyoneGranted = true;
    } else {
      const effective = await computeEffectivePermissions(params.authorId, params.serverId);
      everyoneGranted = hasPermission(effective, Permissions.MENTION_EVERYONE);
    }
  }

  if (mentionedUserIds.size === 0 && mentionedRoleIds.size === 0 && !everyoneGranted) return;

  await prisma.messageMention.createMany({
    data: [
      ...Array.from(mentionedUserIds, (userId) => ({ messageId: params.messageId, userId })),
      ...Array.from(mentionedRoleIds, (roleId) => ({ messageId: params.messageId, roleId })),
      ...(everyoneGranted ? [{ messageId: params.messageId, everyone: true }] : []),
    ],
  });

  // Resolve the actual set of users to notify in realtime: direct mentions, everyone currently
  // in the role (for role mentions), or every server member (for @everyone) — minus the author,
  // who obviously doesn't need a ping for their own message.
  const notifyUserIds = new Set(mentionedUserIds);
  if (mentionedRoleIds.size > 0) {
    const holders = await prisma.roleAssignment.findMany({
      where: { roleId: { in: Array.from(mentionedRoleIds) } },
      select: { membership: { select: { userId: true } } },
    });
    for (const h of holders) notifyUserIds.add(h.membership.userId);
  }
  if (everyoneGranted) {
    const allMembers = await prisma.membership.findMany({ where: { serverId: params.serverId }, select: { userId: true } });
    for (const m of allMembers) notifyUserIds.add(m.userId);
  }
  notifyUserIds.delete(params.authorId);

  if (notifyUserIds.size === 0) return;
  const io = getIO();
  const payload = { message: params.dto, serverId: params.serverId, channelId: params.channelId };
  const authorName = params.dto.author?.displayName ?? params.dto.author?.username ?? "Someone";
  for (const userId of notifyUserIds) {
    io.to(`user:${userId}`).emit(ServerEvents.NOTIFICATION_MENTION, payload);
    // Fire-and-forget — a push provider round trip shouldn't add latency to sending a message,
    // and sendPushToUser already swallows per-subscription delivery failures internally.
    // shouldNotify checks the user's own per-channel/per-server NotificationOverride (see
    // modules/notifications/service.ts) — a NONE-level mute suppresses the push even though the
    // realtime NOTIFICATION_MENTION event above still fires (that drives the in-app Activity
    // feed, which a notification mute shouldn't hide, only the OS push).
    void shouldNotify(userId, params.serverId, params.channelId, true).then((notify) => {
      if (!notify) return;
      void sendPushToUser(userId, {
        title: `${authorName} mentioned you`,
        body: params.content.slice(0, 150),
        url: `/channels/${params.serverId}/${params.channelId}`,
        // Per-message, not per-channel: two separate mentions are two things to answer, and
        // collapsing them would hide the second one entirely.
        tag: `mention-${params.messageId}`,
        // Being named directly is the one notification worth feeling through a sleeve.
        urgent: true,
      });
    });
  }
}
