#!/usr/bin/env node
// Publishes the built app releases to R2 and writes the manifest the API serves from.
//
// Run by deploy.sh after the native builds. Safe to run when R2 isn't configured: it writes the
// local manifest and skips the upload, so the existing origin-served downloads keep working
// exactly as they do today.
//
// ## The rule that shapes this whole file
//
// **Every URL an already-installed client knows must keep working.** An installed APK has
// `/api/download/android` compiled into it; an installed desktop app has
// `https://lumina.badgerstudios.net/downloads/desktop` baked into its app-update.yml. Moving
// releases to R2 by changing those URLs would mean every client in the field silently never
// updates again — which is a self-defeating way to ship an update system. So the URLs stay put and
// only what sits behind them changes: nginx serves them from R2 once RELEASES_PUBLIC_BASE is set,
// and from local disk until then.
//
// ## Two buckets, not one
//
// Releases go to a PUBLIC bucket. Backups go to a PRIVATE one. They cannot be the same bucket: the
// backups contain password hashes, emails and dates of birth, and app downloads have to be
// world-readable. Getting that wrong isn't fixable after the fact.

import fs from "node:fs";
import path from "node:path";
import { loadEnv, r2Configured, r2Client, putFile, listKeys } from "./r2.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const DOWNLOADS = path.join(REPO, "downloads");

loadEnv(REPO);

const BUCKET = process.env.RELEASES_S3_BUCKET ?? "lumina-releases";
/** How many superseded desktop builds stay downloadable. A client that started downloading just
 * before a deploy is still fetching the previous one. */
const KEEP_DESKTOP = 3;

// Two cache policies, decided by whether a filename can ever change meaning.
//
// Stable names (lumina.apk, latest-linux.yml) are OVERWRITTEN in place on every deploy, so the
// same URL returns different bytes over time and must never be cached — otherwise a shipped fix
// sits invisible behind an edge copy of the previous build, which is precisely what happened the
// first time these were published.
//
// Versioned names (Lumina-1.0.7.AppImage) can never change, so they get a year and ride the CDN
// properly. That is where the bandwidth saving actually comes from anyway.
const NO_CACHE = "no-store, no-cache, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";

const ARTIFACTS = [
  { file: "lumina.apk", key: "lumina.apk", type: "application/vnd.android.package-archive", label: "android" },
  { file: "lumina-owner.apk", key: "lumina-owner.apk", type: "application/vnd.android.package-archive", label: "android-owner" },
  { file: "lumina-desktop.AppImage", key: "lumina-desktop.AppImage", type: "application/octet-stream", label: "desktop-linux" },
];

async function main() {
  const manifest = { publishedAt: new Date().toISOString(), remote: false, artifacts: {} };

  const present = ARTIFACTS.filter((a) => fs.existsSync(path.join(DOWNLOADS, a.file)));
  if (present.length === 0) {
    console.log("[release] nothing built to publish");
    return;
  }

  // The manifest is written whether or not R2 is reachable, because the API reads the digests from
  // it. Publishing offsite is an optimisation; knowing what was published is not.
  const client = r2Configured() ? r2Client() : null;
  if (!client) {
    console.log("[release] R2 not configured — writing the local manifest only");
  }

  for (const artifact of present) {
    const filePath = path.join(DOWNLOADS, artifact.file);
    const stat = fs.statSync(filePath);

    let entry;
    if (client) {
      entry = await putFile(client, BUCKET, artifact.key, filePath, artifact.type, NO_CACHE);
      console.log(`[release] uploaded ${artifact.key} (${(entry.sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
    } else {
      const { sha256File } = await import("./r2.mjs");
      entry = { key: artifact.key, sizeBytes: stat.size, sha256: sha256File(filePath) };
    }
    manifest.artifacts[artifact.label] = entry;
  }

  // The desktop update feed: the versioned AppImage and the yml electron-updater reads. Uploaded
  // under the same `desktop/` prefix the installed clients already request, so the path an app was
  // built with keeps resolving.
  const desktopDir = path.join(DOWNLOADS, "desktop");
  if (client && fs.existsSync(desktopDir)) {
    for (const name of fs.readdirSync(desktopDir)) {
      const filePath = path.join(desktopDir, name);
      if (!fs.statSync(filePath).isFile()) continue;
      const type = name.endsWith(".yml") ? "text/yaml" : "application/octet-stream";
      // The yml is rewritten every deploy; the versioned AppImage beside it never is.
      const cache = name.endsWith(".yml") ? NO_CACHE : IMMUTABLE;
      await putFile(client, BUCKET, `desktop/${name}`, filePath, type, cache);
      console.log(`[release] uploaded desktop/${name}`);
    }

    // Prune superseded AppImages remotely, by exact key, newest kept. Never a prefix delete: the
    // manifest lives under the same prefix and removing it would break every desktop client's
    // update check at once.
    const remote = await listKeys(client, BUCKET, "desktop/Lumina-");
    const stale = remote
      .filter((o) => o.key.endsWith(".AppImage"))
      .sort((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0))
      .slice(KEEP_DESKTOP)
      .map((o) => o.key);
    if (stale.length > 0) {
      const { deleteKeys } = await import("./r2.mjs");
      await deleteKeys(client, BUCKET, stale);
      console.log(`[release] pruned ${stale.length} superseded desktop build(s)`);
    }
  }

  manifest.remote = Boolean(client);
  fs.writeFileSync(path.join(DOWNLOADS, "releases.json"), JSON.stringify(manifest, null, 2));
  console.log(`[release] manifest written (remote=${manifest.remote})`);
}

main().catch((err) => {
  // A failed upload must not fail the deploy: the app is already live and the origin still serves
  // downloads. Loud, but not fatal.
  console.error(`[release] publish failed: ${err.message}`);
  process.exitCode = 0;
});
