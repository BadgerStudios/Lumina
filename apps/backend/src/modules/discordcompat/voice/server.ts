import dgram from "node:dgram";
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { RtpHeader, RtpPacket, type RTCIceServer } from "werift";
import type { Socket as ClientSocket } from "socket.io-client";
import { env } from "../../../config/env.js";
import { prisma } from "../../../db/prisma.js";
import { fromSnowflake, toSnowflake } from "../ids.js";
import { MeshBridge } from "./bridge.js";
import {
  ENCRYPTION_MODES,
  cryptoReady,
  decryptRtp,
  encryptRtp,
  ipDiscoveryReply,
  isEncryptionMode,
  newSecretKey,
  parseIpDiscovery,
  rtpHeader,
  type EncryptionMode,
} from "./crypto.js";

/**
 * Discord's voice server, for bots that expect one.
 *
 * A bot joins voice by sending op 4 on the main gateway. Discord answers with VOICE_STATE_UPDATE
 * and VOICE_SERVER_UPDATE; the bot then opens a second WebSocket to the voice endpoint, learns
 * its public address over UDP (IP discovery), picks an encryption mode, and streams encrypted
 * opus RTP to the voice server's UDP port. This module is that endpoint and that UDP port, and
 * for every session it holds a MeshBridge — the bot's seat in Lumina's browser-to-browser voice
 * mesh — so what the bot sends is what the people in the channel hear, and what they say is
 * what the bot receives.
 *
 * Voice gateway v4 is spoken; v8 clients (DAVE end-to-end encryption) are answered with
 * dave_protocol_version 0, which they take to mean "transport encryption only".
 */

const HEARTBEAT_INTERVAL_MS = 13_750;
const RESUME_GRACE_MS = 20_000;
const TURN_CREDENTIAL_TTL_S = 6 * 3600;

interface HumanLeg {
  ssrc: number;
  sequence: number;
  announced: boolean;
  lastPacketAt: number;
}

export interface VoiceSession {
  token: string;
  sessionId: string;
  guildSnow: string;
  serverId: string;
  channelId: string;
  channelSnow: string;
  botUserId: string;
  botUserSnow: string;
  ssrc: number;
  mode: EncryptionMode | null;
  secretKey: Buffer;
  remote: { address: string; port: number } | null;
  ws: WebSocket | null;
  bridge: MeshBridge;
  humans: Map<string, HumanLeg>;
  nonceCounter: number;
  packetsIn: number;
  packetsOut: number;
  resumeTimer: NodeJS.Timeout | null;
  /** v8 frame sequence: libraries ack it (seq_ack) and discord.js ignores a 0, so it starts at 1. */
  seq: number;
  /** Dispatches a gateway event to the bot's main gateway session. */
  dispatch: (t: string, d: unknown) => void;
  onEnded: () => void;
}

export interface VoiceStateRequest {
  guild_id?: string;
  channel_id?: string | null;
  self_mute?: boolean;
  self_deaf?: boolean;
}

/**
 * STUN first: werift can only make host candidates on addresses it can bind, and inside the
 * container that is a private one nobody outside can reach. A reflexive candidate from STUN
 * carries the box's public IP with the same UDP port (Docker keeps the source port), and that
 * port sits in the range published on the container — so browsers connect directly. TURN via
 * coturn is the fallback for anyone who cannot.
 */
function bridgeIceServers(userId: string): RTCIceServer[] {
  const stun: RTCIceServer[] = [{ urls: [`stun:${env.TURN_HOST}:${env.TURN_PORT}`, "stun:stun.l.google.com:19302"] }];
  return [...stun, ...turnIceServers(userId)];
}

function turnIceServers(userId: string): RTCIceServer[] {
  if (!env.TURN_SECRET) return [];
  const expiresAt = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_S;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");
  const turnUrl = `turn:${env.TURN_HOST}:${env.TURN_PORT}`;
  return [{ urls: [`${turnUrl}?transport=udp`, `${turnUrl}?transport=tcp`], username, credential }];
}

