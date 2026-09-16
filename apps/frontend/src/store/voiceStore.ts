import { create } from "zustand";
import { ClientEvents, ServerEvents } from "@lumina/shared";
import type { UserDTO, VoiceParticipantDTO } from "@lumina/shared";
import { getSocket } from "../socket/socketClient";
import { api } from "../lib/apiClient";
import { CLIENT_TYPE } from "../lib/platform";
import { keepCallAlive, releaseCall } from "../lib/nativeVoiceCall";
import { toast } from "./toastStore";
import { desktopBridge } from "../lib/desktopShell";
import { useScreenPickerStore } from "./screenPickerStore";

const STUN_SERVER: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

// Refreshed per-join from GET /api/voice/turn-credentials (short-lived HMAC creds minted by
// the backend — see modules/voice/routes.ts) rather than a static array, so a real TURN relay
// is available for peers behind symmetric/restrictive NAT where STUN alone can't establish a
// direct connection. Falls back to STUN-only exactly like before if the backend has no
// TURN_SECRET configured (self-hosters who haven't stood up coturn) — never a hard failure.
let iceServers: RTCIceServer[] = [STUN_SERVER];

const USER_VOLUMES_KEY = "lumina.voice.userVolumes";
/** The mute state to return to when un-deafening. */
let mutedBeforeDeafen = false;
function readUserVolumes(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_VOLUMES_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "number" && v >= 0 && v <= 100) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

async function refreshIceServers(): Promise<void> {
  try {
    const res = await api.get<{ iceServers: RTCIceServer[] }>("/voice/turn-credentials");
    iceServers = [STUN_SERVER, ...res.iceServers];
  } catch {
    iceServers = [STUN_SERVER];
  }
}
/**
 * Why a microphone or camera could not be opened, in words that say what to do about it. Every
 * failure used to become one "access denied" string in store state that nothing rendered, so a
 * blocked microphone looked exactly like a dead voice button.
 */
function deviceErrorMessage(err: unknown, device: "microphone" | "camera"): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (CLIENT_TYPE === "mobile") return `Lumina can't use your ${device}. Allow it in Settings, Apps, Lumina, Permissions, then try again.`;
    if (CLIENT_TYPE === "desktop") return `Lumina can't use your ${device}. Allow ${device} access for Lumina in your system settings, then try again.`;
    return `Lumina can't use your ${device}. Allow ${device} access for this site in your browser, then try again.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return `No ${device} found. Connect one and try again.`;
  if (name === "NotReadableError" || name === "AbortError") return `Your ${device} is in use by another app. Close it and try again.`;
  return `Couldn't start your ${device}. Try again.`;
}

/** Record a voice failure and put it on screen. */
function reportVoiceError(message: string): void {
  useVoiceStore.setState({ error: message });
  toast.error(message);
}

type JoinAck = { ok: boolean; participants?: VoiceParticipantDTO[]; stageRole?: "speaker" | "audience"; error?: string };

/**
 * VOICE_JOIN with a deadline. socket.io buffers an emit while the socket is down and the ack never
 * fires if it stays down, which left the button spinning on "connecting" for good. A late join the
 * server does process is undone with a leave, so a timed-out attempt never leaves a ghost in the room.
 */
function emitJoin(emit: { channelId?: string; conversationId?: string }): Promise<JoinAck> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(20_000)
      .emit(ClientEvents.VOICE_JOIN, emit, (err: Error | null, res: JoinAck) => {
        if (!err) return resolve(res);
        getSocket().emit(ClientEvents.VOICE_LEAVE);
        resolve({ ok: false, error: "the voice server didn't answer" });
      });
  });
}

const SPEAKING_THRESHOLD = 12; // 0-255 scale off the analyser's average byte frequency data

type VideoSource = "camera" | "screen" | null;

/**
 * How the microphone decides when to transmit.
 *
 *  - `open`  — always live while unmuted. What every call did before this existed.
 *  - `voice` — voice activity detection: the gate opens when you speak and closes when you stop.
 *  - `ptt`   — push-to-talk: the gate is closed unless the bound key is held.
 */
export type MicMode = "open" | "voice" | "ptt";

const MIC_MODE_KEY = "lumina-mic-mode";
const VAD_SENSITIVITY_KEY = "lumina-vad-sensitivity";

/**
 * How long the gate stays open after you drop below the threshold, in ms.
 *
 * Without this the gate tracks the waveform itself and closes in the natural gaps *inside* speech
 * — between syllables, on plosives, across the pause before a stressed word. The result is
 * chopped, robotic audio where the first phoneme after every gap is missing. Opening instantly
 * but closing lazily is the standard shape for a noise gate, and 300ms is long enough to bridge
 * ordinary speech gaps while still cutting off promptly at the end of a sentence.
 */
const VAD_HANG_MS = 300;

