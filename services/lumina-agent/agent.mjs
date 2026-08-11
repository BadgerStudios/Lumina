#!/usr/bin/env node
// Lumina Control agent.
//
// Runs on the HOST, outside every container, as a plain systemd user service. Its whole job is to
// look at Docker and the machine, POST what it saw, and carry out whichever of a handful of
// allowlisted actions came back.
//
// ## Why it polls out instead of listening
//
// The obvious design is an HTTP endpoint on this agent that the API calls when an owner clicks
// "restart". That is also a straight line from the public internet to the Docker socket, which is
// root-equivalent on this box — one auth bug in a chat app and someone owns the host.
//
// So there is no inbound path at all. The agent opens the connection, and commands ride back on
// the response to its own report. An attacker who fully controls the API can still only ask for
// things on the list below, against the services on the list below, and this process is the one
// that decides whether to comply.
//
// ## What it deliberately cannot do
//
// - Run an arbitrary command. There is no passthrough; `action` indexes a fixed table.
// - Touch anything outside Lumina's own Compose project.
// - Restart postgres. Restarting the database from a web button is a foot-gun with no upside.
// - Read or write application data. It never talks to Postgres or Redis.
//
// Usage: OPS_AGENT_SECRET=… node agent.mjs   (see lumina-agent.service)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

const execFileAsync = promisify(execFile);

const AGENT_VERSION = "1.0.0";
const AGENT_ID = process.env.OPS_AGENT_ID ?? os.hostname();
const API_BASE = process.env.OPS_API_BASE ?? "http://127.0.0.1:4000";
const SECRET = process.env.OPS_AGENT_SECRET;
const REPO_DIR = process.env.LUMINA_REPO_DIR ?? "/home/lucid/lumina";
const INTERVAL_MS = Number(process.env.OPS_INTERVAL_MS ?? 30_000);

if (!SECRET) {
  console.error("OPS_AGENT_SECRET is not set — refusing to start");
  process.exit(1);
}

/** The second half of the allowlist. The API enforces the same set; this one is what actually
 * matters, because it is the copy an attacker who owns the API cannot edit. */
const ALLOWED_ACTIONS = new Set(["restart", "start", "stop"]);
const ALLOWED_TARGETS = new Set(["backend", "worker", "frontend", "redis", "coturn"]);

const DOCKER_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 120_000;

async function docker(args, timeout = DOCKER_TIMEOUT_MS) {
  const { stdout } = await execFileAsync("docker", args, {
    cwd: REPO_DIR,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** `docker compose ps --format json` emits either a JSON array or one object per line depending on
 * the Compose version. Handling both is cheaper than pinning a version. */
function parseLoose(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function collectContainers() {
  const ps = parseLoose(await docker(["compose", "ps", "--all", "--format", "json"]));

  // Live CPU/memory comes from a separate call. `--no-stream` takes a single sample rather than
  // streaming forever, which is the difference between a 1s call and a hung process.
  let statsByName = new Map();
  try {
    const stats = parseLoose(
      await docker([
        "stats", "--no-stream", "--format",
        "{{json .}}",
        ...ps.filter((c) => c.State === "running").map((c) => c.Name),
      ]),
    );
    statsByName = new Map(stats.map((s) => [s.Name, s]));
  } catch {
    // A container exiting between the two calls makes `docker stats` fail outright. The report is
    // still worth sending with null usage — knowing a service is down matters more than its CPU.
  }

  return ps.map((c) => {
    const s = statsByName.get(c.Name);
    return {
      name: c.Name ?? "",
      service: c.Service ?? "",
      state: c.State ?? "",
      // Empty for services with no healthcheck. Passed through as-is so the UI can tell "no
      // healthcheck" from "unhealthy" rather than painting both red.
      health: c.Health ?? "",
      status: c.Status ?? "",
      cpuPercent: s ? parsePercent(s.CPUPerc) : null,
      memBytes: s ? parseBytes((s.MemUsage ?? "").split("/")[0]) : null,
      memLimitBytes: s ? parseBytes((s.MemUsage ?? "").split("/")[1]) : null,
      restartCount: null,
      startedAt: c.CreatedAt ?? null,
    };
  });
}

function parsePercent(v) {
  const n = Number(String(v ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
function parseBytes(v) {
  const m = /([\d.]+)\s*([A-Za-z]+)/.exec(String(v ?? "").trim());
  if (!m) return null;
  const scale = UNITS[m[2].toUpperCase()];
  return scale ? Math.round(Number(m[1]) * scale) : null;
}

/** MemAvailable, not MemFree: free memory on a healthy Linux box is near zero because the page
 * cache uses the rest, and reporting it would show a permanent scary red bar. */
async function memAvailableBytes() {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1]);
    return Number.isFinite(kb) ? kb * 1024 : os.freemem();
  } catch {
    return os.freemem();
  }
}

async function collectHost() {
  let disk = { total: null, free: null };
  try {
    const s = await statfs(REPO_DIR);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    /* statfs unsupported */
  }

  return {
    hostname: os.hostname(),
    uptimeSeconds: Math.floor(os.uptime()),
    loadAverage: os.loadavg(),
    cpuCount: os.cpus().length,
    memTotalBytes: os.totalmem(),
    memAvailableBytes: await memAvailableBytes(),
    diskTotalBytes: disk.total,
    diskFreeBytes: disk.free,
  };
}

async function runCommand(command) {
  // Checked here, independently of whatever the API said. This is the boundary that matters.
  if (!ALLOWED_ACTIONS.has(command.action) || !ALLOWED_TARGETS.has(command.target)) {
    return { ok: false, output: `Refused: ${command.action} ${command.target} is not permitted` };
  }
  try {
    const out = await docker(["compose", command.action, command.target], ACTION_TIMEOUT_MS);
    return { ok: true, output: (out || `${command.action} ${command.target} completed`).slice(0, 2000) };
  } catch (err) {
    return { ok: false, output: String(err?.stderr || err?.message || err).slice(0, 2000) };
  }
}

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lumina-agent-secret": SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function cycle() {
  let containers = [];
  let dockerError = null;
  try {
    containers = await collectContainers();
  } catch (err) {
    // Still report. "The agent is alive but blind" is a different and more useful signal than the
    // silence you get from exiting.
    dockerError = String(err?.message ?? err).slice(0, 500);
  }

  const { commands } = await post("/api/ops/report", {
    agentId: AGENT_ID,
    agentVersion: AGENT_VERSION,
    reportedAt: new Date().toISOString(),
    host: await collectHost(),
    containers,
    dockerError,
  });

  for (const command of commands ?? []) {
    const result = await runCommand(command);
    console.log(`[agent] ${command.action} ${command.target} -> ${result.ok ? "ok" : "failed"}`);
    try {
      await post(`/api/ops/commands/${command.id}/result`, result);
    } catch (err) {
      // The command ran; only the acknowledgement failed. It will age out as EXPIRED rather than
      // being run a second time, which is the safe direction for something like a restart.
      console.warn(`[agent] could not report result: ${err.message}`);
    }
  }
}

console.log(`[agent] ${AGENT_ID} v${AGENT_VERSION} reporting to ${API_BASE} every ${INTERVAL_MS}ms`);

let running = false;
async function tick() {
  // A cycle that overruns the interval must not stack. Restarting five services takes minutes, and
  // overlapping runs would claim the same commands twice.
  if (running) return;
  running = true;
  try {
    await cycle();
  } catch (err) {
    console.warn(`[agent] cycle failed: ${err.message}`);
  } finally {
    running = false;
  }
}

void tick();
setInterval(() => void tick(), INTERVAL_MS);
