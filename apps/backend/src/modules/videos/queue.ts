import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../config/env.js";

export const VIDEO_TRANSCODE_QUEUE = "video-transcode";

export interface TranscodeJobData {
  videoId: string;
}

/**
 * The first real background job queue in this codebase. Everything async here until now was
 * fire-and-forget `void somePromise()` (see modules/messages/mentions.ts's push dispatch), which is
 * fine for a best-effort notification and wrong for transcoding: a job that must survive a process
 * restart, retry on failure, and — critically — run somewhere other than the API container, since
 * ffmpeg will happily saturate every core it is given and would otherwise starve request handling.
 *
 * BullMQ requires its own Redis connection with `maxRetriesPerRequest: null` (it holds long
 * blocking reads that ioredis' default retry cap would kill). db/redis.ts already sets that, but a
 * dedicated connection is used anyway rather than sharing the app's: BullMQ's blocking commands
 * would otherwise sit in front of the presence counters on the same socket.
 */
function createQueueConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // ioredis emits 'error' on every failed reconnect attempt; with no listener attached those
  // surface as unhandled error events and can take the process down during a Redis restart. The
  // client retries on its own, so logging is the whole job here.
  connection.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[videos] queue redis connection error:", err.message);
  });
  return connection;
}

let queue: Queue<TranscodeJobData> | null = null;

export function getTranscodeQueue(): Queue<TranscodeJobData> {
  if (!queue) {
    queue = new Queue<TranscodeJobData>(VIDEO_TRANSCODE_QUEUE, {
      connection: createQueueConnection(),
      defaultJobOptions: {
        // Bounded retries with backoff: a transient failure (disk pressure, worker restart
        // mid-job) is worth retrying, a genuinely undecodable file is not worth retrying forever.
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        // Completed jobs carry no useful history once the DB row reflects the outcome; failures
        // are kept far longer because they're the ones worth inspecting.
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queue;
}

/**
 * Never throws into the request path. A failed enqueue must not fail an upload whose bytes are
 * already safely on disk — the row simply stays PROCESSING and can be re-enqueued, which is far
 * better than 500ing after the user waited through a 100MB upload.
 */
export async function enqueueTranscode(videoId: bigint): Promise<void> {
  try {
    await getTranscodeQueue().add(
      "transcode",
      { videoId: videoId.toString() },
      // Job id keyed to the video makes enqueueing idempotent: a retry or a double-submit collapses
      // onto the same job instead of transcoding the same file twice. Hyphen, not colon — BullMQ
      // rejects a custom job id containing ":" (it delimits its own Redis key namespace), and
      // because this whole call is wrapped in the catch below, getting that wrong fails silently:
      // uploads keep returning 201 and every video strands in PROCESSING forever.
      { jobId: `video-${videoId}` },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[videos] failed to enqueue transcode for video ${videoId}:`, err);
  }
}

export { createQueueConnection };
