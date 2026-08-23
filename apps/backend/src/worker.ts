import { Worker } from "bullmq";
import { prisma } from "./db/prisma.js";
import {
  VIDEO_TRANSCODE_QUEUE,
  createQueueConnection,
  enqueueTranscode,
  type TranscodeJobData,
} from "./modules/videos/queue.js";
import { processVideo } from "./modules/videos/transcode.js";
import {
  IMAGEFRAME_TRANSCODE_QUEUE,
  enqueueImageframe,
  type ImageframeJobData,
} from "./modules/imageframe/queue.js";
import { processImageframe } from "./modules/imageframe/transcode.js";
import { LINK_PREVIEW_QUEUE, type LinkPreviewJobData } from "./modules/messages/previewQueue.js";
import { BOT_INSTALL_QUEUE, type BotInstallJobData } from "./modules/bots/queue.js";
import { processBotInstall } from "./modules/bots/installer.js";
import { fetchPreview, broadcastEmbeds } from "./lib/linkPreview.js";
import { sweepArchivableThreads } from "./modules/threads/service.js";
import { releaseMaturedEarnings } from "./modules/economy/service.js";
import { purgeExpiredReviewDocuments } from "./modules/verification/service.js";
import { sweepAdPools } from "./modules/economy/pools.js";
import { sweepEventReminders } from "./modules/events/service.js";
import { rotatePqKeys } from "./modules/pq/service.js";
import { runFinancialAssertions } from "./modules/economy/reconcile.js";
import { refreshMinorStatus } from "./modules/parental/service.js";

/** How long a video may sit in PROCESSING before the sweep assumes its job was lost. Comfortably
 * longer than a real transcode (bounded at 10 minutes by ffmpeg's own timeout). */
const STRANDED_AFTER_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Threads idle past their own autoArchiveMinutes. Checked far less often than the video sweep —
 * the shortest auto-archive option is an hour, so minute-level precision buys nothing. */
const THREAD_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Archives threads that have gone quiet.
 *
 * Deliberately a plain interval rather than a BullMQ repeatable job: it is one idempotent UPDATE
 * with no payload, no retry semantics worth having, and nothing to report back. Running it twice
 * concurrently would be harmless. A queue would add a Redis dependency and a failure mode to
 * something that is already safe to simply re-run.
 */
