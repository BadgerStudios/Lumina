import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { describeRelease } from "./releases.js";
import { timingSafeEqual } from "node:crypto";
import { ServerEvents } from "@lumina/shared";
import { getIO } from "../../realtime/io.js";
import { ForbiddenError } from "../../lib/errors.js";

// Public, unauthenticated — the installed Android app needs to check this before the user is
// necessarily logged in, and it carries no sensitive information.
export default async function metaRoutes(fastify: FastifyInstance) {
  /**
   * What's currently published, for clients deciding whether to update themselves.
   *
   * `androidVersionCode` stays a top-level field forever. Installed APKs in the wild read exactly
   * that key, and an app too old to know about the newer shape is precisely the app that most
   * needs to be told an update exists — moving it under `android` would break the check for every
   * client that hasn't updated yet, which is a self-defeating way to ship an updater.
   */
  fastify.get("/version", async () => {
    const [android, owner] = await Promise.all([
      describeRelease("lumina.apk", "/api/download/android"),
      describeRelease("lumina-owner.apk", "/api/download/owner"),
    ]);
    return {
      androidVersionCode: env.ANDROID_VERSION_CODE,
      android: android ? { versionCode: env.ANDROID_VERSION_CODE, ...android } : null,
      // The owner console is a separate applicationId with its own APK, but it rides the same
      // version counter — see the bump block in deploy.sh. One counter for both means this field
      // can never drift from `androidVersionCode`, and a second counter would be one more thing to
      // forget to bump. The entry is still separate because the *file* and its digest differ, and
      // pointing the owner app at the chat APK's digest would fail every checksum check.
      owner: owner ? { versionCode: env.ANDROID_VERSION_CODE, ...owner } : null,
    };
  });

  /**
   * Upload limits, so the client never has to hardcode its own copy.
   *
   * The upload modal previously carried its own MAX_MB/MAX_DURATION_SEC constants that had to be
   * kept in step with the server's env by hand — and a client that thinks the cap is higher than
   * it is turns a clear "that's too big" into a long upload ending in a rejection.
   */
  fastify.get("/limits", async () => ({
    maxVideoUploadMb: env.MAX_VIDEO_UPLOAD_MB,
    maxVideoDurationSec: env.MAX_VIDEO_DURATION_SEC,
    maxVideoUploadsPerDay: env.MAX_VIDEO_UPLOADS_PER_DAY,
  }));

  /**
   * Tells every connected client to re-check for an update, now.
   *
   * Called by deploy.sh once the new artifacts are actually published and the stack is healthy —
   * not at boot. Broadcasting at boot would reach nobody: the backend restarting is what
   * disconnects every socket in the first place, so the message would go out before anyone had
   * reconnected, and the clients that most need it are precisely the ones that were connected.
   *
   * Authenticated with the same shared secret as the Lumina Control agent rather than a user
   * session, because the caller is a shell script with no login. Worst case if that secret leaks:
   * someone can make clients check for an update they already check for on a timer.
   */
  fastify.post("/announce-update", async (request) => {
    const configured = env.OPS_AGENT_SECRET;
    if (!configured) throw new ForbiddenError("Not configured");
    const presented = request.headers["x-lumina-agent-secret"];
    if (typeof presented !== "string") throw new ForbiddenError("Not authorized");
    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenError("Not authorized");

    let notified = 0;
    try {
      const io = getIO();
      // Every socket, not a room. This is the one message in the product with no audience smaller
      // than "everyone currently using Lumina".
      io.emit(ServerEvents.APP_UPDATE_AVAILABLE, { at: new Date().toISOString() });
      notified = io.sockets.sockets.size;
    } catch {
      // No socket server in this process — nothing to notify, and not a reason to fail a deploy.
    }
    request.log.warn({ notified }, "announced an update to connected clients");
    return { notified };
  });
}
