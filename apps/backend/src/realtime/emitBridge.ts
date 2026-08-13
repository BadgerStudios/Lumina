import { redis, createRedisDuplicate } from "../db/redis.js";

/**
 * Lets a process that has no Socket.IO server push an event to connected clients.
 *
 * The worker container runs the same image as the API but calls `node dist/worker.js`, so it has
 * Prisma and Redis and no HTTP server at all — `getIO()` there throws. Until now that simply meant
 * background work could not talk to clients: a finished transcode updated the row and the uploader
 * found out on their next poll, which is why VIDEO_STATUS_UPDATE is emitted from the staff route
 * (a request) and never from the worker (the place that actually knows).
 *
 * The mechanism is a Redis channel. The worker publishes {room, event, payload}; every API process
 * subscribes and re-emits into its own Socket.IO server, which the existing Redis *adapter* then
 * fans out to whichever process actually holds those sockets. So this bridges
 * "no io instance" → "an io instance", and the adapter continues to handle "this process" →
 * "the process the client is on".
 *
 * Deliberately not @socket.io/redis-emitter: that package writes the adapter's own internal
 * protocol directly into Redis, which means an adapter version bump can silently stop delivering.
 * A plain channel with a payload we define ourselves cannot drift like that, and it is ten lines.
 */

const EMIT_CHANNEL = "lumina:emit";

interface BridgedEmit {
  room: string;
  event: string;
  payload: unknown;
}

/**
 * Emits directly when this process has a Socket.IO server, and via Redis when it does not.
 *
 * Callers do not need to know which kind of process they are in — that check is the whole point,
 * because the same service functions are imported by both the API and the worker.
 */
export async function emitToRoom(room: string, event: string, payload: unknown): Promise<void> {
  try {
    const { getIO } = await import("./io.js");
    getIO().to(room).emit(event, payload);
    return;
  } catch {
    /* no io in this process — fall through to the bridge */
  }
  try {
    await redis.publish(EMIT_CHANNEL, JSON.stringify({ room, event, payload } satisfies BridgedEmit));
  } catch {
    // A dropped realtime nudge is a cosmetic delay, never a correctness problem: every payload sent
    // this way describes state that is already committed and readable over HTTP.
  }
}

/** Called once from initIO. */
export function subscribeEmitBridge(emit: (room: string, event: string, payload: unknown) => void): void {
  const sub = createRedisDuplicate();
  sub.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[emitBridge] subscriber error:", err.message);
  });
  void sub.subscribe(EMIT_CHANNEL);
  sub.on("message", (channel, raw) => {
    if (channel !== EMIT_CHANNEL) return;
    try {
      const parsed = JSON.parse(raw) as BridgedEmit;
      if (typeof parsed.room !== "string" || typeof parsed.event !== "string") return;
      emit(parsed.room, parsed.event, parsed.payload);
    } catch {
      /* a malformed message is not worth taking the subscriber down for */
    }
  });
}