/**
 * Sensitivity is exposed to the user as 0–100 (higher = picks up quieter sound) because a raw
 * 0–255 frequency-average means nothing to anyone. This is the only place the two scales meet.
 */
export function vadThresholdFor(sensitivity: number): number {
  const clamped = Math.min(100, Math.max(0, sensitivity));
  return 40 - clamped * 0.38;
}

function readStoredMicMode(): MicMode {
  if (typeof window === "undefined") return "open";
  const stored = window.localStorage.getItem(MIC_MODE_KEY);
  return stored === "voice" || stored === "ptt" ? stored : "open";
}

function readStoredVadSensitivity(): number {
  if (typeof window === "undefined") return 65;
  const stored = Number(window.localStorage.getItem(VAD_SENSITIVITY_KEY));
  return Number.isFinite(stored) && stored >= 0 && stored <= 100 ? stored : 65;
}

interface VoiceParticipant {
  userId: string;
  socketId: string;
  user: UserDTO;
  speaking: boolean;
  hasVideo: boolean;
}

interface VoiceState {
  serverId: string | null;
  channelId: string | null;
  connecting: boolean;
  muted: boolean;
  deafened: boolean;
  micMode: MicMode;
  /** 0–100, user-facing. See vadThresholdFor for the mapping onto the analyser's scale. */
  vadSensitivity: number;
  /** Whether the push-to-talk key is held right now. Runtime only — never persisted. */
  pttHeld: boolean;
  /** Whether voice activity detection currently hears you. Runtime only. */
  vadOpen: boolean;
  /** Whether audio is actually leaving this machine — the resolved answer across mute, deafen
   * and the gate. Components render the mic indicator off this rather than re-deriving it. */
  transmitting: boolean;
  videoSource: VideoSource;
  // Stage channels: this client's own role in the current stage (null when the call isn't a stage).
  // A `speaker` publishes a mic; an `audience` member listens and may raise a hand to be promoted.
  stageRole: "speaker" | "audience" | null;
  handRaised: boolean;
  // DM calls: the conversation this call belongs to (null for a server voice/stage channel), and
  // an incoming ring awaiting answer (shown wherever the app is mounted — see useSocketEvents.ts).
  dmConversationId: string | null;
  incomingCall: { conversationId: string; from: UserDTO } | null;
  participants: Record<string, VoiceParticipant>; // keyed by socketId, excludes self
  // Server-wide "who's in which voice channel" roster, keyed by channelId — populated for
  // EVERY voice channel in the server regardless of whether you're connected to it (see
  // useSocketEvents.ts's VOICE_ROSTER_UPDATE handler + queries/voice.ts's initial-snapshot
  // fetch). Deliberately separate from `participants` above, which is scoped to the ONE call
  // you're actively in and carries extra fields (`speaking`/`hasVideo`) that only make sense
  // for peers you hold a live RTCPeerConnection with.
  roster: Record<string, VoiceParticipantDTO[]>;
  setChannelRoster: (channelId: string, participants: VoiceParticipantDTO[]) => void;
  seedRoster: (snapshot: Record<string, VoiceParticipantDTO[]>) => void;
  error: string | null;
  join: (serverId: string, channelId: string, opts?: { stage?: boolean }) => Promise<void>;
  /** Join (or answer) a DM call — reuses the entire voice engine on the conversation's room. */
  joinDM: (conversationId: string) => Promise<void>;
  /** Place a DM call: join, then ring the other participants. */
  startCall: (conversationId: string) => Promise<void>;
  /** Answer / decline the current incomingCall. */
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  setIncomingCall: (call: { conversationId: string; from: UserDTO } | null) => void;
  /** Stage: raise or lower your hand (audience only). */
  raiseHand: (raised: boolean) => void;
  /** Stage moderator: promote/demote a participant. */
  setStageRole: (targetSocketId: string, role: "speaker" | "audience") => void;
  /** Applied when the server tells us our own stage role changed (STAGE_ROLE_SET). */
  applyOwnStageRole: (role: "speaker" | "audience") => Promise<void>;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /** Per-person playback volume (0–100), remembered on this device. */
  userVolumes: Record<string, number>;
  setUserVolume: (userId: string, volume: number) => void;
  setMicMode: (mode: MicMode) => void;
  setVadSensitivity: (sensitivity: number) => void;
  setPttHeld: (held: boolean) => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

/**
 * Perfect-negotiation state per peer (see https://developer.mozilla.org/docs/Web/API/WebRTC_API/Perfect_negotiation)
 * — replaced the earlier "only existing participants ever offer" convention. That convention
 * only covered the initial join; it had no answer for what happens when a track is added or
 * removed later (needed for camera/screen-share toggle), which triggers `onnegotiationneeded`
 * on BOTH sides of a pair simultaneously. Perfect negotiation is the standard, robust solution
 * for that: a deterministic "polite" side (computed once per pair from a plain string
 * comparison of socket ids, so both sides independently compute the same answer with zero
 * extra signaling) rolls back and accepts an incoming offer on collision instead of both sides
 * racing. This one mechanism now correctly handles the initial connection AND every later
 * renegotiation (camera on/off, screen share on/off) through the same code path.
 */
interface PeerEntry {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

// Non-reactive engine state, deliberately kept OUT of the zustand store — RTCPeerConnection/
// MediaStream/AnalyserNode instances aren't meaningful to diff/serialize the way plain state
// is, and nothing needs to re-render off them directly (only the derived booleans/`speaking`
// pushed into the store explicitly do). Exported accessors at the bottom let React components
// (VoiceVideoGrid) read the actual MediaStream objects imperatively for <video>/<audio> els.
let localAudioStream: MediaStream | null = null;
let localVideoStream: MediaStream | null = null;
const peers = new Map<string, PeerEntry>();
const remoteAudioEls = new Map<string, HTMLAudioElement>();
const remoteVideoStreams = new Map<string, MediaStream>();
const speakingLoops = new Map<string, { ctx: AudioContext; analyser: AnalyserNode; raf: number }>();
let listenersAttached = false;

// Local voice-activity detection engine. Separate from `speakingLoops` above, which watches
// REMOTE participants to drive their speaking rings — this one watches your own microphone to
// decide whether to transmit at all.
let vadCtx: AudioContext | null = null;
let vadTrack: MediaStreamTrack | null = null;
let vadRaf = 0;
let vadOpenUntil = 0;

/**
 * Decide whether the microphone should be live right now.
 *
 * One function, consulted from every path that could change the answer, rather than each caller
 * setting `track.enabled` from its own partial view. That structure is what makes the modes
 * composable at all: mute, deafen, push-to-talk and voice detection are four independent reasons
 * to be silent, and any of them alone is sufficient.
 *
 * It also fixes a real pre-existing bug. `toggleDeafen` used to set `enabled = !deafened`
 * directly, so un-deafening re-opened the microphone even when you were also muted — the UI said
 * muted while your audio was going out. Deriving the answer instead of assigning it makes that
 * class of drift impossible.
 */
function shouldTransmit(s: VoiceState): boolean {
  if (s.muted || s.deafened) return false;
  if (s.micMode === "ptt") return s.pttHeld;
  if (s.micMode === "voice") return s.vadOpen;
  return true;
}

function applyMicGate(): void {
  const state = useVoiceStore.getState();
  const on = shouldTransmit(state);
  localAudioStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  if (state.transmitting !== on) useVoiceStore.setState({ transmitting: on });
}

function stopLocalVad(): void {
  if (vadRaf) cancelAnimationFrame(vadRaf);
  vadRaf = 0;
  vadTrack?.stop();
  vadTrack = null;
  void vadCtx?.close().catch(() => undefined);
  vadCtx = null;
  vadOpenUntil = 0;
  if (useVoiceStore.getState().vadOpen) useVoiceStore.setState({ vadOpen: false });
}

/**
 * Watch the local microphone and publish `vadOpen`.
 *
 * ## Why this analyses a CLONE of the mic track
 *
 * The obvious implementation — point an analyser at `localAudioStream` — cannot work, and fails
 * in a way that looks like a total mic outage rather than a bug. Gating is implemented by setting
 * `track.enabled = false`, and a disabled track does not merely stop being sent: it emits
 * *silence* to every consumer, including our own analyser. So the moment the gate closed, the
 * analyser would read zero, conclude you had stopped speaking, and keep it closed forever. The
 * gate would open exactly once and then latch shut.
 *
 * `MediaStreamTrack.clone()` returns a track backed by the same hardware source but with its own
 * independent `enabled` state. Analysing the clone (always enabled, never sent to any peer) while
 * gating the original is what lets detection keep working through a closed gate.
 */
function startLocalVad(): void {
  stopLocalVad();
  const source = localAudioStream?.getAudioTracks()[0];
  if (!source) return;

  vadTrack = source.clone();
  vadTrack.enabled = true;
  const ctx = new AudioContext();
  vadCtx = ctx;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(new MediaStream([vadTrack])).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
    const threshold = vadThresholdFor(useVoiceStore.getState().vadSensitivity);
    const now = performance.now();
    if (avg > threshold) vadOpenUntil = now + VAD_HANG_MS;

    const open = now < vadOpenUntil;
    if (open !== useVoiceStore.getState().vadOpen) {
      useVoiceStore.setState({ vadOpen: open });
      applyMicGate();
    }
    vadRaf = requestAnimationFrame(tick);
  }
  vadRaf = requestAnimationFrame(tick);
}

/** Start or stop local detection to match the current mode. Idempotent. */
function syncVadEngine(): void {
  const { micMode, channelId } = useVoiceStore.getState();
  const wanted = micMode === "voice" && channelId !== null;
  if (wanted && !vadCtx) startLocalVad();
  else if (!wanted && vadCtx) stopLocalVad();
}

function stopSpeakingLoop(socketId: string): void {
  const loop = speakingLoops.get(socketId);
  if (!loop) return;
  cancelAnimationFrame(loop.raf);
  void loop.ctx.close().catch(() => undefined);
  speakingLoops.delete(socketId);
}

function startSpeakingLoop(socketId: string, stream: MediaStream, onSpeaking: (speaking: boolean) => void): void {
  stopSpeakingLoop(socketId);
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let lastSpeaking = false;

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
    const speaking = avg > SPEAKING_THRESHOLD;
    if (speaking !== lastSpeaking) {
      lastSpeaking = speaking;
      onSpeaking(speaking);
    }
    const raf = requestAnimationFrame(tick);
    const loop = speakingLoops.get(socketId);
    if (loop) loop.raf = raf;
  }
  const raf = requestAnimationFrame(tick);
  speakingLoops.set(socketId, { ctx, analyser, raf });
}

