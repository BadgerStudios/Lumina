// Refreshes the local IP-reputation dataset used by apps/backend/src/lib/ipIntel.ts.
//
// ## Why a local dataset rather than a lookup API
//
// The obvious implementation is calling a VPN-detection API per request. That would mean sending
// every user's IP address to a third party on every signup and login — a real privacy cost for a
// chat platform, a per-request latency cost, and a new hard dependency that fails the login route
// when it goes down. Everything here is instead fetched periodically and evaluated in-process
// against a few hundred KB of sorted integers, so no user's address ever leaves the box.
//
// ## The sources, and what each is actually good for
//
//   - Tor exits (torproject.org)   — authoritative, published by the people running the network.
//   - Datacenter + VPN CIDRs       — commercial VPNs exit from hosting providers; real people do
//                                    not browse from OVH. Catches the casual VPN, not a residential
//                                    proxy, and nothing free catches those.
//   - iCloud Private Relay (Apple) — an ALLOWLIST, and the single most important file here. Private
//                                    Relay egresses through CDN partners whose ranges sit squarely
//                                    in the datacenter list, so without this every iPhone user with
//                                    iCloud+ gets flagged as a VPN user. That is not a hypothetical
//                                    false positive; it is most of them.
//
// IPv4 only, deliberately. No free IPv6 datacenter/VPN list exists upstream (both ipv6.txt files
// 404), so an IPv6 address is simply never flagged — the check fails OPEN. For a risk signal that
// gates features, failing open is correct: the cost of missing a VPN user is one unflagged signup,
// the cost of a false positive is a locked-out real user. That also makes Apple's 246k IPv6 rows
// unnecessary, since nothing would have flagged them anyway.
//
// Usage: node scripts/update-ip-intel.mjs [--out DIR]

import fs from "node:fs";
import path from "node:path";

const OUT_DIR =
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : path.resolve(import.meta.dirname, "../data/ipintel");

const SOURCES = {
  tor: { url: "https://check.torproject.org/torbulkexitlist", kind: "ips" },
  datacenter: { url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt", kind: "cidrs" },
  vpn: { url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt", kind: "cidrs" },
  appleRelay: { url: "https://mask-api.icloud.com/egress-ip-ranges.csv", kind: "csv" },
};

/** Dotted quad -> uint32. Returns null for anything that isn't a plain IPv4 literal. */
function ipToInt(ip) {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out * 256 + n) >>> 0;
  }
  return out >>> 0;
}

function cidrToRange(cidr) {
  const [addr, bitsRaw] = cidr.trim().split("/");
  const start = ipToInt(addr);
  if (start === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  // `>>> 0` throughout: JS bitwise ops produce signed 32-bit, and a /0 or /1 would otherwise come
  // out negative and sort before every real range.
  const size = bits === 0 ? 2 ** 32 : 2 ** (32 - bits);
  const masked = bits === 0 ? 0 : (start & (((-1 << (32 - bits)) >>> 0) | 0)) >>> 0;
  return [masked, (masked + size - 1) >>> 0];
}

function parse(text, kind) {
  const ranges = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (kind === "ips") {
      const n = ipToInt(trimmed);
      if (n !== null) ranges.push([n, n]);
    } else if (kind === "cidrs") {
      const r = cidrToRange(trimmed);
      if (r) ranges.push(r);
    } else if (kind === "csv") {
      // Apple: "<cidr>,<country>,<region>,<city>,". IPv6 rows are skipped by cidrToRange returning
      // null on a non-dotted address, which is exactly what we want.
      const r = cidrToRange(trimmed.split(",")[0]);
      if (r) ranges.push(r);
    }
  }
  return ranges;
}

/** Sorts and merges touching/overlapping ranges, so lookup is one binary search over disjoint
 * intervals rather than a scan that has to keep looking after the first hit. */
function normalise(ranges) {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    // `start - 1` merges adjacency too: [1,5] and [6,9] become [1,9].
    if (last && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

function writeBin(file, ranges) {
  const buf = Buffer.allocUnsafe(ranges.length * 8);
  ranges.forEach(([start, end], i) => {
    buf.writeUInt32BE(start, i * 8);
    buf.writeUInt32BE(end, i * 8 + 4);
  });
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const meta = { fetchedAt: new Date().toISOString(), sets: {} };
  let failures = 0;

  for (const [name, { url, kind }] of Object.entries(SOURCES)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ranges = normalise(parse(await res.text(), kind));

      // A source that suddenly returns almost nothing is far more likely to be an upstream outage
      // or an HTML error page than a real collapse in the data — and writing that over a good file
      // would silently disable the check. Refuse rather than overwrite.
      if (ranges.length < 100) throw new Error(`only ${ranges.length} ranges parsed; refusing to overwrite`);

      const bytes = writeBin(path.join(OUT_DIR, `${name}.bin`), ranges);
      meta.sets[name] = { ranges: ranges.length, bytes };
      console.log(`[ip-intel] ${name}: ${ranges.length} ranges (${(bytes / 1024).toFixed(0)}KB)`);
    } catch (e) {
      failures++;
      console.error(`[ip-intel] ${name} FAILED: ${e.message} — keeping the previous file`);
    }
  }

  // Written last and only over what succeeded, so a partial refresh leaves the older sets described
  // by their own previous entries rather than claiming a fresh fetch that didn't happen.
  const existing = fs.existsSync(path.join(OUT_DIR, "meta.json"))
    ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, "meta.json"), "utf8"))
    : { sets: {} };
  meta.sets = { ...existing.sets, ...meta.sets };
  fs.writeFileSync(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  // Non-zero only if EVERY source failed: a stale dataset still classifies, and failing the whole
  // deploy over one unreachable list would be worse than running on yesterday's data.
  if (failures === Object.keys(SOURCES).length) {
    console.error("[ip-intel] every source failed");
    process.exit(1);
  }
}

main();
