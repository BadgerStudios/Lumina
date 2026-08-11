// Verifies Lumina Control against the REAL deployment and the REAL host agent.
//
// The design claim being tested is narrow: the app can *see* infrastructure and can ask for a short
// list of actions, and nothing else — no inbound path to Docker, no arbitrary command, no access
// for anyone who isn't an owner. So most of these assertions are about what is refused. The one
// end-to-end assertion actually restarts a service and waits for the agent to report back, because
// "the row said QUEUED" proves nothing about whether anything happened.
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
const rand = Date.now();
const PASSWORD = "verify-ops-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();

async function mkUser(username) {
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username, email: `${username}@example.com`, password: PASSWORD,
      ageBracket: "AGE_25_34", birthDate: "1995-04-01",
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  return login(username);
}

async function login(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrUsername: username, password: PASSWORD }),
  });
  return (await res.json()).accessToken;
}

const authed = (token, path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

async function main() {
  const plain = `vops_user_${rand}`;
  const owner = `vops_owner_${rand}`;

  try {
    const plainToken = await mkUser(plain);
    await mkUser(owner);
    // Privileges granted by SQL after a normal signup — never by editing .env, which would also
    // change who is an owner on the live site.
    sql(`update "User" set "platformRole" = 'OWNER' where username = '${owner}';`);
    const ownerToken = await login(owner);

    // ---- the agent path is not reachable without the secret -----------------------------------
    const noSecret = await fetch(`${BASE}/api/ops/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "spoof", agentVersion: "0", reportedAt: new Date().toISOString(), host: {}, containers: [] }),
    });
    if (noSecret.status === 403) ok("an unauthenticated report is refused (403)");
    else bad(`reporting with no secret returned ${noSecret.status}`);

    const wrongSecret = await fetch(`${BASE}/api/ops/report`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lumina-agent-secret": "x".repeat(64) },
      body: JSON.stringify({ agentId: "spoof", agentVersion: "0", reportedAt: new Date().toISOString(), host: {}, containers: [] }),
    });
    if (wrongSecret.status === 403) ok("a wrong agent secret is refused (403)");
    else bad(`reporting with a wrong secret returned ${wrongSecret.status}`);

    // ---- the dashboard is owner-only ----------------------------------------------------------
    const asUser = await authed(plainToken, "/api/ops/status");
    if (asUser.status === 403) ok("a normal account cannot read infrastructure status (403)");
    else bad(`a normal account got ${asUser.status} from /api/ops/status`);

    const userCommand = await authed(plainToken, "/api/ops/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restart", target: "backend" }),
    });
    if (userCommand.status === 403) ok("a normal account cannot queue an action (403)");
    else bad(`a normal account got ${userCommand.status} when queueing an action`);

    // ---- the agent is actually alive ----------------------------------------------------------
    const statusRes = await authed(ownerToken, "/api/ops/status");
    if (!statusRes.ok) return bad(`/api/ops/status returned ${statusRes.status} to an owner`);
    const status = await statusRes.json();

    if (status.agentOnline) ok(`the host agent is reporting (last seen ${status.lastSeenAt})`);
    else return bad(`the agent is not reporting — lastSeenAt=${status.lastSeenAt}`);

    const services = (status.snapshot?.containers ?? []).map((c) => c.service);
    for (const expected of ["backend", "postgres", "redis", "worker", "frontend"]) {
      if (services.includes(expected)) ok(`${expected} is visible to Lumina Control`);
      else bad(`${expected} is missing from the snapshot (saw: ${services.join(", ") || "nothing"})`);
    }

    const host = status.snapshot?.host;
    if (host?.memTotalBytes > 0 && host?.cpuCount > 0 && host?.diskTotalBytes > 0) {
      ok(`host metrics are populated (${host.cpuCount} cores, ${(host.memTotalBytes / 1024 ** 3).toFixed(1)}GB)`);
    } else {
      bad(`host metrics look empty: ${JSON.stringify(host)}`);
    }

    // MemAvailable, not MemFree — on a healthy Linux box free memory is near zero because the page
    // cache holds the rest, and reporting that would show a permanent false alarm.
    if (host.memAvailableBytes > 0 && host.memAvailableBytes <= host.memTotalBytes) {
      ok(`available memory is reported sanely (${(host.memAvailableBytes / 1024 ** 3).toFixed(1)}GB free)`);
    } else {
      bad(`available memory is ${host.memAvailableBytes} against a total of ${host.memTotalBytes}`);
    }

    // ---- the allowlist is a real boundary ------------------------------------------------------
    for (const body of [
      { action: "exec", target: "backend" },
      { action: "restart", target: "postgres" },
      { action: "restart", target: "../../etc" },
      { action: "rm", target: "backend" },
    ]) {
      const res = await authed(ownerToken, "/api/ops/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 400) ok(`refused off-list request: ${body.action} ${body.target}`);
      else bad(`${body.action} ${body.target} returned ${res.status} instead of 400`);
    }

    // ---- and the permitted one actually happens ------------------------------------------------
    // `worker` on purpose: it is the transcode consumer, so a restart costs a queued job a few
    // seconds and no live user anything. Restarting `backend` mid-test would break this script's
    // own connection, which would prove very little.
    const before = sql(`select count(*) from "StaffAuditLog" where "actionType" = 'ops.command';`);
    const queued = await authed(ownerToken, "/api/ops/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restart", target: "worker" }),
    });
    if (queued.status !== 202) return bad(`queueing a permitted action returned ${queued.status}`);
    const { id } = await queued.json();
    ok("a permitted action is accepted as queued (202, not 200 — it hasn't run yet)");

    const after = sql(`select count(*) from "StaffAuditLog" where "actionType" = 'ops.command';`);
    if (Number(after) === Number(before) + 1) ok("the action is written to the staff audit log");
    else bad(`audit log went ${before} -> ${after}`);

    // The agent cycles every 30s, so allow two cycles plus the restart itself.
    const deadline = Date.now() + 120_000;
    let final = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await (await authed(ownerToken, "/api/ops/status")).json();
      const found = s.commands.find((c) => c.id === id);
      if (found && ["SUCCEEDED", "FAILED", "EXPIRED"].includes(found.status)) {
        final = found;
        break;
      }
    }
    if (final?.status === "SUCCEEDED") ok("the host agent picked up the action and carried it out");
    else bad(`the action ended as ${final?.status ?? "still pending"}: ${final?.result ?? ""}`);

    // The point of restarting was to prove the loop closes, so confirm the service came back.
    const post = await (await authed(ownerToken, "/api/ops/status")).json();
    const worker = post.snapshot.containers.find((c) => c.service === "worker");
    if (worker?.state === "running") ok("the restarted service is running again");
    else bad(`worker is ${worker?.state ?? "missing"} after the restart`);

    // ---- history --------------------------------------------------------------------------------
    const history = await (await authed(ownerToken, "/api/ops/history?hours=6")).json();
    if (Array.isArray(history.points) && history.points.length > 0) {
      ok(`history returns a series (${history.points.length} points over ${history.windowHours}h)`);
    } else {
      bad("history returned no points");
    }
  } catch (e) {
    bad(`ops flow: ${String(e).split("\n")[0]}`);
  } finally {
    sql(`delete from "User" where username in ('${plain}', '${owner}');`);
    console.log(`cleaned up ${plain}, ${owner}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
