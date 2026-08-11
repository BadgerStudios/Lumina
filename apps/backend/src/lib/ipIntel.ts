import fs from "node:fs";
import path from "node:path";
import type { FastifyRequest } from "fastify";

/**
 * Classifies a client IP as Tor / VPN / datacenter / clean, from a local dataset.
 *
 * ## What this is for, and what it is not
 *
 * It is a **risk signal**, not an access control. The result gates the things abuse actually rides
 * on — a brand-new account uploading video, buying ads, or messaging strangers — rather than
 * refusing the connection. That distinction is the whole design:
 *
 *  - Nothing free detects **residential proxies**, which is exactly what a determined ban evader
 *    uses. So this raises the cost of casual abuse and bulk signups, and does close to nothing
 *    against the persistent case. Device and behavioural signals remain the lever there.
 *  - The false-positive bill lands on real users: corporate VPNs, university networks, travellers,
 *    and above all **iCloud Private Relay**, which is why its egress ranges are loaded as an
 *    explicit allowlist and checked FIRST. Without that, most iPhone users with iCloud+ would be
 *    flagged as VPN users.
 *
 * ## Why a local dataset
 *
 * A detection API would mean sending every user's address to a third party on every login, adding
 * latency to the auth path and a dependency that takes login down with it. This is a few hundred KB
 * of sorted integers searched in-process; no address ever leaves the box.
 *
 * ## Failure behaviour: always open
 *
 * A missing dataset, an unparseable address, or an IPv6 client all return UNKNOWN, which callers
 * treat as clean. Deliberate. The cost of missing a VPN user is one unflagged signup; the cost of a
 * false positive is a real user locked out of features they paid attention to. When in doubt, let
 * them through and keep the flag for review.
 */

export type IpRisk = "CLEAN" | "TOR" | "VPN" | "DATACENTER" | "UNKNOWN";

export interface IpAssessment {
  risk: IpRisk;
  /** True for TOR/VPN/DATACENTER — i.e. the connection is deliberately obscuring its origin. */
  anonymised: boolean;
  /** Set when an allowlist matched, so a decision can be explained rather than just made. */
  note?: string;
}

const DATA_DIR = process.env.IP_INTEL_DIR ?? "/data/ipintel";
/** Sets are re-read when the files change, so `update-ip-intel.mjs` takes effect without a restart
 * — checked at most this often, since statting four files per request would be silly. */
const RELOAD_INTERVAL_MS = 5 * 60 * 1000;

type SetName = "tor" | "datacenter" | "vpn" | "appleRelay";
const SET_NAMES: SetName[] = ["tor", "datacenter", "vpn", "appleRelay"];

interface LoadedSet {
  /** Flat [start0, end0, start1, end1, ...], sorted by start, ranges disjoint and merged. */
  ranges: Uint32Array;
  mtimeMs: number;
}

const sets = new Map<SetName, LoadedSet>();
let lastLoadCheck = 0;

function loadSet(name: SetName): LoadedSet | null {
  const file = path.join(DATA_DIR, `${name}.bin`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const cached = sets.get(name);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  try {
    const buf = fs.readFileSync(file);
    // Copied into a correctly-aligned buffer rather than wrapped in place: a Node Buffer is a view
    // into a shared pool at an arbitrary byteOffset, and Uint32Array requires 4-byte alignment —
    // wrapping directly throws "start offset must be a multiple of 4" for some reads and not others,
    // which would be an intermittent failure depending on unrelated allocations.
    const ranges = new Uint32Array(buf.length / 4);
    for (let i = 0; i < ranges.length; i++) ranges[i] = buf.readUInt32BE(i * 4);
    const loaded = { ranges, mtimeMs: stat.mtimeMs };
    sets.set(name, loaded);
    return loaded;
  } catch {
    return cached ?? null;
  }
}

function ensureLoaded() {
  const now = Date.now();
  if (now - lastLoadCheck < RELOAD_INTERVAL_MS && sets.size > 0) return;
  lastLoadCheck = now;
  for (const name of SET_NAMES) loadSet(name);
}

/** Dotted quad -> uint32, or null for anything that isn't a plain IPv4 literal (including every
 * IPv6 address, which this dataset cannot speak to — see the failure-behaviour note above). */
export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** Binary search over disjoint sorted [start, end] pairs. */
function contains(set: LoadedSet | null, value: number): boolean {
  if (!set || set.ranges.length === 0) return false;
  const r = set.ranges;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = r[mid * 2];
    const end = r[mid * 2 + 1];
    if (value < start) hi = mid - 1;
    else if (value > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Assesses a bare address.
 *
 * Order matters and is not arbitrary: the allowlist wins over every detection, because a Private
 * Relay address IS a datacenter address and would otherwise be flagged by the very next check.
 */
export function assessIp(ip: string | null | undefined): IpAssessment {
  if (!ip) return { risk: "UNKNOWN", anonymised: false };
  const value = ipToInt(ip);
  if (value === null) return { risk: "UNKNOWN", anonymised: false };

  ensureLoaded();

  if (contains(sets.get("appleRelay") ?? null, value)) {
    return { risk: "CLEAN", anonymised: false, note: "iCloud Private Relay" };
  }
  if (contains(sets.get("tor") ?? null, value)) return { risk: "TOR", anonymised: true };
  if (contains(sets.get("vpn") ?? null, value)) return { risk: "VPN", anonymised: true };
  if (contains(sets.get("datacenter") ?? null, value)) return { risk: "DATACENTER", anonymised: true };

  return { risk: "CLEAN", anonymised: false };
}

/**
 * Assesses the request's client.
 *
 * Cloudflare reports Tor as country `T1`, which is authoritative for the current circuit and covers
 * IPv6 exits that the IPv4-only dataset cannot — so it is checked first and independently. See
 * modules/site/routes.ts, which recognises the same marker for country purposes.
 *
 * `request.ip` is trustworthy here only because nginx replaces X-Forwarded-For with Cloudflare's
 * CF-Connecting-IP rather than appending to the client's own header (see apps/frontend/nginx.conf).
 * Before that fix a client could name its own address, and every check in this file would have been
 * evaluating a value the attacker chose.
 */
export function assessRequest(request: FastifyRequest): IpAssessment {
  const raw = request.headers["cf-ipcountry"];
  const country = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  if (country === "T1") return { risk: "TOR", anonymised: true, note: "cf-ipcountry" };
  return assessIp(request.ip);
}

/** Whether the dataset is actually present and how fresh it is — surfaced in the owner console, so
 * "nothing is being flagged" can be told apart from "the dataset never loaded". */
export function ipIntelStatus(): {
  available: boolean;
  fetchedAt: string | null;
  sets: Record<string, number>;
} {
  ensureLoaded();
  let fetchedAt: string | null = null;
  try {
    fetchedAt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "meta.json"), "utf8")).fetchedAt ?? null;
  } catch {
    /* no meta file — the counts below still describe what loaded */
  }
  const counts: Record<string, number> = {};
  for (const name of SET_NAMES) counts[name] = (sets.get(name)?.ranges.length ?? 0) / 2;
  return { available: Object.values(counts).some((n) => n > 0), fetchedAt, sets: counts };
}
