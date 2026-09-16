import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { getIO } from "../../realtime/io.js";
import { serializeMessage } from "../../lib/serialize.js";
import { messageInclude } from "./service.js";

/**
 * Join and leave announcements — the "X just joined" line in a space's system channel.
 *
 * The switches (`sysJoinMessages`, `sysLeaveMessages`) and the channel (`systemChannelId`) had
 * been settable for weeks with nothing behind them: no code ever posted. This is that code. It is
 * deliberately NOT createChannelMessage: a system line is not something the member typed, so it
 * skips slow mode, AutoMod, verification and permission checks, awards no XP, pings nobody's
 * inbox, and never throws into the join that triggered it — a broken announcement must not undo
 * a membership.
 *
 * Templates are the space's own words. Placeholders:
 *   {user}  → @username (renders as a mention, so the newcomer is linked and tappable)
 *   {name}  → display name, plain text
 *   {space} → the space's name
 *   {count} → member count after the change
 */
export const DEFAULT_JOIN_TEMPLATE = "{user} just joined {space}. Say hi!";
export const DEFAULT_LEAVE_TEMPLATE = "{user} left {space}.";
export const TEMPLATE_MAX_LENGTH = 200;

export interface TemplateContext {
  username: string;
  displayName: string | null;
  space: string;
  count: number;
}

/** Pure: fills a template. Unknown braces are left alone so a typo shows rather than vanishes. */
export function renderSystemTemplate(template: string, ctx: TemplateContext): string {
  const values: Record<string, string> = {
    user: `@${ctx.username}`,
    name: ctx.displayName ?? ctx.username,
    space: ctx.space,
    count: String(ctx.count),
  };
  return template.replace(/\{(user|name|space|count)\}/g, (_, key: string) => values[key]).trim();
}

/** Which template applies, with the built-in line as the fallback for empty/whitespace input. */
export function pickTemplate(kind: "join" | "leave", custom: string | null | undefined): string {
  const own = custom?.trim();
  if (own) return own.slice(0, TEMPLATE_MAX_LENGTH);
  return kind === "join" ? DEFAULT_JOIN_TEMPLATE : DEFAULT_LEAVE_TEMPLATE;
}

export async function postMemberSystemMessage(kind: "join" | "leave", serverId: string, userId: string): Promise<void> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: {
      name: true,
      systemChannelId: true,
      sysJoinMessages: true,
      sysLeaveMessages: true,
      joinMessageTemplate: true,
      leaveMessageTemplate: true,
    },
  });
  if (!server?.systemChannelId) return;
  if (kind === "join" ? !server.sysJoinMessages : !server.sysLeaveMessages) return;
  // A stale pointer (channel deleted, or the id belongs to another space) posts nowhere rather
  // than into the wrong room.
  const channel = await prisma.channel.findUnique({ where: { id: server.systemChannelId }, select: { id: true, serverId: true, type: true } });
  if (!channel || channel.serverId !== serverId || (channel.type !== "TEXT" && channel.type !== "ANNOUNCEMENT")) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, displayName: true } });
  if (!user) return;
  const count = await prisma.membership.count({ where: { serverId } });
  const content = renderSystemTemplate(pickTemplate(kind, kind === "join" ? server.joinMessageTemplate : server.leaveMessageTemplate), {
    username: user.username,
    displayName: user.displayName,
    space: server.name,
    count,
  });
  if (!content) return;
  const message = await prisma.message.create({
    data: { channelId: channel.id, authorId: userId, content, type: kind === "join" ? "MEMBER_JOIN" : "MEMBER_LEAVE" },
    include: messageInclude,
  });
  getIO().to(`channel:${channel.id}`).emit(ServerEvents.MESSAGE_CREATE, serializeMessage(message, null, null));
}

/** Fire-and-forget wrapper for call sites: the membership change already happened. */
export function announceMember(kind: "join" | "leave", serverId: string, userId: string): void {
  void postMemberSystemMessage(kind, serverId, userId).catch((err) => {
    console.error(`[system-messages] ${kind} announcement failed for ${userId} in ${serverId}:`, err);
  });
}
