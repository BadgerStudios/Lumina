import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, useOPUS, type RTCIceServer } from "werift";
import type { Socket as ClientSocket } from "socket.io-client";
import { ClientEvents, ServerEvents, type VoiceParticipantDTO } from "@lumina/shared";

/**
 * A bot's seat in a Lumina voice channel.
 *
 * Lumina voice is a browser-to-browser WebRTC mesh signalled over Socket.IO with "perfect
 * negotiation" (the polite side is the one with the lower socket id — store/voiceStore.ts). The
 * bot's translator socket joins the channel exactly like a browser would; this class then holds
 * one werift peer connection per human participant, speaks the same signalling those browsers
 * speak, and moves opus RTP in both directions:
 *
 *   Discord voice leg (UDP, decrypted by voice/server.ts) ──writeBotAudio──▶ every peer
 *   every peer ──onIncomingAudio──▶ voice/server.ts (encrypted, sent to the bot with a per-person SSRC)
 *
 * Opus is opus on both sides (48 kHz), so packets pass through untouched apart from their RTP
 * header fields, which the sender rewrites for each connection.
 */

interface PeerEntry {
  pc: RTCPeerConnection;
  userId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** The bot's audio into this person's ear. */
  outbound: MediaStreamTrack;
  /** Candidates that arrived before the remote description; werift cannot hold them itself. */
  remoteSet: boolean;
  pendingCandidates: unknown[];
}

export interface MeshBridgeOptions {
  /** The bot's translator socket, already connected and in the space's rooms. */
  internal: ClientSocket;
  iceServers: RTCIceServer[];
  /** Public addresses to advertise as host candidates (the container's own are private). */
  additionalHostAddresses?: string[];
  /** UDP ports werift may bind for ICE; published through the container so reflexive candidates work. */
  icePortRange?: [number, number];
  /** A person's opus RTP, as it arrives from their browser. */
  onIncomingAudio: (fromSocketId: string, fromUserId: string, rtp: RtpPacket) => void;
  /** Someone entered (true) or left (false) the channel while the bot was in it. */
  onParticipant?: (userId: string, present: boolean) => void;
  log?: (line: string) => void;
}

export class MeshBridge {
  private readonly peers = new Map<string, PeerEntry>();
  private channelId: string | null = null;
  private listenersAttached = false;
  private readonly handlers: Array<[string, (...args: never[]) => void]> = [];

  constructor(private readonly opts: MeshBridgeOptions) {}

  get joinedChannelId(): string | null {
    return this.channelId;
  }

  /** Joins the channel as the bot and opens a connection to everyone already there. */
  async join(channelId: string): Promise<VoiceParticipantDTO[]> {
    this.attachListeners();
    const participants = await new Promise<VoiceParticipantDTO[]>((resolve, reject) => {
      this.opts.internal.emit(
        ClientEvents.VOICE_JOIN,
        { channelId },
        (res: { ok: boolean; participants?: VoiceParticipantDTO[]; error?: string }) => {
          if (res?.ok) resolve(res.participants ?? []);
          else reject(new Error(res?.error ?? "voice join refused"));
        },
      );
    });
    this.channelId = channelId;
    for (const p of participants) {
      if (p.socketId === this.opts.internal.id) continue;
      await this.connectTo(p.socketId, p.userId, true);
    }
    return participants;
  }

  /** Leaves the channel and tears every connection down. */
  leave(): void {
    for (const socketId of [...this.peers.keys()]) this.closePeer(socketId);
    if (this.channelId) this.opts.internal.emit(ClientEvents.VOICE_LEAVE);
    this.channelId = null;
    this.detachListeners();
  }

  /** The bot's audio, one RTP packet, to everyone in the channel. */
  writeBotAudio(rtp: RtpPacket): void {
    for (const entry of this.peers.values()) {
      if (entry.pc.connectionState !== "connected") continue;
      // A fresh packet per peer: each sender rewrites SSRC and payload type for its own connection.
      const header = new RtpHeader({
        marker: rtp.header.marker,
        payloadType: rtp.header.payloadType,
        sequenceNumber: rtp.header.sequenceNumber,
        timestamp: rtp.header.timestamp,
        ssrc: rtp.header.ssrc,
      });
      entry.outbound.writeRtp(new RtpPacket(header, rtp.payload));
    }
  }

  get peerCount(): number {
    return this.peers.size;
  }

