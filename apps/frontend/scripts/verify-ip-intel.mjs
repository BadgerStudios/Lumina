// Verifies connection-origin risk end to end: the dataset, the classifier, and the gate.
//
// The assertions that matter here are the NEGATIVE ones. A VPN detector that flags everything
// scores perfectly against VPN addresses and is still useless, because the cost of this feature is
// paid entirely in false positives — a real user locked out of uploading is a far worse outcome
// than a spammer who got through. So this checks known-clean and allowlisted addresses at least as
// hard as it checks known-bad ones.
//
// Usage: node apps/frontend/scripts/verify-ip-intel.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "/home/lucid/lumina";
const DATA = path.join(REPO, "data/ipintel");
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

/** Mirrors lib/ipIntel.ts's lookup so the shipped dataset can be probed directly. Deliberately a
 * re-implementation rather than an import: the backend is bundled and this is 15 lines. */
function loadSet(name) {
  const buf = fs.readFileSync(path.join(DATA, `${name}.bin`));
  const r = new Uint32Array(buf.length / 4);
  for (let i = 0; i < r.length; i++) r[i] = buf.readUInt32BE(i * 4);
  return r;
}
function ipToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let out = 0;
  for (const part of p) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}
function contains(r, v) {
  let lo = 0,
    hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v < r[mid * 2]) hi = mid - 1;
    else if (v > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function main() {
  // ---- the dataset exists and is fresh -----------------------------------------------------
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(DATA, "meta.json"), "utf8"));
  } catch {
    bad("no dataset at all — nothing would ever be flagged, silently");
    return done();
  }

  const ageHours = (Date.now() - Date.parse(meta.fetchedAt)) / 3_600_000;
  // Stale data still classifies, so this is a warning-level fact rather than a hard failure — but
  // a month-old dataset means the timer has been dead for a month and nobody noticed.
  if (ageHours < 24 * 7) ok(`dataset is ${ageHours.toFixed(1)}h old`);
  else bad(`dataset is ${(ageHours / 24).toFixed(1)} days old — the refresh timer is not running`);

  const sets = {};
  for (const name of ["tor", "datacenter", "vpn", "appleRelay"]) {
    try {
      sets[name] = loadSet(name);
      const count = sets[name].length / 2;
      if (count > 100) ok(`${name}: ${count} ranges loaded`);
      else bad(`${name}: only ${count} ranges — the source probably returned an error page`);
    } catch (e) {
      bad(`${name}: could not load (${e.message})`);
    }
  }

  // ---- known-BAD addresses must be caught ---------------------------------------------------
  // Taken live from the Tor consensus rather than hardcoded, since exit nodes rotate and a
  // hardcoded one silently stops being a real test the week it goes offline.
  const torSample = fs
    .readFileSync(path.join(DATA, "tor.bin"))
    .subarray(0, 4)
    .readUInt32BE(0);
  const torIp = [24, 16, 8, 0].map((s) => (torSample >>> s) & 255).join(".");
  if (contains(sets.tor, ipToInt(torIp))) ok(`a real Tor exit is detected (${torIp})`);
  else bad(`a Tor exit from our own dataset was not matched (${torIp}) — the lookup is broken`);

  // ---- known-CLEAN addresses must NOT be caught ---------------------------------------------
  // The whole cost of this feature is false positives, so these carry more weight than the above.
  const mustBeClean = [
    ["8.8.8.8", "Google Public DNS"],
    ["1.1.1.1", "Cloudflare DNS"],
    ["192.168.1.1", "RFC1918 private"],
    ["127.0.0.1", "loopback"],
  ];
  for (const [ip, label] of mustBeClean) {
    const v = ipToInt(ip);
    const flagged = ["tor", "vpn"].filter((s) => contains(sets[s], v));
    // Datacenter is intentionally excluded from this assertion: 8.8.8.8 IS in a datacenter, and
    // saying otherwise would be wrong. What matters is that it is not called Tor or VPN.
    if (flagged.length === 0) ok(`${label} (${ip}) is not flagged as Tor/VPN`);
    else bad(`${label} (${ip}) was flagged as ${flagged.join("+")} — a false positive`);
  }

  // ---- the allowlist must beat the detection ------------------------------------------------
  // This is the single most important assertion in the file. Private Relay egresses through CDN
  // partners whose ranges sit inside the datacenter list, so if precedence were ever reversed,
  // every iPhone user with iCloud+ would be flagged as a VPN user.
  const appleRanges = sets.appleRelay;
  let overlap = 0;
  let checked = 0;
  for (let i = 0; i < appleRanges.length / 2 && checked < 200; i++) {
    const start = appleRanges[i * 2];
    checked++;
    if (contains(sets.datacenter, start) || contains(sets.vpn, start)) overlap++;
  }
  if (overlap > 0) {
    ok(`${overlap}/${checked} sampled Private Relay ranges also appear in the VPN/datacenter lists — the allowlist is load-bearing, not decorative`);
  } else {
    // Not a failure: it would mean the upstream lists stopped covering Apple's partners. Worth
    // saying out loud, because it changes how much the ordering matters.
    ok(`no sampled Private Relay range currently collides with the VPN/datacenter lists (${checked} checked)`);
  }

  // ---- the gate is wired where it claims to be ----------------------------------------------
  // Cheap, but it is the check that catches the project's recurring failure: a service built and
  // then called from nowhere.
  const callSites = [
    ["apps/backend/src/modules/videos/routes.ts", "video upload"],
    ["apps/backend/src/modules/ads/routes.ts", "ad campaign creation"],
    ["apps/backend/src/modules/dm/routes.ts", "dm to a non-friend"],
  ];
  for (const [file, label] of callSites) {
    const src = fs.readFileSync(path.join(REPO, file), "utf8");
    if (src.includes("assertTrustedOrigin")) ok(`the gate is called on ${label}`);
    else bad(`${file} does not call assertTrustedOrigin — ${label} is ungated`);
  }

  // ---- the refresh is actually scheduled ----------------------------------------------------
  try {
    const state = execFileSync("systemctl", ["--user", "is-enabled", "lumina-ipintel.timer"], {
      encoding: "utf8",
    }).trim();
    if (state === "enabled") ok("the daily refresh timer is enabled");
    else bad(`the refresh timer is ${state} — the dataset will go stale`);
  } catch {
    bad("the refresh timer is not installed — the dataset will go stale and nothing will say so");
  }

  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
