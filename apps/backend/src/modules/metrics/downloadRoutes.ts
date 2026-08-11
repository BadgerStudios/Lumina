import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { recordAppDownload, recordBandwidth } from "./service.js";
import { requestCountry } from "../site/routes.js";

/**
 * Counted download endpoint for app releases. Mounted under /api/download.
 *
 * The files themselves are also served directly by nginx at /downloads/ (see
 * apps/frontend/nginx.conf), which is faster but invisible to the application — nginx can't write to
 * Postgres. Rather than fight that, this adds a *counted* path that the site's own download buttons
 * point at; the nginx path stays as a direct link for anyone who has one.
 *
 * That does mean the count reflects downloads started from the app's own UI, not every possible
 * fetch of the file. Stated here so the number is never mistaken for a total byte-for-byte count.
 */
const RELEASES: Record<string, { file: string; platform: string; contentType: string }> = {
  android: { file: "lumina.apk", platform: "android", contentType: "application/vnd.android.package-archive" },
  owner: { file: "lumina-owner.apk", platform: "android-owner", contentType: "application/vnd.android.package-archive" },
  desktop: { file: "lumina-desktop.AppImage", platform: "desktop-linux", contentType: "application/octet-stream" },
};

/** Where compose bind-mounts ./downloads for the frontend container. The backend reads the same
 * files from the repo path, since it has no such mount. */
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? "/downloads";

export default async function downloadRoutes(fastify: FastifyInstance) {
  fastify.get("/:target", async (request, reply) => {
    const { target } = request.params as { target: string };
    const release = RELEASES[target];
    // Whitelist lookup rather than joining user input onto a path — the latter is the classic
    // directory-traversal hole (`../../etc/passwd`).
    if (!release) return reply.code(404).send({ error: "Unknown download" });

    const filePath = path.join(DOWNLOADS_DIR, release.file);
    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      return reply.code(404).send({ error: "That release isn't available right now" });
    }

    void recordAppDownload({
      platform: release.platform,
      fileName: release.file,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      country: requestCountry(request),
    });
    recordBandwidth("download", size);

    reply.header("Content-Type", release.contentType);
    reply.header("Content-Length", size.toString());
    reply.header("Content-Disposition", `attachment; filename="${release.file}"`);
    return reply.send(createReadStream(filePath));
  });
}
