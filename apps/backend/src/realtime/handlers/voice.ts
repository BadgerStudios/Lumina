import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, ServerEvents, Permissions } from "@lumina/shared";
import type { VoiceParticipantDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeUser } from "../../lib/serialize.js";
import { checkChannelPermission } from "../../permissions/permissionService.js";

/**
 * Mesh WebRTC signaling relay — the server never touches media (no SFU, no recording, no
 * bandwidth cost beyond tiny JSON offer/answer/ICE payloads). It only does two things: track
 * room membership (who's in which voice channel) and relay opaque signaling payloads between
 * specific socket ids so browsers can establish direct peer connections with each other.
 * Deliberately socket.io ROOM membership is the only source of truth for "who's connected" —
 * no separate Redis/DB table — since the existing @socket.io/redis-adapter (see realtime/io.ts)
 * already makes room membership correct across multiple backend instances for free via
 * `io.in(room).fetchSockets()`.
 *
 * A "voice key" identifies a call: a bare channel id for a server VOICE/STAGE channel, or
 * `dm:<conversationId>` for a 1:1/group DM call. Everything below is keyed on that string, so the
 * same relay powers server voice, stage channels and DM calls with no parallel machinery.
 *
 * Scale note: mesh means every participant holds a direct peer connection to every other
 * participant — bandwidth/CPU cost grows ~O(n²) per participant. Fine for small calls and small
 * stages (a handful of speakers), not a substitute for a real SFU for large audiences — a
 * deliberate v1 scope decision. Note too that on a mesh the "audience can't speak" rule is
 * cooperative (an audience client simply publishes no mic track); true enforcement needs an SFU.
 */
function voiceRoom(voiceKey: string): string {
  return `voice:${voiceKey}`;
}

const DM_PREFIX = "dm:";
function isDmKey(voiceKey: string): boolean {
  return voiceKey.startsWith(DM_PREFIX);
}
function dmKey(conversationId: string): string {
  return `${DM_PREFIX}${conversationId}`;
}

/** Build the participant list for a call from live socket state (streaming/stage role/hand). */
async function buildParticipants(io: SocketIOServer, voiceKey: string): Promise<VoiceParticipantDTO[]> {
  const sockets = await io.in(voiceRoom(voiceKey)).fetchSockets();
  const participants: VoiceParticipantDTO[] = [];
  for (const s of sockets) {
    const otherUserId = s.data.userId as string;
    const user = await prisma.user.findUnique({ where: { id: otherUserId } });
    if (!user) continue;
    const stageRole = s.data.stageRole as "speaker" | "audience" | undefined;
    participants.push({
      userId: otherUserId,
      socketId: s.id,
      user: serializeUser(user),
      streaming: (s.data.streaming as "screen" | "camera" | undefined) ?? null,
      ...(stageRole ? { stageRole, handRaised: Boolean(s.data.handRaised) } : {}),
    });
  }
  return participants;
}

/**
 * Broadcast the current roster to everyone who should see it WITHOUT necessarily being in the call:
 * for a server channel that's the whole server room (so a LIVE badge/roster shows in the sidebar);
 * for a DM call it's the conversation room (so the other party sees the call is active). Sends the
 * full list rather than a delta so a client that's never connected can build its roster in one event.
 */
async function broadcastRoster(io: SocketIOServer, voiceKey: string): Promise<void> {
  const participants = await buildParticipants(io, voiceKey);
  let target: string;
  if (isDmKey(voiceKey)) {
    target = dmKey(voiceKey.slice(DM_PREFIX.length)); // the `dm:<conversationId>` socket room
  } else {
    const channel = await prisma.channel.findUnique({ where: { id: voiceKey }, select: { serverId: true } });
    if (!channel) return;
    target = `server:${channel.serverId}`;
  }
  io.to(target).emit(ServerEvents.VOICE_ROSTER_UPDATE, { channelId: voiceKey, participants });
}

async function leaveVoice(io: SocketIOServer, socket: Socket): Promise<void> {
  const voiceKey = socket.data.voiceChannelId as string | undefined;
  if (!voiceKey) return;
  const room = voiceRoom(voiceKey);
  await socket.leave(room);
  socket.data.voiceChannelId = undefined;
  socket.data.streaming = undefined;
  socket.data.stageRole = undefined;
  socket.data.handRaised = undefined;
  io.to(room).emit(ServerEvents.VOICE_PARTICIPANT_LEFT, { userId: socket.data.userId as string, socketId: socket.id });
  void broadcastRoster(io, voiceKey);
}