function setParticipantVideo(socketId: string, hasVideo: boolean): void {
  useVoiceStore.setState((s) => {
    const p = s.participants[socketId];
    if (!p || p.hasVideo === hasVideo) return s;
    return { participants: { ...s.participants, [socketId]: { ...p, hasVideo } } };
  });
}

function signal(targetSocketId: string, data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): void {
  getSocket().emit(ClientEvents.VOICE_SIGNAL, { targetSocketId, data });
}

function closePeer(socketId: string): void {
  peers.get(socketId)?.pc.close();
  peers.delete(socketId);
  const el = remoteAudioEls.get(socketId);
  if (el) {
    el.srcObject = null;
    el.remove();
  }
  remoteAudioEls.delete(socketId);
  remoteVideoStreams.delete(socketId);
  stopSpeakingLoop(socketId);
}

function getOrCreatePeer(socketId: string): PeerEntry {
  const existing = peers.get(socketId);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers });
  const mySocketId = getSocket().id!;
  const entry: PeerEntry = { pc, polite: mySocketId < socketId, makingOffer: false, ignoreOffer: false };
  peers.set(socketId, entry);

  if (localAudioStream) for (const track of localAudioStream.getTracks()) pc.addTrack(track, localAudioStream);
  if (localVideoStream) for (const track of localVideoStream.getTracks()) pc.addTrack(track, localVideoStream);

  pc.onnegotiationneeded = async () => {
    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();
      signal(socketId, { description: pc.localDescription! });
    } catch (err) {
      console.error("voice: negotiation failed", err);
    } finally {
      entry.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) signal(socketId, { candidate: candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;

    if (event.track.kind === "video") {
      remoteVideoStreams.set(socketId, stream);
      setParticipantVideo(socketId, true);
      // When the remote side removes its video track (camera/screen-share off), Chromium
      // removes the track from the MediaStream itself — firing the STREAM's `removetrack`
      // event — rather than firing `ended` on the track object (which stays around with an
      // empty owning stream). Listening only for track.onended left a stale <video> element
      // with a live element but zero actual tracks. Listen for both, since the exact behavior
      // isn't guaranteed identical across browsers.
      const cleanup = () => {
        if (stream.getVideoTracks().length === 0) {
          remoteVideoStreams.delete(socketId);
          setParticipantVideo(socketId, false);
        }
      };
      event.track.addEventListener("ended", cleanup);
      stream.addEventListener("removetrack", cleanup);
      return;
    }

    let el = remoteAudioEls.get(socketId);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      // Attached to the DOM (hidden) rather than left as a bare in-memory Audio object — more
      // robust across browsers' autoplay/GC edge cases, and inspectable for debugging/tests.
      el.style.display = "none";
      el.dataset.voiceSocketId = socketId;
      document.body.appendChild(el);
      remoteAudioEls.set(socketId, el);
    }
    el.srcObject = stream;
    el.muted = useVoiceStore.getState().deafened;
    const ownerId = useVoiceStore.getState().participants[socketId]?.userId;
    if (ownerId) el.volume = Math.min(1, Math.max(0, (useVoiceStore.getState().userVolumes[ownerId] ?? 100) / 100));
    startSpeakingLoop(socketId, stream, (speaking) => {
      useVoiceStore.setState((s) => {
        const p = s.participants[socketId];
        if (!p || p.speaking === speaking) return s;
        return { participants: { ...s.participants, [socketId]: { ...p, speaking } } };
      });
    });
  };

  return entry;
}

