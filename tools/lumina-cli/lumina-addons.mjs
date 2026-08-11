#!/usr/bin/env node
// Lumina addon CLI.
//
//   lumina-addons validate ./addon.json
//   lumina-addons publish  ./addon.json --client-id <id> --client-secret <secret>
//   lumina-addons list     [query]
//
// Credentials come from LUMINA_CLIENT_ID / LUMINA_CLIENT_SECRET if the flags are omitted, so a
// secret never has to appear in shell history or a CI log. --client-secret accepts either the
// application's OAuth client secret or its bot token; an addon that only reacts to keywords has
// no reason to set up OAuth just to publish.
//
// What this publishes is a MANIFEST, not code. That is the point: a CLI that could deploy
// executable plugins to a server is remote code execution with a nicer name. The server validates
// every manifest against a fixed vocabulary of triggers and actions before storing it, so the worst
// a malicious publish can do is describe an automation the server was already willing to run.

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.LUMINA_API_BASE ?? "https://lumina.badgerstudios.net";
const args = process.argv.slice(2);
const command = args[0];

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function readManifest(file) {
  if (!file) die("Which manifest? e.g. lumina-addons publish ./addon.json");
  const full = path.resolve(file);
  if (!fs.existsSync(full)) die(`No such file: ${full}`);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    die(`${file} is not valid JSON: ${e.message}`);
  }
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Local shape check so obvious mistakes are caught without a round trip. The server's schema is
 * the authority — this deliberately does not try to reimplement it, only to catch the typos. */
function validate(manifest) {
  const problems = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.slug ?? "")) problems.push("slug must be lowercase-with-hyphens");
  if (!manifest.name) problems.push("name is required");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) problems.push("version must be semver, e.g. 1.0.0");
  if (!Array.isArray(manifest.automations) || manifest.automations.length === 0) {
    problems.push("at least one automation is required");
  }
  for (const [i, a] of (manifest.automations ?? []).entries()) {
    if (!a.name) problems.push(`automations[${i}].name is required`);
    if (a.on !== "message.create") problems.push(`automations[${i}].on must be "message.create"`);
    if (!Array.isArray(a.then) || a.then.length === 0) problems.push(`automations[${i}].then needs an action`);
  }
  return problems;
}

async function main() {
  if (command === "validate") {
    const manifest = readManifest(args[1]);
    const problems = validate(manifest);
    if (problems.length === 0) {
      console.log(`ok: ${manifest.slug} v${manifest.version}, ${manifest.automations.length} automation(s)`);
      return;
    }
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (command === "publish") {
    const manifest = readManifest(args[1]);
    const problems = validate(manifest);
    if (problems.length > 0) {
      console.error("manifest has problems:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    const clientId = flag("client-id", process.env.LUMINA_CLIENT_ID);
    const clientSecret = flag("client-secret", process.env.LUMINA_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      die("need --client-id and --client-secret (or LUMINA_CLIENT_ID / LUMINA_CLIENT_SECRET)");
    }

    const res = await fetch(`${BASE}/api/addons/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret, manifest }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) die(body.error ?? `publish failed (${res.status})`);

    console.log(`published ${body.slug} v${body.version}`);
    console.log(`  install it from any server's settings, or:`);
    console.log(`  POST ${BASE}/api/servers/<serverId>/addons  {"slug":"${body.slug}"}`);
    return;
  }

  if (command === "list") {
    const q = args[1] ? `?q=${encodeURIComponent(args[1])}` : "";
    const res = await fetch(`${BASE}/api/addons${q}`);
    const addons = await res.json();
    if (addons.length === 0) {
      console.log("no addons published yet");
      return;
    }
    for (const a of addons) {
      console.log(`${a.slug.padEnd(28)} v${a.version.padEnd(8)} ${a.name}`);
      if (a.description) console.log(`  ${a.description}`);
    }
    return;
  }

  console.log(`lumina-addons — publish declarative addons to Lumina

  validate <file>    check a manifest without publishing
  publish  <file>    publish it (needs an application's client id + secret)
  list     [query]   what's published

Manifest example:

{
  "slug": "welcome-wagon",
  "name": "Welcome Wagon",
  "description": "Waves at anyone saying hello",
  "version": "1.0.0",
  "automations": [
    {
      "name": "Wave back",
      "on": "message.create",
      "when": { "contains": ["hello", "hi there"] },
      "then": [{ "type": "react", "emoji": "👋" }]
    }
  ]
}

Conditions: contains, startsWith, inChannels, minLength, maxLength
Actions:    react, pin, delete, reply   (reply needs the application to have a bot user)`);
}

main().catch((e) => die(e.message));