/** Resolve and authorize the call the socket wants to join, returning its voice key + (stage) role. */
async function resolveJoinTarget(
  userId: string,
  payload: { channelId?: string; conversationId?: string },
): Promise<{ voiceKey: string; stageRole?: "speaker" | "audience" }> {
  if (payload.conversationId) {
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: payload.conversationId, userId } },
      select: { id: true },
    });
    if (!participant) throw new Error("Not a participant in this conversation");
    return { voiceKey: dmKey(payload.conversationId) };
  }

  const channel = await prisma.channel.findUnique({ where: { id: payload.channelId } });
  if (!channel || (channel.type !== "VOICE" && channel.type !== "STAGE")) throw new Error("Not a voice channel");
  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId, serverId: channel.serverId } },
    select: { id: true },
  });
  if (!membership) throw new Error("Not a member of this server");
  await checkChannelPermission(userId, channel.serverId, channel.id, Permissions.VIEW_CHANNELS);

  if (channel.type === "STAGE") {
    // Moderators (those who could manage the channel) open the stage as speakers; everyone else
    // starts in the audience and raises a hand to be promoted.
    let stageRole: "speaker" | "audience" = "audience";
    try {
      await checkChannelPermission(userId, channel.serverId, channel.id, Permissions.MANAGE_CHANNELS);
      stageRole = "speaker";
    } catch {
      stageRole = "audience";
    }
    return { voiceKey: channel.id, stageRole };
  }
  return { voiceKey: channel.id };
}

