import { create } from "zustand";
import { ClientEvents, ServerEvents } from "@lumina/shared";
import type { UserDTO, VoiceParticipantDTO } from "@lumina/shared";
import { getSocket } from "../socket/socketClient";
import { api } from "../lib/apiClient";

const STUN_SERVER: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

// Refreshed per-join from GET /api/voice/turn-credentials (short-lived HMAC creds minted by
// the backend — see modules/voice/routes.ts) rather than a static array, so a real TURN relay
// is available for peers behind symmetric/restrictive NAT where STUN alone can't establish a
// direct connection. Falls back to STUN-only exactly like before if the backend has no
// TURN_SECRET configured (self-hosters who haven't stood up coturn) — never a hard failure.
let iceServers: RTCIceServer[] = [STUN_SERVER];

async function refreshIceServers(): Promise<void> {
  try {
    const res = await api.get<{ iceServers: RTCIceServer[] }>("/voice/turn-credentials");
    iceServers = [STUN_SERVER, ...res.iceServers];
  } catch {
    iceServers = [STUN_SERVER];
  }
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
  join: (serverId: string, channelId: string) => Promise<void>;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
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

function teardown(): void {
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
  participants: {},
  roster: {},
  error: null,

  setChannelRoster: (channelId, participants) => {
    set((s) => ({ roster: { ...s.roster, [channelId]: participants } }));
  },
  seedRoster: (snapshot) => {
    // Merge, don't replace — a live VOICE_ROSTER_UPDATE could race ahead of the initial REST
    // snapshot's response landing (e.g. someone joins right as the page loads), and blindly
    // overwriting would drop that already-current update.
    set((s) => ({ roster: { ...snapshot, ...s.roster } }));
  },

  join: async (serverId, channelId) => {
    if (get().channelId === channelId) return;
    if (get().channelId) get().leave();

    set({ connecting: true, error: null, serverId, channelId });
    // Run alongside the mic permission prompt rather than before it — TURN creds are only
    // needed once a peer connection is actually created below, and fetching them in parallel
    // with getUserMedia (rather than blocking on either sequentially) keeps join latency the
    // same as before this existed in the common case where both finish quickly.
    const iceServersReady = refreshIceServers();
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The gate is applied before the first peer connection exists, so in push-to-talk or
      // voice-activity mode nothing is ever transmitted between joining and the first time you
      // actually mean to speak.
      syncVadEngine();
      applyMicGate();
    } catch {
      set({ connecting: false, serverId: null, channelId: null, error: "Microphone access denied or unavailable." });
      return;
    }
    await iceServersReady;

    attachSignalingListeners();

    const ack = await new Promise<{ ok: boolean; participants?: VoiceParticipantDTO[]; error?: string }>((resolve) => {
      getSocket().emit(ClientEvents.VOICE_JOIN, { channelId }, resolve);
    });

    if (!ack.ok) {
      teardown();
      set({ connecting: false, serverId: null, channelId: null, error: ack.error ?? "Failed to join voice channel." });
      return;
    }

    const participants: Record<string, VoiceParticipant> = {};
    for (const p of ack.participants ?? []) participants[p.socketId] = { ...p, speaking: false, hasVideo: false };
    set({ connecting: false, participants });
    // Every existing participant gets its own RTCPeerConnection created now, symmetric with
    // how VOICE_PARTICIPANT_JOINED handles it on the other side — see that handler's comment.
    for (const p of ack.participants ?? []) getOrCreatePeer(p.socketId);
  },

  leave: () => {
    if (!get().channelId) return;
    getSocket().emit(ClientEvents.VOICE_LEAVE);
    teardown();
    set({
      serverId: null,
      channelId: null,
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
    set({ muted: !get().muted });
    applyMicGate();
  },

  toggleDeafen: () => {
    const deafened = !get().deafened;
    for (const el of remoteAudioEls.values()) el.muted = deafened;
    // Deafening also mutes the mic (matches Discord — talking while unable to hear anyone
    // respond isn't useful, and it's a clearer mental model than two independently-tracked
    // states that can silently drift apart).
    set({ deafened, muted: deafened ? true : get().muted });
    applyMicGate();
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
      stopLocalVideo();
      for (const { pc } of peers.values()) {
        pc.getSenders().filter((s) => s.track?.kind === "video").forEach((s) => pc.removeTrack(s));
      }
      set({ videoSource: null });
      announceStreamState(null);
      return;
    }
    try {
      if (get().videoSource === "screen") stopLocalVideo();
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      localVideoStream = stream;
      for (const { pc } of peers.values()) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }
      set({ videoSource: "camera" });
      announceStreamState("camera");
    } catch {
      set({ error: "Camera access denied or unavailable." });
    }
  },

  toggleScreenShare: async () => {
    if (get().videoSource === "screen") {
      stopLocalVideo();
      for (const { pc } of peers.values()) {
        pc.getSenders().filter((s) => s.track?.kind === "video").forEach((s) => pc.removeTrack(s));
      }
      set({ videoSource: null });
      announceStreamState(null);
      return;
    }
    try {
      if (get().videoSource === "camera") stopLocalVideo();
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      localVideoStream = stream;
      for (const { pc } of peers.values()) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }
      set({ videoSource: "screen" });
      announceStreamState("screen");
      // The browser's own native "Stop sharing" control ends the track directly — listen for
      // that instead of only relying on our own toggle button.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (get().videoSource === "screen") get().toggleScreenShare();
      });
    } catch {
      set({ error: "Screen share was cancelled or unavailable." });
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