async function handleSignal(payload: {
  fromSocketId: string;
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}): Promise<void> {
  const { fromSocketId, data } = payload;
  const entry = getOrCreatePeer(fromSocketId);
  const { pc } = entry;

  try {
    if (data.description) {
      const offerCollision = data.description.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;

      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        signal(fromSocketId, { description: pc.localDescription! });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!entry.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error("voice: signal handling failed", err);
  }
}

function attachSignalingListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  const socket = getSocket();

  socket.on(ServerEvents.VOICE_PARTICIPANT_JOINED, (participant: VoiceParticipantDTO) => {
    useVoiceStore.setState((s) => ({
      participants: { ...s.participants, [participant.socketId]: { ...participant, speaking: false, hasVideo: false } },
    }));
    // Creating the peer connection here (with current local tracks already attached) triggers
    // onnegotiationneeded on both this side and the new joiner's side at roughly the same
    // time — perfect negotiation's polite/impolite handling resolves the resulting collision.
    getOrCreatePeer(participant.socketId);
  });

  socket.on(ServerEvents.VOICE_PARTICIPANT_LEFT, (payload: { userId: string; socketId: string }) => {
    closePeer(payload.socketId);
    useVoiceStore.setState((s) => {
      const next = { ...s.participants };
      delete next[payload.socketId];
      return { participants: next };
    });
  });

  socket.on(ServerEvents.VOICE_SIGNAL, (payload: Parameters<typeof handleSignal>[0]) => {
    void handleSignal(payload);
  });

  // A moderator changed our stage role — start (speaker) or stop (audience) publishing the mic.
  socket.on(ServerEvents.STAGE_ROLE_SET, (payload: { channelId: string; stageRole: "speaker" | "audience" }) => {
    void useVoiceStore.getState().applyOwnStageRole(payload.stageRole);
  });
}

