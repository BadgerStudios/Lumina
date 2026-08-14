#!/usr/bin/env node
/**
 * Lumina Game Agent (reference, standalone).
 *
 * Runs on the OWNER's machine (VPS / cloud / PC). It is the bridge between Lumina's control plane
 * and a Minecraft server running locally — Lumina never sees the server or its mods, only what
 * this agent chooses to report. It:
 *
 *   1. authenticates to Lumina with its scoped agent token (GameAgent <token>),
 *   2. heartbeats status + connect address + player count + a tail of console output,
 *   3. receives queued control verbs (start / stop / restart) and the owner's spec,
 *   4. launches the server locally with that spec — here via the standard `itzg/minecraft-server`
 *      Docker image, which already supports every loader (Paper/Fabric/Forge/Quilt/Spigot/Purpur),
 *      any version, custom maps, and arbitrary mods/plugins.
 *
 * The token can reach NOTHING in Lumina except this sandbox's own agent endpoints, so even a
 * fully-compromised agent cannot touch other users or core systems. All the untrusted execution
 * lives here, on the owner's hardware, by design.
 *
 * Usage:
 *   LUMINA_URL=https://lumina.badgerstudios.net \
 *   LUMINA_AGENT_TOKEN=lga_xxx \
 *   PUBLIC_ADDRESS=your.host:25565 \
 *   node lumina-game-agent.mjs
 *
 * Set AGENT_DRIVER=docker (default) to run itzg/minecraft-server, or AGENT_DRIVER=command with
 * SERVER_CMD="java -jar server.jar nogui" to wrap an existing server jar instead.
 */
import { spawn } from "node:child_process";

const LUMINA_URL = (process.env.LUMINA_URL ?? "https://lumina.badgerstudios.net").replace(/\/$/, "");
const TOKEN = process.env.LUMINA_AGENT_TOKEN;
const PUBLIC_ADDRESS = process.env.PUBLIC_ADDRESS ?? null;
const DRIVER = process.env.AGENT_DRIVER ?? "docker";
const HEARTBEAT_MS = 10_000;
if (!TOKEN) { console.error("LUMINA_AGENT_TOKEN is required (mint it in Lumina → your sandbox)"); process.exit(1); }

let status = "OFFLINE";
let child = null;
let spec = null;
const consoleRing = [];
const log = (line) => {
  const s = line.toString().trimEnd();
  if (!s) return;
  process.stdout.write(s + "\n");
  consoleRing.push(s);
  while (consoleRing.length > 60) consoleRing.shift();
  if (/Done \([\d.]+s\)!/.test(s)) status = "ONLINE";
};

function specToEnv(sp) {
  const s = sp ?? {};
  const env = {
    EULA: "TRUE",
    TYPE: s.serverType ?? "PAPER",
    MEMORY: `${s.memoryMb ?? 2048}M`,
    ...(s.mcVersion ? { VERSION: s.mcVersion } : {}),
    ...(s.motd ? { MOTD: s.motd } : {}),
    // itzg understands MODS/PLUGINS as newline/comma URL lists — the owner's arbitrary jars,
    // fetched and dropped in on THEIR machine.
    ...(Array.isArray(s.mods) && s.mods.length ? { MODS: s.mods.join("\n") } : {}),
    ...(Array.isArray(s.plugins) && s.plugins.length ? { PLUGINS: s.plugins.join("\n") } : {}),
    ...(s.worldUrl ? { WORLD: s.worldUrl } : {}),
    ...(s.extraEnv ?? {}),
  };
  return env;
}

function startServer() {
  if (child) return;
  status = "STARTING";
  const env = specToEnv(spec);
  if (DRIVER === "command") {
    const parts = (process.env.SERVER_CMD ?? "java -jar server.jar nogui").split(" ");
    child = spawn(parts[0], parts.slice(1), { env: { ...process.env, ...env } });
  } else {
    // itzg/minecraft-server: unprivileged, port-mapped, the owner's data volume. Hardening flags
    // (read-only root, cpu/mem caps, no host mounts) belong to the operator running this agent —
    // documented in the agent README.
    const args = ["run", "--rm", "-i", "--name", "lumina-mc", "-p", "25565:25565"];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push("itzg/minecraft-server");
    child = spawn("docker", args);
  }
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("exit", (code) => { log(`[agent] server exited (${code})`); child = null; status = "OFFLINE"; });
}

function stopServer() {
  if (!child) { status = "OFFLINE"; return; }
  status = "STOPPING";
  if (DRIVER === "docker") spawn("docker", ["stop", "lumina-mc"]);
  else child.kill("SIGTERM");
}

async function heartbeat() {
  try {
    const res = await fetch(`${LUMINA_URL}/api/sandbox/agent/heartbeat`, {
      method: "POST",
      headers: { authorization: `GameAgent ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        status,
        connectAddress: PUBLIC_ADDRESS ?? undefined,
        playerCount: 0, // a real build parses this from the server or RCON; left honest at 0 here
        maxPlayers: spec?.maxPlayers ?? 20,
        consoleTail: consoleRing.slice(-30).join("\n"),
      }),
    });
    if (!res.ok) { console.error(`[agent] heartbeat ${res.status}`); return; }
    const { command, spec: newSpec } = await res.json();
    if (newSpec) spec = newSpec;
    if (command === "start") startServer();
    else if (command === "stop") stopServer();
    else if (command === "restart") { stopServer(); setTimeout(startServer, 4000); }
  } catch (e) {
    console.error("[agent] heartbeat failed:", e.message);
  }
}

console.log(`[agent] Lumina Game Agent online → ${LUMINA_URL} (driver: ${DRIVER})`);
await heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
process.on("SIGINT", () => { stopServer(); process.exit(0); });
