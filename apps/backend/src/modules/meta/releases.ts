import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readApkSignerSha256 } from "./apkSigner.js";

/**
 * Describes the currently-published native builds so an installed client can tell whether it is
 * out of date, and fetch the replacement itself.
 *
 * The digest is the point of this file. The Android client downloads an APK over the network and
 * then asks the OS to install it — so the bytes have to be checked against something the app
 * trusts. Publishing the digest through the API means it arrives over a different path from the
 * file itself, and a substituted download fails the comparison rather than being installed.
 * (Desktop doesn't appear here: electron-updater has its own signed `latest-linux.yml` manifest
 * and does the same check itself.)
 *
 * The SIGNER digest is published for the same reason and answers a different question. Android
 * refuses to update an installed app with a package signed by a different certificate, and the
 * only way a client could previously discover that was to download the whole APK and watch the
 * system installer refuse it with no explanation the app ever sees. Publishing what the file is
 * actually signed with lets the client compare against its own signature first — see the Android
 * updater's getSigningInfo and components/layout/UpdateBanner.tsx.
 */

/** Where compose bind-mounts ./downloads, read-only. */
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? "/downloads";

export interface ReleaseFile {
  url: string;
  sizeBytes: number;
  sha256: string;
  /** SHA-256 of the signer certificate, read out of the APK itself. Null when it cannot be read
   * with certainty (a v1-only or unsigned package, or a non-APK artifact) — which the client
   * treats as "unknown", never as a mismatch. */
  signingSha256: string | null;
}

interface CacheEntry extends ReleaseFile {
  /** Cache key: hashing a ~7MB file on every poll from every installed client would be pointless
   * work, and the file only ever changes on a deploy. */
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

export async function describeRelease(fileName: string, publicUrl: string): Promise<ReleaseFile | null> {
  const filePath = path.join(DOWNLOADS_DIR, fileName);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    // A build that hasn't been published yet is a normal state (a --web-only deploy never touches
    // these), not an error — the client simply sees no update available.
    return null;
  }

  const cached = cache.get(fileName);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
    return { url: cached.url, sizeBytes: cached.sizeBytes, sha256: cached.sha256, signingSha256: cached.signingSha256 };
  }

  // Both reads are cached on the same key: the signer digest is a couple of seeks rather than a
  // full pass, but neither should run per poll per installed client.
  const [sha256, signingSha256] = await Promise.all([
    hashFile(filePath),
    fileName.endsWith(".apk") ? readApkSignerSha256(filePath) : Promise.resolve(null),
  ]);
  const entry: CacheEntry = { url: publicUrl, sizeBytes: stat.size, sha256, signingSha256, mtimeMs: stat.mtimeMs };
  cache.set(fileName, entry);
  return { url: entry.url, sizeBytes: entry.sizeBytes, sha256: entry.sha256, signingSha256: entry.signingSha256 };
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