/** Tell the server what we're broadcasting so LIVE badges update server-wide (the media itself
 * still flows peer-to-peer — this is state, not video). Fire-and-forget: if the socket is down
 * the next roster broadcast corrects everyone anyway. */
function announceStreamState(kind: "screen" | "camera" | null): void {
  try {
    getSocket().emit(ClientEvents.VOICE_STREAM_STATE, { kind });
  } catch {
    /* not connected — nothing to announce */
  }
}

function stopLocalVideo(): void {
  localVideoStream?.getTracks().forEach((t) => t.stop());
  localVideoStream = null;
}

/**
 * Send this stream's video to every peer, reusing a video sender that is already there.
 *
 * Camera and screen share take turns in one slot. Swapping used to stop the old track and addTrack
 * the new one, which left the stopped track's sender behind: every swap grew the connection by
 * another video transceiver, and the far side kept a dead stream next to the live one. replaceTrack
 * swaps what the existing sender carries with no renegotiation at all.
 */
function publishVideo(stream: MediaStream): void {
  const [track] = stream.getVideoTracks();
  if (!track) return;
  for (const { pc } of peers.values()) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      void sender.replaceTrack(track).catch(() => undefined);
      continue;
    }
    // Turning video off removes the track but leaves its transceiver; addTrack will not reuse a
    // transceiver that has sent before, so on/off/on kept adding more. Reuse an idle video
    // transceiver (ours from before, or the one carrying the other person's video) instead. The
    // stream id is set before the direction change so the renegotiated track arrives with its
    // stream, which is what the far side's ontrack keys on.
    const idle = pc.getTransceivers().find((t) => t.receiver.track.kind === "video" && !t.sender.track && t.currentDirection !== "stopped");
    if (idle) {
      idle.sender.setStreams(stream);
      idle.direction = "sendrecv";
      void idle.sender.replaceTrack(track).catch(() => undefined);
    } else {
      pc.addTrack(track, stream);
    }
  }
}

function unpublishVideo(): void {
  for (const { pc } of peers.values()) {
    pc.getSenders().filter((s) => s.track?.kind === "video").forEach((s) => pc.removeTrack(s));
  }
}

/**
 * Acquire the microphone and publish it into every existing peer — used both on an ordinary join
 * and when a stage audience member is promoted to speaker (adding a track fires
 * onnegotiationneeded, which the perfect-negotiation path renegotiates). No-op if already live.
 */
async function acquireMic(): Promise<boolean> {
  if (localAudioStream) return true;
  try {
    localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    reportVoiceError(deviceErrorMessage(err, "microphone"));
    return false;
  }
  syncVadEngine();
  applyMicGate();
  for (const { pc } of peers.values()) {
    for (const track of localAudioStream.getTracks()) pc.addTrack(track, localAudioStream);
  }
  // A stage listener promoted to speaker: the foreground service needs the microphone permission,
  // which a listener may only just have granted.
  if (useVoiceStore.getState().channelId) keepCallAlive(useVoiceStore.getState().dmConversationId ? "In a call" : "In a voice room");
  return true;
}

/** Stop publishing the microphone — a stage speaker demoted to audience. Removes the audio senders
 * (renegotiated by the same path) and releases the hardware so the recording indicator clears. */
function dropMic(): void {
  for (const { pc } of peers.values()) {
    pc.getSenders()
      .filter((s) => s.track?.kind === "audio")
      .forEach((s) => pc.removeTrack(s));
  }
  stopLocalVad();
  localAudioStream?.getAudioTracks().forEach((t) => t.stop());
  localAudioStream = null;
  if (useVoiceStore.getState().transmitting) useVoiceStore.setState({ transmitting: false });
}

