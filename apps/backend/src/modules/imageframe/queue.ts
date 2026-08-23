import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../config/env.js";
import { ifLog } from "./logger.js";

const log = ifLog("queue");

export const IMAGEFRAME_TRANSCODE_QUEUE = "imageframe-transcode";

export interface ImageframeJobData {
  imageframeId: string;
}

/**
 * A separate queue from the video-transcode one, sharing the same worker container. Same Redis
 * connection rules as videos/queue.ts: `maxRetriesPerRequest: null` for BullMQ's blocking reads,
 * and a dedicated connection so its blocking commands don't sit in front of anything else on the
 * app socket.
 */
function createQueueConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on("error", (err) => log.error("queue redis connection error", { error: err.message }));
  return connection;
}

let queue: Queue<ImageframeJobData> | null = null;

export function getImageframeQueue(): Queue<ImageframeJobData> {
  if (!queue) {
    queue = new Queue<ImageframeJobData>(IMAGEFRAME_TRANSCODE_QUEUE, {
      connection: createQueueConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queue;
}

/**
 * Never throws into the request path — a failed enqueue must not fail an upload whose bytes are
 * already on disk. The row stays PROCESSING and the worker's stranded-sweep re-enqueues it. Job id
 * is keyed to the row (hyphen, not colon — BullMQ reserves colon) so a retry or double-submit
 * collapses onto one job instead of transcoding twice.
 */
export async function enqueueImageframe(imageframeId: bigint): Promise<void> {
  try {
    await getImageframeQueue().add(
      "transcode",
      { imageframeId: imageframeId.toString() },
      { jobId: `imageframe-${imageframeId}` },
    );
    log.debug("enqueued transcode", { imageframeId: imageframeId.toString() });
  } catch (err) {
    log.error("failed to enqueue transcode", {
      imageframeId: imageframeId.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export { createQueueConnection };