export class DiscordVoiceServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private udp: dgram.Socket | null = null;
  private readonly byToken = new Map<string, VoiceSession>();
  private readonly byRemote = new Map<string, VoiceSession>();
  private readonly bySsrc = new Map<number, VoiceSession>();

  constructor(private readonly log: (line: string) => void = (l) => console.log(`[discord-voice] ${l}`)) {}

  get enabled(): boolean {
    return !!env.DISCORD_VOICE_PUBLIC_IP;
  }

  /** The `endpoint` handed to bots in VOICE_SERVER_UPDATE: host[/path], no scheme. */
  get endpoint(): string {
    if (env.DISCORD_VOICE_ENDPOINT) return env.DISCORD_VOICE_ENDPOINT;
    const origin = env.PUBLIC_APP_URL.split(",")[0].trim().replace(/\/+$/, "");
    return `${origin.replace(/^https?:\/\//, "")}/discord/voice`;
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      this.log("disabled: DISCORD_VOICE_PUBLIC_IP is not set");
      return;
    }
    await cryptoReady();
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg, rinfo) => this.onUdp(msg, rinfo));
    udp.on("error", (err) => this.log(`udp error: ${err.message}`));
    await new Promise<void>((resolve) => udp.bind(env.DISCORD_VOICE_UDP_PORT, "0.0.0.0", resolve));
    this.udp = udp;
    this.wss.on("connection", (ws) => this.onSocket(ws));
    this.log(`listening: wss endpoint ${this.endpoint}, udp ${env.DISCORD_VOICE_PUBLIC_IP}:${env.DISCORD_VOICE_UDP_PORT}`);
  }

  /** Claims `/discord/voice` upgrades; the main gateway keeps `/discord/gateway`. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = request.url ?? "";
    if (!/^\/discord\/voice\/?(\?|$)/.test(url)) return false;
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
    return true;
  }

  // ---------------------------------------------------------------- gateway side

  /**
   * The bot's op 4. Joining: the bot's translator socket takes a seat in the Lumina voice channel,
   * then the bot is told where its voice server is. Leaving (channel_id null): everything down.
   */
  async onVoiceStateUpdate(params: {
    botUserId: string;
    internal: ClientSocket;
    request: VoiceStateRequest;
    dispatch: (t: string, d: unknown) => void;
    current: VoiceSession | null;
  }): Promise<VoiceSession | null> {
    const { request, current } = params;
    if (!this.enabled) return current;
    if (!request.channel_id) {
      if (current) this.end(current, "bot left");
      return null;
    }
    const channelId = await fromSnowflake("channel", String(request.channel_id));
    const channel = channelId ? await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true } }) : null;
    if (!channel || (channel.type !== "VOICE" && channel.type !== "STAGE")) {
      this.log(`join refused: ${request.channel_id} is not a voice channel`);
      return current;
    }
    if (current && current.channelId === channel.id) return current;
    if (current) this.end(current, "moving channel");

    const guildSnow = await toSnowflake("guild", channel.serverId);
    const botUserSnow = await toSnowflake("user", params.botUserId);
    const session: VoiceSession = {
      token: randomBytes(24).toString("hex"),
      sessionId: randomBytes(16).toString("hex"),
      guildSnow,
      serverId: channel.serverId,
      channelId: channel.id,
      channelSnow: String(request.channel_id),
      botUserId: params.botUserId,
      botUserSnow,
      ssrc: randomBytes(4).readUInt32BE(0) >>> 1 || 1,
      mode: null,
      secretKey: newSecretKey(),
      remote: null,
      ws: null,
      bridge: new MeshBridge({
        internal: params.internal,
        iceServers: bridgeIceServers(params.botUserId),
        icePortRange: [env.DISCORD_VOICE_ICE_PORT_MIN, env.DISCORD_VOICE_ICE_PORT_MAX],
        onIncomingAudio: (socketId, userId, rtp) => this.forwardToBot(session, socketId, userId, rtp),
        onParticipant: (userId, present) => void this.announceParticipant(session, userId, present),
        log: (line) => this.log(`bridge ${params.botUserId}: ${line}`),
      }),
      humans: new Map(),
      nonceCounter: 0,
      packetsIn: 0,
      packetsOut: 0,
      resumeTimer: null,
      seq: 0,
      dispatch: params.dispatch,
      onEnded: () => undefined,
    };
    let participants;
    try {
      participants = await session.bridge.join(channel.id);
    } catch (err) {
      this.log(`join failed for ${params.botUserId}: ${(err as Error).message}`);
      return current;
    }
    this.byToken.set(session.token, session);
    this.bySsrc.set(session.ssrc, session);

    session.dispatch("VOICE_STATE_UPDATE", await this.voiceState(session, params.botUserId, true, request));
    for (const p of participants) {
      if (p.userId !== params.botUserId) session.dispatch("VOICE_STATE_UPDATE", await this.voiceState(session, p.userId, true));
    }
    session.dispatch("VOICE_SERVER_UPDATE", { token: session.token, guild_id: guildSnow, endpoint: this.endpoint });
    this.log(`bot ${params.botUserId} joining ${channel.id} (${participants.length} already there)`);
    return session;
  }

  /** The bot's main gateway went away: its voice goes too. */
  endForGateway(session: VoiceSession | null): void {
    if (session) this.end(session, "gateway closed");
  }

  private async voiceState(session: VoiceSession, userId: string, present: boolean, req?: VoiceStateRequest) {
    const userSnow = await toSnowflake("user", userId);
    return {
      guild_id: session.guildSnow,
      channel_id: present ? session.channelSnow : null,
      user_id: userSnow,
      session_id: userId === session.botUserId ? session.sessionId : `lumina-${userId}`,
      deaf: false,
      mute: false,
      self_deaf: !!req?.self_deaf,
      self_mute: !!req?.self_mute,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    };
  }

  private async announceParticipant(session: VoiceSession, userId: string, present: boolean): Promise<void> {
    session.dispatch("VOICE_STATE_UPDATE", await this.voiceState(session, userId, present));
    if (!present) {
      for (const [socketId, leg] of session.humans) {
        if (socketId.startsWith(`${userId}|`)) {
          this.sendJson(session, 13, { user_id: await toSnowflake("user", userId) }); // CLIENT_DISCONNECT
          session.humans.delete(socketId);
          void leg;
        }
      }
    }
  }

  private end(session: VoiceSession, reason: string): void {
    this.log(`session for ${session.botUserId} ended: ${reason} (in ${session.packetsIn}, out ${session.packetsOut})`);
    if (session.resumeTimer) clearTimeout(session.resumeTimer);
    this.byToken.delete(session.token);
    this.bySsrc.delete(session.ssrc);
    if (session.remote) this.byRemote.delete(`${session.remote.address}:${session.remote.port}`);
    session.bridge.leave();
    try {
      session.ws?.close(4014, "Disconnected");
    } catch {
      /* already gone */
    }
    session.ws = null;
    session.onEnded();
  }

  // ---------------------------------------------------------------- voice websocket

  private sendJson(session: VoiceSession, op: number, d: unknown): void {
    if (session.ws?.readyState !== WebSocket.OPEN) return;
    session.seq += 1;
    session.ws.send(JSON.stringify({ op, d, seq: session.seq }));
  }

  private onSocket(ws: WebSocket): void {
    let session: VoiceSession | null = null;
    ws.send(JSON.stringify({ op: 8, d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS } }));
    ws.on("message", (raw) => {
      let packet: { op?: number; d?: unknown };
      try {
        packet = JSON.parse(String(raw));
      } catch {
        ws.close(4002, "Decode error");
        return;
      }
      const d = (packet.d ?? {}) as Record<string, unknown>;
      switch (packet.op) {
        case 0: {
          // IDENTIFY
          const found = this.byToken.get(String(d.token ?? ""));
          if (!found || String(d.server_id ?? "") !== found.guildSnow) {
            ws.close(4004, "Authentication failed");
            return;
          }
          session = found;
          if (session.resumeTimer) {
            clearTimeout(session.resumeTimer);
            session.resumeTimer = null;
          }
          session.ws = ws;
          this.sendJson(session, 2, {
            ssrc: session.ssrc,
            ip: env.DISCORD_VOICE_PUBLIC_IP,
            port: env.DISCORD_VOICE_UDP_PORT,
            modes: [...ENCRYPTION_MODES],
            heartbeat_interval: HEARTBEAT_INTERVAL_MS,
          });
          break;
        }
        case 7: {
          // RESUME
          const found = this.byToken.get(String(d.token ?? ""));
          if (!found || String(d.session_id ?? "") !== found.sessionId) {
            ws.close(4006, "Session no longer valid");
            return;
          }
          session = found;
          if (session.resumeTimer) {
            clearTimeout(session.resumeTimer);
            session.resumeTimer = null;
          }
          session.ws = ws;
          this.sendJson(session, 9, null); // discord.py indexes msg['d']: present, null
          break;
        }
        case 1: {
          // SELECT_PROTOCOL
          if (!session) return;
          const data = (d.data ?? {}) as { address?: string; port?: number; mode?: string };
          if (!isEncryptionMode(data.mode)) {
            ws.close(4016, "Unknown encryption mode");
            return;
          }
          session.mode = data.mode;
          if (data.address && data.port) this.bindRemote(session, data.address, Number(data.port));
          this.sendJson(session, 4, {
            mode: session.mode,
            secret_key: [...session.secretKey],
            dave_protocol_version: 0,
          });
          this.log(`session for ${session.botUserId}: ${session.mode}, remote ${data.address}:${data.port}`);
          break;
        }
        case 3: {
          // HEARTBEAT: v8 sends {t, seq_ack} and wants {t} back (JDA parses d.t); older clients send a
          // bare nonce and want it echoed.
          const beat = packet.d;
          const ack = beat && typeof beat === "object" ? { t: (beat as { t?: number }).t ?? Date.now() } : (beat ?? null);
          ws.send(JSON.stringify({ op: 6, d: ack }));
          break;
        }
        case 5: // SPEAKING — the bot's own SSRC is already known; nothing to route
          break;
        default:
          break; // DAVE ops and anything newer are ignored, as unknown ops are on Discord
      }
    });
    ws.on("close", () => {
      if (!session || session.ws !== ws) return;
      session.ws = null;
      // Libraries resume after a hiccup; give them a moment before treating this as a leave.
      const s = session;
      s.resumeTimer = setTimeout(() => {
        if (!s.ws) this.end(s, "voice socket closed without resume");
      }, RESUME_GRACE_MS);
    });
  }

  private bindRemote(session: VoiceSession, address: string, port: number): void {
    if (session.remote) this.byRemote.delete(`${session.remote.address}:${session.remote.port}`);
    session.remote = { address, port };
    this.byRemote.set(`${address}:${port}`, session);
  }

  // ---------------------------------------------------------------- udp

  private onUdp(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const discovery = parseIpDiscovery(msg);
    if (discovery) {
      const session = this.bySsrc.get(discovery.ssrc);
      if (!session) return;
      this.bindRemote(session, rinfo.address, rinfo.port);
      this.udp?.send(ipDiscoveryReply(discovery.ssrc, rinfo.address, rinfo.port), rinfo.port, rinfo.address);
      return;
    }
    if (msg.length < 12 || (msg[0] & 0xc0) !== 0x80) return; // not RTP v2 (RTCP and keepalives land here too)
    const session = this.byRemote.get(`${rinfo.address}:${rinfo.port}`) ?? this.bySsrc.get(msg.readUInt32BE(8));
    if (!session || !session.mode) return;
    const payloadType = msg[1] & 0x7f;
    if (payloadType >= 72 && payloadType <= 76) return; // RTCP compound packets share the port
    const out = decryptRtp(session.mode, session.secretKey, msg);
    if (!out) return;
    session.packetsIn += 1;
    const header = RtpHeader.deSerialize(out.header);
    session.bridge.writeBotAudio(new RtpPacket(header, out.payload));
  }

  /** A person's opus, into the bot: their own SSRC, announced once, then encrypted like the bot's. */
  private forwardToBot(session: VoiceSession, socketId: string, userId: string, rtp: RtpPacket): void {
    if (!session.remote || !session.mode || !this.udp) return;
    const key = `${userId}|${socketId}`;
    let leg = session.humans.get(key);
    if (!leg) {
      leg = { ssrc: (randomBytes(4).readUInt32BE(0) >>> 1) || 2, sequence: 0, announced: false, lastPacketAt: 0 };
      session.humans.set(key, leg);
    }
    if (!leg.announced) {
      leg.announced = true;
      void toSnowflake("user", userId).then((userSnow) => {
        this.sendJson(session, 12, { user_id: userSnow, audio_ssrc: leg!.ssrc, video_ssrc: 0 }); // CLIENT_CONNECT
        this.sendJson(session, 5, { user_id: userSnow, ssrc: leg!.ssrc, speaking: 1, delay: 0 });
      });
    }
    leg.lastPacketAt = Date.now();
    leg.sequence = (leg.sequence + 1) & 0xffff;
    const header = rtpHeader(leg.sequence, rtp.header.timestamp, leg.ssrc, false);
    session.nonceCounter = (session.nonceCounter + 1) >>> 0;
    const packet = encryptRtp(session.mode, session.secretKey, header, rtp.payload, session.nonceCounter);
    this.udp.send(packet, session.remote.port, session.remote.address);
    session.packetsOut += 1;
  }
}

export const discordVoiceServer = new DiscordVoiceServer();