/**
 * The shared connect path behind join (server voice/stage) and joinDM (calls). `channelId` is the
 * roster key the store tracks — a real channel id, or `dm:<conversationId>` for a call — and `emit`
 * is what the backend's VOICE_JOIN expects. Stage joins defer the mic until the ack reveals whether
 * this client is a speaker; everything else takes the mic up front, exactly as before.
 */
async function doConnect(opts: {
  serverId: string | null;
  channelId: string;
  dmConversationId: string | null;
  emit: { channelId?: string; conversationId?: string };
  stage: boolean;
}): Promise<void> {
  const store = useVoiceStore;
  if (store.getState().channelId === opts.channelId) return;
  if (store.getState().channelId) store.getState().leave();

  store.setState({
    connecting: true,
    error: null,
    serverId: opts.serverId,
    channelId: opts.channelId,
    dmConversationId: opts.dmConversationId,
    stageRole: null,
    handRaised: false,
  });
  const iceServersReady = refreshIceServers();
  if (!opts.stage) {
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      syncVadEngine();
      applyMicGate();
    } catch (err) {
      const message = deviceErrorMessage(err, "microphone");
      store.setState({ connecting: false, serverId: null, channelId: null, dmConversationId: null, error: message });
      toast.error(message);
      return;
    }
  }
  await iceServersReady;

  attachSignalingListeners();

  const ack = await emitJoin(opts.emit);

  if (store.getState().channelId !== opts.channelId) {
    // Left, or moved to another room, while the join was in flight. Moving already told the server
    // (one call per socket); leaving did too, but the leave can land before the join finishes.
    if (ack.ok && !store.getState().channelId) getSocket().emit(ClientEvents.VOICE_LEAVE);
    return;
  }

  if (!ack.ok) {
    teardown();
    const message = ack.error ? `Couldn't join voice: ${ack.error}` : "Couldn't join voice. Try again.";
    store.setState({ connecting: false, serverId: null, channelId: null, dmConversationId: null, error: message });
    toast.error(message);
    return;
  }

  const stageRole = ack.stageRole ?? null;
  // A speaker (a stage moderator, or anyone who joined a stage as a speaker) needs the mic before
  // peers are created so their first negotiation already carries the audio track.
  if (opts.stage && stageRole === "speaker" && !localAudioStream) await acquireMic();

  const participants: Record<string, VoiceParticipant> = {};
  for (const p of ack.participants ?? []) participants[p.socketId] = { ...p, speaking: false, hasVideo: false };
  store.setState({ connecting: false, participants, stageRole, handRaised: false });
  for (const p of ack.participants ?? []) getOrCreatePeer(p.socketId);
  rememberVoiceSocket(opts.emit);
  keepCallAlive(opts.dmConversationId ? "In a call" : "In a voice room");
}

// ---- surviving a reconnect ---------------------------------------------------------------------
// Voice room membership lives on the SOCKET. A network blip, a phone switching from wifi to mobile
// data, a backend deploy, or simply creating a DM (which forces a reconnect, see reconnectSocket)
// gives this client a new socket id; the server drops the old one from the room and everyone else
// tears their connection to it down. The UI still said "connected" while nobody could hear anyone.
// So: when the socket comes back under a new id while we are in a room, join the room again and
// rebuild every peer, keeping the microphone we already hold.
let voiceSocketId: string | null = null;
let lastJoinEmit: { channelId?: string; conversationId?: string } | null = null;
const pastVoiceSocketIds = new Set<string>();
let reconnectWatchAttached = false;

function rememberVoiceSocket(emit: { channelId?: string; conversationId?: string }): void {
  voiceSocketId = getSocket().id ?? null;
  if (voiceSocketId) pastVoiceSocketIds.add(voiceSocketId);
  lastJoinEmit = emit;
  if (reconnectWatchAttached) return;
  reconnectWatchAttached = true;
  const socket = getSocket();
  socket.on("connect", () => {
    if (!useVoiceStore.getState().channelId || !lastJoinEmit || !voiceSocketId || socket.id === voiceSocketId) return;
    void rejoinAfterReconnect();
  });
}

function forgetVoiceSocket(): void {
  voiceSocketId = null;
  lastJoinEmit = null;
}