async function sweepThreads(): Promise<void> {
  try {
    const archived = await sweepArchivableThreads();
    if (archived > 0) {
      // eslint-disable-next-line no-console
      console.log(`[worker] auto-archived ${archived} idle thread(s)`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[worker] thread sweep failed:", err);
  }
}

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
async function sweepStrandedImageframe(): Promise<void> {
  try {
    const stranded = await prisma.imageframeVideo.findMany({
      where: { status: "PROCESSING", createdAt: { lt: new Date(Date.now() - STRANDED_AFTER_MS) } },
      select: { id: true },
      take: 50,
    });
    if (stranded.length === 0) return;
    // eslint-disable-next-line no-console
    console.warn(`[worker] re-enqueueing ${stranded.length} stranded imageframe(s)`);
    for (const v of stranded) await enqueueImageframe(v.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[worker] imageframe stranded sweep failed:", err);
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log("[worker] starting video transcode worker");

  const worker = new Worker<TranscodeJobData>(
    VIDEO_TRANSCODE_QUEUE,
    async (job) => {
      const videoId = BigInt(job.data.videoId);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      // eslint-disable-next-line no-console
      console.log(`[worker] transcoding video ${videoId} (attempt ${job.attemptsMade + 1})`);
      await processVideo(videoId, { isFinalAttempt });
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

  /**
   * Link unfurling, on its own worker rather than sharing the transcode one.
   *
   * They have opposite shapes: a transcode is CPU-bound and must run strictly one at a time, an
   * unfurl is almost entirely waiting on a remote host. Sharing a worker would mean one slow page
   * fetch sitting in front of every queued transcode, and concurrency 1 on something that is 99%
   * network wait is simply wasted. Four at a time is enough to keep a busy channel current without
   * this host looking like it is scanning anyone.
   */
  const previewWorker = new Worker<LinkPreviewJobData>(
    LINK_PREVIEW_QUEUE,
    async (job) => {
      await fetchPreview(job.data.previewId);
      await broadcastEmbeds(BigInt(job.data.messageId), job.data.room);
    },
    { connection: createQueueConnection(), concurrency: 4, stalledInterval: 60_000, maxStalledCount: 2 },
  );

  previewWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] link preview ${job?.id} failed:`, err?.message ?? err);
  });
  previewWorker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] link preview worker error:", err);
  });

  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] job ${job?.id} failed:`, err?.message ?? err);
  });

  worker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] worker error:", err);
  });

  // Bot onboarding. Concurrency 1 on purpose: the job is mostly outbound metadata fetches to
  // GitHub/npm, and a burst of parallel installs would look like scraping to those hosts.
  const botInstallWorker = new Worker<BotInstallJobData>(
    BOT_INSTALL_QUEUE,
    async (job) => {
      // eslint-disable-next-line no-console
      console.log(`[worker] onboarding bot request ${job.data.requestId}`);
      await processBotInstall(job.data);
    },
    { connection: createQueueConnection(), concurrency: 1, stalledInterval: 60_000, maxStalledCount: 2 },
  );
  botInstallWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] bot install ${job?.id} failed:`, err?.message ?? err);
  });
  botInstallWorker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] bot install worker error:", err);
  });

  const imageframeWorker = new Worker<ImageframeJobData>(
    IMAGEFRAME_TRANSCODE_QUEUE,
    async (job) => {
      const imageframeId = BigInt(job.data.imageframeId);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      // eslint-disable-next-line no-console
      console.log(`[worker] preparing imageframe ${imageframeId} (attempt ${job.attemptsMade + 1})`);
      await processImageframe(imageframeId, { isFinalAttempt });
      // eslint-disable-next-line no-console
      console.log(`[worker] finished imageframe ${imageframeId}`);
    },
    { connection: createQueueConnection(), concurrency: 1, stalledInterval: 60_000, maxStalledCount: 2 },
  );
  imageframeWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] imageframe job ${job?.id} failed:`, err?.message ?? err);
  });
  imageframeWorker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] imageframe worker error:", err);
  });

  void sweepStrandedImageframe();
  const imageframeSweepTimer = setInterval(() => void sweepStrandedImageframe(), SWEEP_INTERVAL_MS);
  imageframeSweepTimer.unref();

  void sweepStranded();
  const sweepTimer = setInterval(() => void sweepStranded(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  void sweepThreads();
  const threadSweepTimer = setInterval(() => void sweepThreads(), THREAD_SWEEP_INTERVAL_MS);
  threadSweepTimer.unref();

  // Creator economy automation — §1.1's "no routine staff queues" made literal: the hold-window
  // release and the financial invariants run on the clock, forever, with no approve button.
  const economyTick = async () => {
    try {
      const rotation = await rotatePqKeys();
      // eslint-disable-next-line no-console
      if (rotation.rotated) console.log(`[worker] rotated PQ transport keypair -> kid ${rotation.kid}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] PQ key rotation failed:", err);
    }
    try {
      const reminded = await sweepEventReminders();
      // eslint-disable-next-line no-console
      if (reminded > 0) console.log(`[worker] sent reminders for ${reminded} upcoming event(s)`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] event reminder sweep failed:", err);
    }
    try {
      // Daily ad-spend pools → creator earnings, for any completed day not yet allocated.
      await sweepAdPools();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] ad pool sweep failed:", err);
    }
    try {
      const released = await releaseMaturedEarnings();
      // eslint-disable-next-line no-console
      if (released > 0) console.log(`[worker] released ${released} matured earning(s) to available`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] earnings release failed:", err);
    }
    try {
      const problems = await runFinancialAssertions();
      if (problems.length > 0) {
        // A failed invariant is a stop-the-world defect for money movement — logged at error and
        // (deliberately) NOT self-healed: reconciliation never edits balances, per §33.
        // eslint-disable-next-line no-console
        console.error("[worker] FINANCIAL ASSERTION FAILURES:", problems);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] reconciliation failed:", err);
    }
    try {
      // Age up any minor whose 18th birthday has passed but who hasn't logged in to trigger the
      // login-time recompute — so a dormant account still stops being restricted, and any parental
      // supervision on it ends, without a manual step. refreshMinorStatus re-verifies each precisely
      // (this query just narrows the scan) and severs the ParentLink on the true→false flip.
      const cutoff = new Date();
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18);
      const agedUp = await prisma.user.findMany({
        where: { isMinor: true, birthDate: { lte: cutoff } },
        select: { id: true },
        take: 500,
      });
      let flipped = 0;
      for (const u of agedUp) {
        if ((await refreshMinorStatus(u.id)) === false) flipped++;
      }
      // eslint-disable-next-line no-console
      if (flipped > 0) console.log(`[worker] aged ${flipped} account(s) out of minor status`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] minor age-up sweep failed:", err);
    }
  };
  void economyTick();
  const economyTimer = setInterval(() => void economyTick(), 5 * 60 * 1000);
  economyTimer.unref();

  // Identity documents from age verification are deleted once their retention window closes. The
  // account holder is told this in writing at upload time, so the sweep is the mechanism that keeps
  // that promise -- if it stops running, passports and selfies accumulate on disk indefinitely.
  // Runs every 15 minutes rather than hourly so the actual delete lands close to the stated
  // deadline rather than up to an hour past it.
  const identityDocTick = async () => {
    try {
      const cleared = await purgeExpiredReviewDocuments();
      if (cleared > 0) {
        // eslint-disable-next-line no-console
        console.log(`[worker] purged identity documents for ${cleared} decided age review(s)`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] identity-document purge failed:", err);
    }
  };
  void identityDocTick();
  const identityDocTimer = setInterval(() => void identityDocTick(), 15 * 60 * 1000);
  identityDocTimer.unref();

  // Graceful shutdown so an in-flight transcode is allowed to finish (or be re-queued cleanly)
  // instead of being killed mid-write and leaving a half-written MP4 behind.
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] received ${signal}, closing`);
    await worker.close();
    await imageframeWorker.close();
    await previewWorker.close();
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
