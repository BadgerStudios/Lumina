import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { checkPermission } from "../../permissions/permissionService.js";

export function registerChannelRoomHandlers(_io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;

  socket.on(
    ClientEvents.CHANNEL_JOIN,
    async (payload: { channelId: string }, ack?: (res: { ok: boolean; error?: string }) => void) => {
      try {
        const channel = await prisma.channel.findUnique({ where: { id: payload.channelId } });
        if (!channel) throw new Error("Channel not found");

        const membership = await prisma.membership.findUnique({
          where: { userId_serverId: { userId, serverId: channel.serverId } },
        });
        if (!membership) throw new Error("Not a member of this server");

        await checkPermission(userId, channel.serverId, Permissions.VIEW_CHANNELS);

        await socket.join(`channel:${payload.channelId}`);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(ClientEvents.CHANNEL_LEAVE, async (payload: { channelId: string }) => {
    await socket.leave(`channel:${payload.channelId}`);
  });
}