async function rejoinAfterReconnect(): Promise<void> {
  const store = useVoiceStore;
  const emit = lastJoinEmit;
  if (!emit) return;
  for (const socketId of Array.from(peers.keys())) closePeer(socketId);
  store.setState({ connecting: true, participants: {} });
  await refreshIceServers();
  const ack = await emitJoin(emit);
  if (!store.getState().channelId || lastJoinEmit !== emit) return; // left (or moved) while this was in flight
  if (!ack.ok) {
    store.getState().leave();
    reportVoiceError(ack.error ? `Lost the voice connection: ${ack.error}. Join again.` : "Lost the voice connection. Join again.");
    return;
  }
  voiceSocketId = getSocket().id ?? null;
  if (voiceSocketId) pastVoiceSocketIds.add(voiceSocketId);
  const stageRole = ack.stageRole ?? store.getState().stageRole;
  if (stageRole === "speaker" && !localAudioStream) await acquireMic();
  // The server may still list our previous socket until its ping times out — that is us, not a peer.
  const others = (ack.participants ?? []).filter((p) => !pastVoiceSocketIds.has(p.socketId));
  const participants: Record<string, VoiceParticipant> = {};
  for (const p of others) participants[p.socketId] = { ...p, speaking: false, hasVideo: false };
  store.setState({ connecting: false, participants, stageRole });
  for (const p of others) getOrCreatePeer(p.socketId);
}