  // ---------------------------------------------------------------- signalling

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    const s = this.opts.internal;
    const on = (event: string, handler: (...args: never[]) => void) => {
      s.on(event, handler as never);
      this.handlers.push([event, handler]);
    };
    on(ServerEvents.VOICE_PARTICIPANT_JOINED, (p: VoiceParticipantDTO) => {
      if (!this.channelId || p.socketId === s.id) return;
      this.opts.onParticipant?.(p.userId, true);
      // The newcomer creates connections to everyone in the room and offers; we do the same from
      // our side, and perfect negotiation settles the collision.
      void this.connectTo(p.socketId, p.userId, true);
    });
    on(ServerEvents.VOICE_PARTICIPANT_LEFT, (p: { userId: string; socketId: string }) => {
      this.closePeer(p.socketId);
      this.opts.onParticipant?.(p.userId, false);
    });
    on(ServerEvents.VOICE_SIGNAL, (payload: { fromSocketId: string; fromUserId: string; data: { description?: { type: string; sdp: string }; candidate?: unknown } }) => {
      void this.handleSignal(payload);
    });
  }

  private detachListeners(): void {
    for (const [event, handler] of this.handlers) this.opts.internal.off(event, handler as never);
    this.handlers.length = 0;
    this.listenersAttached = false;
  }

  private signal(targetSocketId: string, data: unknown): void {
    this.opts.internal.emit(ClientEvents.VOICE_SIGNAL, { targetSocketId, data });
  }

  private async connectTo(socketId: string, userId: string, offer: boolean): Promise<PeerEntry> {
    const existing = this.peers.get(socketId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers,
      codecs: { audio: [useOPUS()] },
      ...(this.opts.additionalHostAddresses?.length ? { iceAdditionalHostAddresses: this.opts.additionalHostAddresses } : {}),
      ...(this.opts.icePortRange ? { icePortRange: this.opts.icePortRange } : {}),
    });
    const mySocketId = this.opts.internal.id ?? "";
    const entry: PeerEntry = {
      pc,
      userId,
      polite: mySocketId < socketId,
      makingOffer: false,
      ignoreOffer: false,
      outbound: new MediaStreamTrack({ kind: "audio" }),
      remoteSet: false,
      pendingCandidates: [],
    };
    this.peers.set(socketId, entry);
    pc.addTrack(entry.outbound);

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) this.signal(socketId, { candidate: candidate.toJSON() });
    });
    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      track.onReceiveRtp.subscribe((rtp) => this.opts.onIncomingAudio(socketId, userId, rtp));
    });
    pc.connectionStateChange.subscribe((state) => {
      this.opts.log?.(`peer ${socketId} (${userId}) ${state}`);
      if (state === "failed" || state === "closed") this.closePeer(socketId);
    });

    if (offer) await this.makeOffer(socketId, entry);
    return entry;
  }

  private async makeOffer(socketId: string, entry: PeerEntry): Promise<void> {
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.signal(socketId, { description: sdpInit(entry.pc.localDescription!) });
    } catch (err) {
      this.opts.log?.(`offer to ${socketId} failed: ${(err as Error).message}`);
    } finally {
      entry.makingOffer = false;
    }
  }

  /** Perfect negotiation, mirroring store/voiceStore.ts handleSignal. */
  private async handleSignal(payload: { fromSocketId: string; fromUserId: string; data: { description?: { type: string; sdp: string }; candidate?: unknown } }): Promise<void> {
    if (!this.channelId) return;
    const { fromSocketId, fromUserId, data } = payload;
    const entry = await this.connectTo(fromSocketId, fromUserId, false);
    const { pc } = entry;
    try {
      if (data.description) {
        const offerCollision = data.description.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return;
        await pc.setRemoteDescription(data.description as never);
        entry.remoteSet = true;
        for (const c of entry.pendingCandidates.splice(0)) await pc.addIceCandidate(c as never).catch(() => undefined);
        if (data.description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signal(fromSocketId, { description: sdpInit(pc.localDescription!) });
        }
      } else if (data.candidate) {
        // Browsers send an empty candidate to mark the end of gathering; werift wants none.
        const cand = data.candidate as { candidate?: string };
        if (!cand.candidate) return;
        if (!entry.remoteSet) {
          entry.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate as never);
        } catch (err) {
          if (!entry.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.opts.log?.(`signal from ${fromSocketId} failed: ${(err as Error).message}`);
    }
  }

  private closePeer(socketId: string): void {
    const entry = this.peers.get(socketId);
    if (!entry) return;
    this.peers.delete(socketId);
    void entry.pc.close().catch(() => undefined);
  }
}

/** The plain {type, sdp} a browser's setRemoteDescription wants. */
function sdpInit(desc: { type: string; sdp: string }): { type: string; sdp: string } {
  return { type: desc.type, sdp: desc.sdp };
}
