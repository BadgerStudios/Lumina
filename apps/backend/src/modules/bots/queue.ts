import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../config/env.js";

export const BOT_INSTALL_QUEUE = "bot-install";

export interface BotInstallJobData {
  requestId: string;
}

/** Same rationale as the transcode queue: BullMQ holds blocking connections and needs
 * `maxRetriesPerRequest: null`, so it gets its own client rather than sharing the app's. */
export function createQueueConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on("error", (err) => {
    console.error("[bots] queue redis connection error:", err.message);
  });
  return connection;
}

let queue: Queue<BotInstallJobData> | null = null;

export function getBotInstallQueue(): Queue<BotInstallJobData> {
  if (!queue) {
    queue = new Queue<BotInstallJobData>(BOT_INSTALL_QUEUE, { connection: createQueueConnection() });
  }
  return queue;
}

export async function enqueueBotInstall(data: BotInstallJobData): Promise<void> {
  await getBotInstallQueue().add("install", data, {
    removeOnComplete: 100,
    removeOnFail: 200,
    // One retry: the fetches this job makes are network-bound and a transient GitHub/npm blip
    // should not strand a request. More than that just repeats a real failure at the user.
    attempts: 2,
    backoff: { type: "exponential", delay: 5_000 },
  });
}