function teardown(): void {
  releaseCall();
  for (const socketId of Array.from(peers.keys())) closePeer(socketId);
  // Before the source tracks are stopped — the VAD clone shares their hardware source, and
  // leaving it running would hold the microphone open (and the recording indicator lit) after
  // the call ended.
  stopLocalVad();
  localAudioStream?.getTracks().forEach((t) => t.stop());
  localAudioStream = null;
  stopLocalVideo();
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  serverId: null,
  channelId: null,
  connecting: false,
  muted: false,
  deafened: false,
  micMode: readStoredMicMode(),
  vadSensitivity: readStoredVadSensitivity(),
  pttHeld: false,
  vadOpen: false,
  transmitting: false,
  videoSource: null,
  stageRole: null,
  handRaised: false,
  dmConversationId: null,
  incomingCall: null,
  participants: {},
  roster: {},
  error: null,
  userVolumes: readUserVolumes(),

  setChannelRoster: (channelId, participants) => {
    set((s) => ({ roster: { ...s.roster, [channelId]: participants } }));
  },
  seedRoster: (snapshot) => {
    // Merge, don't replace — a live VOICE_ROSTER_UPDATE could race ahead of the initial REST
    // snapshot's response landing (e.g. someone joins right as the page loads), and blindly
    // overwriting would drop that already-current update.
    set((s) => ({ roster: { ...snapshot, ...s.roster } }));
  },

  // Server voice/stage channel. `stage` defers the mic until the ack reveals whether we're a
  // speaker — see doConnect. TURN creds are fetched in parallel with the mic prompt (doConnect).
  join: (serverId, channelId, opts) =>
    doConnect({ serverId, channelId, dmConversationId: null, emit: { channelId }, stage: Boolean(opts?.stage) }),

  // A DM call is the same engine on the conversation's own room. The store's channelId is the
  // roster key `dm:<conversationId>`; dmConversationId carries the real id for the call UI.
  joinDM: (conversationId) =>
    doConnect({
      serverId: null,
      channelId: `dm:${conversationId}`,
      dmConversationId: conversationId,
      emit: { conversationId },
      stage: false,
    }),

  startCall: async (conversationId) => {
    await get().joinDM(conversationId);
    if (get().dmConversationId === conversationId) getSocket().emit(ClientEvents.CALL_RING, { conversationId });
  },

  acceptCall: async () => {
    const call = get().incomingCall;
    if (!call) return;
    set({ incomingCall: null });
    await get().joinDM(call.conversationId);
  },

  declineCall: () => {
    const call = get().incomingCall;
    if (call) getSocket().emit(ClientEvents.CALL_DECLINE, { conversationId: call.conversationId });
    set({ incomingCall: null });
  },

  setIncomingCall: (incomingCall) => set({ incomingCall }),

  raiseHand: (raised) => {
    if (get().stageRole !== "audience") return;
    getSocket().emit(ClientEvents.STAGE_HAND, { raised });
    set({ handRaised: raised });
  },

  setStageRole: (targetSocketId, role) => {
    getSocket().emit(ClientEvents.STAGE_SET_ROLE, { targetSocketId, role });
  },

  applyOwnStageRole: async (role) => {
    if (get().stageRole === role) return;
    set({ stageRole: role, handRaised: false });
    if (role === "speaker") await acquireMic();
    else dropMic();
  },

  leave: () => {
    if (!get().channelId) return;
    getSocket().emit(ClientEvents.VOICE_LEAVE);
    forgetVoiceSocket();
    teardown();
    set({
      serverId: null,
      channelId: null,
      dmConversationId: null,
      stageRole: null,
      handRaised: false,
      participants: {},
      connecting: false,
      error: null,
      videoSource: null,
      pttHeld: false,
      vadOpen: false,
      transmitting: false,
    });
  },

  toggleMute: () => {
    if (get().deafened) {
      // Discord's rule: unmuting while deafened undeafens too — you asked to talk, and talking into a
      // room you cannot hear is never what that click means.
      for (const el of remoteAudioEls.values()) el.muted = false;
      set({ deafened: false, muted: false });
    } else {
      set({ muted: !get().muted });
    }
    applyMicGate();
  },

  toggleDeafen: () => {
    const deafened = !get().deafened;
    for (const el of remoteAudioEls.values()) el.muted = deafened;
    // Deafening also mutes the mic (matches Discord — talking while unable to hear anyone respond
    // isn't useful). Un-deafening puts the mic back the way it was: it used to leave it muted, so
    // anyone who deafened and came back was silently still muted until they found the mute button.
    if (deafened) {
      mutedBeforeDeafen = get().muted;
      set({ deafened: true, muted: true });
    } else {
      set({ deafened: false, muted: mutedBeforeDeafen });
    }
    applyMicGate();
  },

  setUserVolume: (userId, volume) => {
    const v = Math.min(100, Math.max(0, Math.round(volume)));
    const next = { ...get().userVolumes, [userId]: v };
    set({ userVolumes: next });
    try {
      window.localStorage.setItem(USER_VOLUMES_KEY, JSON.stringify(next));
    } catch {
      // storage full or blocked: the volume still applies for this session
    }
    for (const [socketId, el] of remoteAudioEls) {
      if (get().participants[socketId]?.userId === userId) el.volume = v / 100;
    }
  },

  setMicMode: (micMode) => {
    window.localStorage.setItem(MIC_MODE_KEY, micMode);
    // Leaving push-to-talk while the key happens to be held would strand `pttHeld` true, and the
    // keyup that would have cleared it belongs to a mode we are no longer in.
    set({ micMode, pttHeld: false });
    syncVadEngine();
    applyMicGate();
  },

  setVadSensitivity: (vadSensitivity) => {
    const clamped = Math.min(100, Math.max(0, vadSensitivity));
    window.localStorage.setItem(VAD_SENSITIVITY_KEY, String(clamped));
    set({ vadSensitivity: clamped });
  },

  setPttHeld: (pttHeld) => {
    if (get().pttHeld === pttHeld) return; // keydown autorepeat fires continuously while held
    set({ pttHeld });
    applyMicGate();
  },

  // Camera and screen share share ONE video track slot — turning one on while the other is
  // active swaps it rather than sending two video streams. Simpler mental model (a single
  // "what my video tile shows" concept) and avoids doubling bandwidth in a mesh topology where
  // cost already scales with participant count. A deliberate v1 scope cut, not an oversight —
  // see roadmap Phase 8.
  toggleCamera: async () => {
    if (get().videoSource === "camera") {
      unpublishVideo();
      stopLocalVideo();
      set({ videoSource: null });
      announceStreamState(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // Publish first, then stop the screen: its sender is reused, so there is never a gap with
      // no video sender at all.
      publishVideo(stream);
      if (get().videoSource === "screen") stopLocalVideo();
      localVideoStream = stream;
      set({ videoSource: "camera" });
      announceStreamState("camera");
    } catch (err) {
      reportVoiceError(deviceErrorMessage(err, "camera"));
    }
  },

  toggleScreenShare: async () => {
    if (get().videoSource === "screen") {
      unpublishVideo();
      stopLocalVideo();
      set({ videoSource: null });
      announceStreamState(null);
      return;
    }
    try {
      // The desktop app has no browser picker: list what can be shared, let the person choose, and
      // tell the shell which source to grant before asking for it (apps/desktop/src/screenShare.ts).
      const shell = desktopBridge();
      if (shell) {
        const sources = await shell.listScreenSources();
        if (sources.length === 0) {
          reportVoiceError("There is no screen or window to share.");
          return;
        }
        const id = sources.length === 1 ? sources[0].id : await useScreenPickerStore.getState().pick(sources);
        if (!id) return;
        if (!(await shell.chooseScreenSource(id))) {
          reportVoiceError("That screen or window can't be shared. Pick another one.");
          return;
        }
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      publishVideo(stream);
      if (get().videoSource === "camera") stopLocalVideo();
      localVideoStream = stream;
      set({ videoSource: "screen" });
      announceStreamState("screen");
      // The browser's own native "Stop sharing" control ends the track directly — listen for
      // that instead of only relying on our own toggle button.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (get().videoSource === "screen") get().toggleScreenShare();
      });
    } catch (err) {
      // Closing the picker rejects with NotAllowedError. That is a choice, not a failure to report.
      if ((err as { name?: string } | null)?.name === "NotAllowedError") return;
      reportVoiceError("Screen sharing isn't available here.");
    }
  },
}));

/** Imperative accessors for React components rendering actual media (VoiceVideoGrid) — see the
 * module-scope comment above on why these live outside the reactive store. */
export function getLocalVideoStream(): MediaStream | null {
  return localVideoStream;
}
export function getRemoteVideoStream(socketId: string): MediaStream | undefined {
  return remoteVideoStreams.get(socketId);
}
