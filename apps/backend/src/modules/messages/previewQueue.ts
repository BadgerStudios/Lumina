import { Queue } from "bullmq";
import { createQueueConnection } from "../videos/queue.js";

export const LINK_PREVIEW_QUEUE = "link-preview";

export interface LinkPreviewJobData {
  previewId: string;
  /** Only used to address the realtime broadcast once the fetch lands. */
  messageId: string;
  room: string;
}

let queue: Queue<LinkPreviewJobData> | null = null;

export function getLinkPreviewQueue(): Queue<LinkPreviewJobData> {
  if (!queue) {
    queue = new Queue<LinkPreviewJobData>(LINK_PREVIEW_QUEUE, {
      connection: createQueueConnection(),
      defaultJobOptions: {
        // Two attempts, not three. Unlike a transcode, the failure modes here are mostly permanent
        // (host is gone, page is not HTML, address is not public) and each retry is another
        // outbound request to a destination someone else chose.
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queue;
}

/**
 * Never throws into the send path — same contract as enqueueTranscode, and for the same reason: a
 * queue hiccup must not be able to fail someone's message. A preview that is never fetched shows
 * as a message with no card, which is exactly what a message with no card looks like anyway.
 */
export async function enqueueLinkPreview(data: LinkPreviewJobData): Promise<void> {
  try {
    await getLinkPreviewQueue().add("fetch", data, {
      // Keyed on the preview, so ten people posting the same link in the same minute collapse onto
      // one fetch rather than ten. Hyphen not colon — BullMQ rejects ":" in a custom job id.
      jobId: `preview-${data.previewId}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[linkPreview] failed to enqueue preview ${data.previewId}:`, err);
  }
}
