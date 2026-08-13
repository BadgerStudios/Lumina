import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, ServerEvents, Permissions } from "@lumina/shared";
import type { VoiceParticipantDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeUser } from "../../lib/serialize.js";
import { checkPermission, checkChannelPermission } from "../../permissions/permissionService.js";

/**
 * Mesh WebRTC signaling relay — the server never touches media (no SFU, no recording, no
 * bandwidth cost beyond tiny JSON offer/answer/ICE payloads). It only does two things: track
 * room membership (who's in which voice channel) and relay opaque signaling payloads between
 * specific socket ids so browsers can establish direct peer connections with each other.
 * Deliberately socket.io ROOM membership is the only source of truth for "who's connected" —
 * no separate Redis/DB table — since the existing @socket.io/redis-adapter (see realtime/io.ts)
 * already makes room membership correct across multiple backend instances for free via
 * `io.in(room).fetchSockets()`, so a parallel bookkeeping structure would just be a second
 * source of truth that could drift from the real one.
 *
 * Scale note: mesh means every participant holds a direct peer connection to every other
 * participant — bandwidth/CPU cost grows ~O(n²) per participant. Fine for small voice channels
 * (a handful of people), not a substitute for a real SFU media server if large calls are ever
 * needed — that's a deliberate v1 scope decision, not an oversight.
 */
function voiceRoom(channelId: string): string {
  return `voice:${channelId}`;
}

/**
 * Broadcast to the WHOLE server room (not just the voice room itself) so members who aren't
 * connected can still see who's in a voice channel — the voice room only reaches people already
 * connected, which is exactly the gap ChannelSidebar.tsx's roster used to have (see roadmap
 * Phase 8's "deliberate v1 scope cut" note). Sends the full current participant list rather than
 * a join/leave delta so a client that's never connected to this channel can build its roster
 * state from a single event with no separate fetch needed.
 */
async function broadcastRoster(io: SocketIOServer, channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
  if (!channel) return;
  const sockets = await io.in(voiceRoom(channelId)).fetchSockets();
  const participants: VoiceParticipantDTO[] = [];
  for (const s of sockets) {
    const otherUserId = s.data.userId as string;
    const user = await prisma.user.findUnique({ where: { id: otherUserId } });
    if (user) {
      participants.push({
        userId: otherUserId,
        socketId: s.id,
        user: serializeUser(user),
        streaming: (s.data.streaming as "screen" | "camera" | undefined) ?? null,
      });
    }
  }
  io.to(`server:${channel.serverId}`).emit(ServerEvents.VOICE_ROSTER_UPDATE, { channelId, participants });
}

async function leaveVoice(io: SocketIOServer, socket: Socket): Promise<void> {
  const channelId = socket.data.voiceChannelId as string | undefined;
  if (!channelId) return;
  const room = voiceRoom(channelId);
  await socket.leave(room);
  socket.data.voiceChannelId = undefined;
  socket.data.streaming = undefined;
  io.to(room).emit(ServerEvents.VOICE_PARTICIPANT_LEFT, { userId: socket.data.userId as string, socketId: socket.id });
  void broadcastRoster(io, channelId);
}

