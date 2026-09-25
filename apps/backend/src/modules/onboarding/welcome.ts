import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeMember } from "../../lib/serialize.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";
import { announceMember } from "../messages/systemMessages.js";
import { assertAgeEligibleToJoin } from "../servers/verification.js";

const memberInclude = { user: true, roles: { select: { roleId: true } } } as const;

/**
 * Put a brand-new account somewhere with people in it.
 *
 * Until this, a new account started in no server at all and had to find Discover on its own. Most
 * never did: 20 of the first 50 accounts were in no server and half had never sent a message. So a
 * new account joins the official welcome server, the oldest server that is both marked official
 * (Owner console) and open in Discover, exactly as if it had pressed Join there. The same checks
 * apply (a ban, the server's age rules), the server's own "just joined, say hi" line is posted, and
 * leaving works like leaving any server.
 *
 * No official discoverable server, or any check failing, means no join. It never fails a signup.
 */
export async function joinWelcomeServer(userId: string): Promise<string | null> {
  const server = await prisma.server.findFirst({
    where: { isOfficial: true, discoverable: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!server) return null;

  const ban = await prisma.ban.findUnique({ where: { serverId_userId: { serverId: server.id, userId } } });
  if (ban) return null;
  const existing = await prisma.membership.findUnique({ where: { userId_serverId: { userId, serverId: server.id } } });
  if (existing) return server.id;
  try {
    await assertAgeEligibleToJoin(userId, server.id);
  } catch {
    return null;
  }

  const membership = await prisma.membership.create({ data: { userId, serverId: server.id }, include: memberInclude });
  await recordAuditLog({
    serverId: server.id,
    actorId: userId,
    actionType: "member.join",
    targetId: userId,
    targetType: "member",
    metadata: { via: "welcome" },
  });
  getIO().to(`server:${server.id}`).emit(ServerEvents.MEMBER_JOIN, serializeMember(membership));
  announceMember("join", server.id, userId);
  return server.id;
}
