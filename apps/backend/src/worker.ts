import { Worker } from "bullmq";
import { prisma } from "./db/prisma.js";
import {
  VIDEO_TRANSCODE_QUEUE,
  createQueueConnection,
  enqueueTranscode,
  type TranscodeJobData,
} from "./modules/videos/queue.js";
import { processVideo } from "./modules/videos/transcode.js";

/** How long a video may sit in PROCESSING before the sweep assumes its job was lost. Comfortably
 * longer than a real transcode (bounded at 10 minutes by ffmpeg's own timeout). */
const STRANDED_AFTER_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Re-enqueues videos stuck in PROCESSING with no live job behind them.
 *
 * This exists because enqueueing deliberately never throws into the upload path (a failed enqueue
 * must not fail an upload whose bytes are already on disk) — which means a broken enqueue strands
 * videos in PROCESSING silently and forever. That is not hypothetical: an invalid BullMQ job id
 * did exactly this, and every upload kept returning a cheerful 201 while nothing was ever
 * transcoded. A Redis eviction or a job lost to a crash produces the identical symptom.
 *
 * Enqueue is idempotent (fixed jobId per video), so re-adding a video that does still have a
 * queued job is a no-op rather than a double transcode.
 */
async function sweepStranded(): Promise<void> {
  try {
    const stranded = await prisma.video.findMany({
      where: { status: "PROCESSING", createdAt: { lt: new Date(Date.now() - STRANDED_AFTER_MS) } },
      select: { id: true },
      take: 50,
    });
    if (stranded.length === 0) return;
    // eslint-disable-next-line no-console
    console.warn(`[worker] re-enqueueing ${stranded.length} stranded video(s)`);
    for (const v of stranded) await enqueueTranscode(v.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[worker] stranded sweep failed:", err);
  }
}

/**
 * Separate process from the API (its own container — see the `worker` service in compose.yml,
 * same image, different command). ffmpeg is CPU-saturating and memory-hungry by nature; running it
 * inside the Fastify process would make request latency a function of whatever video happens to be
 * encoding, and an OOM during a transcode would take the whole API down with it. Splitting them
 * means the worst case for a pathological upload is a stalled queue, not an outage.
 *
 * This is the only entrypoint that requires ffmpeg to be present; the API image ships it too (same
 * build) but never invokes it.
 */
async function main() {
  // eslint-disable-next-line no-console
  console.log("[worker] starting video transcode worker");

  const worker = new Worker<TranscodeJobData>(
    VIDEO_TRANSCODE_QUEUE,
    async (job) => {
      const videoId = BigInt(job.data.videoId);
      // eslint-disable-next-line no-console
      console.log(`[worker] transcoding video ${videoId} (attempt ${job.attemptsMade + 1})`);
      await processVideo(videoId);
      // eslint-disable-next-line no-console
      console.log(`[worker] finished video ${videoId}`);
    },
    {
      connection: createQueueConnection(),
      // Strictly one at a time. ffmpeg is already told to use 2 threads; letting several jobs run
      // concurrently on a small host would multiply that and make every transcode slower without
      // increasing throughput.
      concurrency: 1,
      // Belt-and-suspenders against a job that somehow escapes ffmpeg's own timeout: without a
      // stall guard a wedged job holds the only worker slot and the queue stops forever.
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] job ${job?.id} failed:`, err?.message ?? err);
  });

  worker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] worker error:", err);
  });

  void sweepStranded();
  const sweepTimer = setInterval(() => void sweepStranded(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // Graceful shutdown so an in-flight transcode is allowed to finish (or be re-queued cleanly)
  // instead of being killed mid-write and leaving a half-written MP4 behind.
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] received ${signal}, closing`);
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal:", err);
  process.exit(1);
});