export function registerVoiceHandlers(io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;

  socket.on(
    ClientEvents.VOICE_JOIN,
    async (
      payload: { channelId: string },
      ack?: (res: { ok: boolean; participants?: VoiceParticipantDTO[]; error?: string }) => void,
    ) => {
      try {
        const channel = await prisma.channel.findUnique({ where: { id: payload?.channelId } });
        if (!channel || channel.type !== "VOICE") throw new Error("Not a voice channel");

        const membership = await prisma.membership.findUnique({
          where: { userId_serverId: { userId, serverId: channel.serverId } },
        });
        if (!membership) throw new Error("Not a member of this server");
        await checkChannelPermission(userId, channel.serverId, channel.id, Permissions.VIEW_CHANNELS);

        // A socket can only be in one voice channel at a time — switching channels leaves the
        // old one first (and notifies its participants) rather than accumulating memberships.
        if (socket.data.voiceChannelId && socket.data.voiceChannelId !== payload.channelId) {
          await leaveVoice(io, socket);
        }

        const room = voiceRoom(payload.channelId);
        const existingSockets = await io.in(room).fetchSockets();
        const participants: VoiceParticipantDTO[] = [];
        for (const s of existingSockets) {
          const otherUserId = s.data.userId as string;
          const user = await prisma.user.findUnique({ where: { id: otherUserId } });
          if (user) {
            participants.push({
              userId: otherUserId,
              socketId: s.id,
              user: serializeUser(user),
              streaming: (s.data.streaming as "screen" | "camera" | undefined) ?? null,
            });
          }
        }

        await socket.join(room);
        socket.data.voiceChannelId = payload.channelId;

        const me = await prisma.user.findUnique({ where: { id: userId } });
        if (me) {
          const joinedPayload: VoiceParticipantDTO = { userId, socketId: socket.id, user: serializeUser(me) };
          io.to(room).except(socket.id).emit(ServerEvents.VOICE_PARTICIPANT_JOINED, joinedPayload);
        }
        void broadcastRoster(io, payload.channelId);

        ack?.({ ok: true, participants });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(ClientEvents.VOICE_LEAVE, () => {
    void leaveVoice(io, socket);
  });

  /**
   * Go Live state. Pure bookkeeping — the media itself still travels peer-to-peer like every
   * other track; this only stamps "what am I broadcasting" onto the socket and re-broadcasts
   * the roster, which is how LIVE badges reach members who aren't in the call. Validated to the
   * three legal values so a client can't smuggle arbitrary strings into everyone's roster.
   */
  socket.on(ClientEvents.VOICE_STREAM_STATE, (payload: { kind?: "screen" | "camera" | null }) => {
    const channelId = socket.data.voiceChannelId as string | undefined;
    if (!channelId) return;
    const kind = payload?.kind === "screen" || payload?.kind === "camera" ? payload.kind : null;
    socket.data.streaming = kind ?? undefined;
    void broadcastRoster(io, channelId);
  });

  /**
   * Soundboard.
   *
   * Signaling only, exactly like the rest of this file: the server relays "play sound X" and every
   * client fetches and plays the clip locally. Mixing the audio into the call would mean decoding
   * and re-encoding media server-side, which is the line between a signaling relay and an SFU.
   *
   * Three things are checked, and each closes a real hole:
   *
   * - The sender is actually in a voice channel. Otherwise anyone with a socket could broadcast
   *   into any call on the instance by naming a channel id.
   * - The sound belongs to the server that owns that channel. Otherwise sound ids leak across
   *   servers, the same way unchecked sticker ids would.
   * - The payload carries an id, never a URL. A client-supplied URL would be a way to make
   *   everyone else's browser fetch and play an arbitrary file — small, but it is someone else's
   *   audio device and someone else's IP address being handed to a stranger's host.
   *
   * Rate limiting is per-socket and in-memory: this is the one event in the app a bored user can
   * trigger dozens of times a second, and the failure mode is everyone else's speakers.
   */
  const soundHistory: number[] = [];
  socket.on(ClientEvents.SOUNDBOARD_PLAY, (payload: { soundId: string }) => {
    void (async () => {
      const channelId = socket.data.voiceChannelId as string | undefined;
      if (!channelId || !payload?.soundId) return;

      const now = Date.now();
      while (soundHistory.length > 0 && now - soundHistory[0] > 10_000) soundHistory.shift();
      if (soundHistory.length >= 5) return;
      soundHistory.push(now);

      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { serverId: true },
      });
      if (!channel) return;

      const sound = await prisma.soundboardSound.findUnique({ where: { id: payload.soundId } });
      if (!sound || sound.serverId !== channel.serverId) return;

      // Includes the presser: every client starts the clip off the same event, so they hear it
      // together rather than the presser hearing it a round-trip early.
      io.to(voiceRoom(channelId)).emit(ServerEvents.SOUNDBOARD_PLAY, {
        channelId,
        userId,
        soundId: sound.id,
        name: sound.name,
        audioUrl: sound.audioUrl,
      });
    })();
  });

  // Opaque relay — `data` is whatever shape the frontend's WebRTC layer wants (SDP offer/answer,
  // ICE candidate); the server doesn't parse or validate it, just forwards to one specific
  // socket by id (never a broadcast — signaling is always addressed to exactly one peer).
  socket.on(ClientEvents.VOICE_SIGNAL, (payload: { targetSocketId: string; data: unknown }) => {
    if (!payload?.targetSocketId) return;
    io.to(payload.targetSocketId).emit(ServerEvents.VOICE_SIGNAL, {
      fromSocketId: socket.id,
      fromUserId: userId,
      data: payload.data,
    });
  });
}

export async function handleVoiceDisconnect(io: SocketIOServer, socket: Socket): Promise<void> {
  await leaveVoice(io, socket);
}