export function registerVoiceHandlers(io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;

  socket.on(
    ClientEvents.VOICE_JOIN,
    async (
      payload: { channelId?: string; conversationId?: string },
      ack?: (res: {
        ok: boolean;
        participants?: VoiceParticipantDTO[];
        stageRole?: "speaker" | "audience";
        error?: string;
      }) => void,
    ) => {
      try {
        const { voiceKey, stageRole } = await resolveJoinTarget(userId, payload ?? {});

        // A socket can only be in one call at a time — switching leaves the old one first.
        if (socket.data.voiceChannelId && socket.data.voiceChannelId !== voiceKey) {
          await leaveVoice(io, socket);
        }

        const room = voiceRoom(voiceKey);
        const participants = await buildParticipants(io, voiceKey);

        await socket.join(room);
        socket.data.voiceChannelId = voiceKey;
        socket.data.stageRole = stageRole;
        socket.data.handRaised = false;

        const me = await prisma.user.findUnique({ where: { id: userId } });
        if (me) {
          const joinedPayload: VoiceParticipantDTO = {
            userId,
            socketId: socket.id,
            user: serializeUser(me),
            ...(stageRole ? { stageRole, handRaised: false } : {}),
          };
          io.to(room).except(socket.id).emit(ServerEvents.VOICE_PARTICIPANT_JOINED, joinedPayload);
        }
        void broadcastRoster(io, voiceKey);

        ack?.({ ok: true, participants });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(ClientEvents.VOICE_LEAVE, () => {
    void leaveVoice(io, socket);
  });

  socket.on(ClientEvents.VOICE_STREAM_STATE, (payload: { kind?: "screen" | "camera" | null }) => {
    const voiceKey = socket.data.voiceChannelId as string | undefined;
    if (!voiceKey) return;
    const kind = payload?.kind === "screen" || payload?.kind === "camera" ? payload.kind : null;
    socket.data.streaming = kind ?? undefined;
    void broadcastRoster(io, voiceKey);
  });

  // --- Stage channels -------------------------------------------------------------------------

  // An audience member raises/lowers a hand. Speakers have nothing to raise. Rebroadcasts so
  // moderators see the request appear in the roster.
  socket.on(ClientEvents.STAGE_HAND, (payload: { raised?: boolean }) => {
    const voiceKey = socket.data.voiceChannelId as string | undefined;
    if (!voiceKey || socket.data.stageRole !== "audience") return;
    socket.data.handRaised = Boolean(payload?.raised);
    void broadcastRoster(io, voiceKey);
  });

  // A moderator promotes/demotes a participant between speaker and audience. Authorized against
  // the stage channel's MANAGE_CHANNELS; the change is pushed to the target so its client can
  // start (speaker) or stop (audience) publishing a microphone track.
  socket.on(ClientEvents.STAGE_SET_ROLE, (payload: { targetSocketId: string; role: "speaker" | "audience" }) => {
    void (async () => {
      const voiceKey = socket.data.voiceChannelId as string | undefined;
      if (!voiceKey || isDmKey(voiceKey)) return;
      if (payload?.role !== "speaker" && payload?.role !== "audience") return;
      try {
        const channel = await prisma.channel.findUnique({ where: { id: voiceKey }, select: { serverId: true, type: true } });
        if (!channel || channel.type !== "STAGE") return;
        await checkChannelPermission(userId, channel.serverId, voiceKey, Permissions.MANAGE_CHANNELS);
        const peers = await io.in(voiceRoom(voiceKey)).fetchSockets();
        const target = peers.find((p) => p.id === payload.targetSocketId);
        if (!target) return;
        target.data.stageRole = payload.role;
        if (payload.role === "speaker") target.data.handRaised = false;
        io.to(payload.targetSocketId).emit(ServerEvents.STAGE_ROLE_SET, { channelId: voiceKey, stageRole: payload.role });
        void broadcastRoster(io, voiceKey);
      } catch {
        /* not a moderator — ignore */
      }
    })();
  });

  // --- DM calls -------------------------------------------------------------------------------

  // Ring the other participants of a DM the caller belongs to. They answer with an ordinary
  // VOICE_JOIN on the conversation; the media path is identical to any other call.
  socket.on(ClientEvents.CALL_RING, (payload: { conversationId: string }) => {
    void (async () => {
      if (!payload?.conversationId) return;
      const me = await prisma.dMParticipant.findUnique({
        where: { conversationId_userId: { conversationId: payload.conversationId, userId } },
        select: { id: true },
      });
      if (!me) return;
      const others = await prisma.dMParticipant.findMany({
        where: { conversationId: payload.conversationId, userId: { not: userId } },
        select: { userId: true },
      });
      const caller = await prisma.user.findUnique({ where: { id: userId } });
      if (!caller) return;
      for (const o of others) {
        io.to(`user:${o.userId}`).emit(ServerEvents.CALL_INCOMING, {
          conversationId: payload.conversationId,
          from: serializeUser(caller),
        });
      }
    })();
  });

  // Decline a ring — tells the conversation the call attempt ended (the caller stops ringing).
  socket.on(ClientEvents.CALL_DECLINE, (payload: { conversationId: string }) => {
    void (async () => {
      if (!payload?.conversationId) return;
      const me = await prisma.dMParticipant.findUnique({
        where: { conversationId_userId: { conversationId: payload.conversationId, userId } },
        select: { id: true },
      });
      if (!me) return;
      io.to(dmKey(payload.conversationId)).emit(ServerEvents.CALL_ENDED, { conversationId: payload.conversationId });
    })();
  });

  /**
   * Soundboard. Signaling only — the server relays "play sound X" and every client fetches and
   * plays the clip locally. Three checks each close a real hole (sender is in the call, the sound
   * belongs to the channel's server, and the payload is an id never a URL), and a per-socket
   * in-memory rate limit caps the one event a bored user can spam into everyone's speakers.
   * Restricted to server channels (a DM call has no server-scoped soundboard).
   */
  const soundHistory: number[] = [];
  socket.on(ClientEvents.SOUNDBOARD_PLAY, (payload: { soundId: string }) => {
    void (async () => {
      const voiceKey = socket.data.voiceChannelId as string | undefined;
      if (!voiceKey || isDmKey(voiceKey) || !payload?.soundId) return;

      const now = Date.now();
      while (soundHistory.length > 0 && now - soundHistory[0] > 10_000) soundHistory.shift();
      if (soundHistory.length >= 5) return;
      soundHistory.push(now);

      const channel = await prisma.channel.findUnique({ where: { id: voiceKey }, select: { serverId: true } });
      if (!channel) return;

      const sound = await prisma.soundboardSound.findUnique({ where: { id: payload.soundId } });
      if (!sound || sound.serverId !== channel.serverId) return;

      io.to(voiceRoom(voiceKey)).emit(ServerEvents.SOUNDBOARD_PLAY, {
        channelId: voiceKey,
        userId,
        soundId: sound.id,
        name: sound.name,
        audioUrl: sound.audioUrl,
      });
    })();
  });

  // Opaque relay — `data` is whatever shape the frontend's WebRTC layer wants (SDP offer/answer,
  // ICE candidate); forwarded to one specific socket by id, never broadcast. The sender must be in
  // a call and the target must be a peer in that SAME call.
  socket.on(ClientEvents.VOICE_SIGNAL, (payload: { targetSocketId: string; data: unknown }) => {
    if (!payload?.targetSocketId) return;
    const voiceKey = socket.data.voiceChannelId as string | undefined;
    if (!voiceKey) return;
    void (async () => {
      const peers = await io.in(voiceRoom(voiceKey)).fetchSockets();
      if (!peers.some((p) => p.id === payload.targetSocketId)) return;
      io.to(payload.targetSocketId).emit(ServerEvents.VOICE_SIGNAL, {
        fromSocketId: socket.id,
        fromUserId: userId,
        data: payload.data,
      });
    })();
  });
}

export async function handleVoiceDisconnect(io: SocketIOServer, socket: Socket): Promise<void> {
  await leaveVoice(io, socket);
}
