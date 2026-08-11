// Verifies the cross-platform update machinery against the REAL deployment.
//
// Three platforms, three mechanisms, and the failure mode is the same for all of them: everything
// looks fine from the server side while every installed client silently refuses the update. So the
// assertions are about *agreement between two independently produced things* — the digest the API
// publishes vs. the bytes actually served, the version in the desktop feed vs. the file it names —
// rather than about any single endpoint returning 200.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sha = (algo, buf) => createHash(algo).update(buf).digest("hex");

async function main() {
  // ---- Android -------------------------------------------------------------------------
  const res = await fetch(`${BASE}/api/meta/version`);
  if (!res.ok) return bad(`/api/meta/version returned ${res.status}`);
  const manifest = await res.json();

  // Installed APKs in the wild read this exact key. If it ever moves, the clients that most need
  // to hear about an update are precisely the ones that stop being able to.
  if (typeof manifest.androidVersionCode === "number") {
    ok(`androidVersionCode is still top-level for older installed clients (${manifest.androidVersionCode})`);
  } else {
    bad("androidVersionCode is missing — every already-installed APK's update check breaks");
  }

  if (!manifest.android) {
    bad("no android release described; the in-app updater has nothing to download");
  } else {
    const { url, sizeBytes, sha256, versionCode } = manifest.android;

    if (versionCode === manifest.androidVersionCode) ok("the described build matches the published version code");
    else bad(`version code disagrees with itself: ${versionCode} vs ${manifest.androidVersionCode}`);

    const apkRes = await fetch(new URL(url, BASE));
    const apk = Buffer.from(await apkRes.arrayBuffer());

    if (apk.length === sizeBytes) ok(`the served APK is the advertised size (${sizeBytes} bytes)`);
    else bad(`APK is ${apk.length} bytes but the manifest says ${sizeBytes}`);

    // The assertion the whole Android path rests on. The plugin refuses to install anything whose
    // digest doesn't match this, so a mismatch here means no phone can ever update.
    const actual = sha("sha256", apk);
    if (actual === sha256) ok("the published sha256 matches the bytes actually served");
    else bad(`digest mismatch — clients would reject this update (served ${actual}, published ${sha256})`);

    // A ZIP local file header. Cheap proof we're serving an APK and not, say, an nginx error page
    // with a 200 on it.
    if (apk.subarray(0, 2).toString("latin1") === "PK") ok("the download is a real APK archive");
    else bad("the APK download does not start with a ZIP header");
  }

  // ---- Owner console APK ----------------------------------------------------------------
  // A separate applicationId with its own file and its own digest, riding the shared version
  // counter. The failure this section exists to catch is the app comparing itself against the
  // WRONG release: that produces either an update that never appears, or a download the OS refuses
  // to install because it belongs to a different package.
  if (!manifest.owner) {
    bad("the version manifest describes no owner build — the owner console can never self-update");
  } else {
    const ownerApk = Buffer.from(await (await fetch(new URL(manifest.owner.url, BASE))).arrayBuffer());

    if (sha("sha256", ownerApk) === manifest.owner.sha256) ok("the owner APK's published sha256 matches the bytes served");
    else bad("owner APK digest mismatch — the owner console would reject its own update");

    if (manifest.owner.sha256 !== manifest.android?.sha256) {
      ok("the owner and chat releases are distinct downloads");
    } else {
      bad("the owner release points at the chat APK — Android would refuse to install it");
    }

    // Two independently produced numbers: what the API advertises, and what Gradle actually stamped
    // into the APK being served. They are set in different files by different tools.
    try {
      const badging = execFileSync(`${process.env.HOME}/android-sdk/build-tools/34.0.0/aapt`, [
        "dump", "badging", path.join(REPO, "downloads/lumina-owner.apk"),
      ], { encoding: "utf8" });
      const pkg = /package: name='([^']+)' versionCode='(\d+)'/.exec(badging);
      if (pkg?.[1] === "com.luxffa.lumina.owner") ok(`the owner APK is the owner package (${pkg[1]})`);
      else bad(`the owner download is package ${pkg?.[1]}, not com.luxffa.lumina.owner`);

      if (Number(pkg?.[2]) === manifest.owner.versionCode) {
        ok(`the owner APK's stamped versionCode matches the manifest (${pkg?.[2]})`);
      } else {
        bad(`owner versionCode disagrees: APK says ${pkg?.[2]}, API advertises ${manifest.owner.versionCode}`);
      }

      if (badging.includes("REQUEST_INSTALL_PACKAGES") || /uses-permission.*REQUEST_INSTALL_PACKAGES/.test(
        execFileSync(`${process.env.HOME}/android-sdk/build-tools/34.0.0/aapt`, [
          "dump", "permissions", path.join(REPO, "downloads/lumina-owner.apk"),
        ], { encoding: "utf8" }),
      )) {
        ok("the owner APK declares REQUEST_INSTALL_PACKAGES");
      } else {
        bad("the owner APK cannot launch an installer — REQUEST_INSTALL_PACKAGES is missing");
      }
    } catch (e) {
      bad(`could not inspect the owner APK manifest: ${e.message}`);
    }

    // The plugin has to survive the Gradle build of a second, separate project. A registration that
    // silently didn't compile in is invisible until someone taps Update and gets "not implemented".
    try {
      const dexNames = execFileSync("unzip", ["-Z1", path.join(REPO, "downloads/lumina-owner.apk"), "classes*.dex"], {
        encoding: "utf8",
      }).trim().split("\n");
      const found = dexNames.some((dex) =>
        execFileSync("unzip", ["-p", path.join(REPO, "downloads/lumina-owner.apk"), dex], {
          maxBuffer: 64 * 1024 * 1024,
        }).includes("AppUpdaterPlugin"),
      );
      if (found) ok("the owner APK contains the AppUpdater plugin class");
      else bad("AppUpdaterPlugin is not in the owner APK — Update would reject with 'not implemented'");
    } catch (e) {
      bad(`could not inspect the owner APK classes: ${e.message}`);
    }

    // The bug this catches has no visible symptom: the Gradle versionCode is what Android enforces,
    // but VITE_APP_BUILD is what the running app believes about itself. If only the former moved,
    // every owner build would ship thinking it was version 1 and offer an update to itself forever.
    const envOwner = fs.readFileSync(path.join(REPO, "apps/frontend/.env.owner"), "utf8");
    const bundled = Number(/^VITE_APP_BUILD=(\d+)$/m.exec(envOwner)?.[1]);
    if (bundled === manifest.owner.versionCode) {
      ok(`the owner bundle knows its own version (${bundled}), so it won't offer an update to itself`);
    } else {
      bad(`owner bundle believes it is build ${bundled} but the published build is ${manifest.owner.versionCode}`);
    }
    if (/^VITE_APP_VARIANT=owner$/m.test(envOwner)) ok("the owner bundle is marked as the owner variant");
    else bad("VITE_APP_VARIANT is not set — the owner console would try to update itself with the chat APK");
  }

  // ---- Desktop (electron-updater generic feed) -----------------------------------------
  const feedRes = await fetch(`${BASE}/downloads/desktop/latest-linux.yml`, { cache: "no-store" });
  if (!feedRes.ok) {
    bad(`desktop update feed returned ${feedRes.status} — installed desktop clients see no updates`);
  } else {
    const yml = await feedRes.text();
    const version = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    const file = /^path:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    const sha512 = /^sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    const size = Number(/^\s+size:\s*(\d+)$/m.exec(yml)?.[1]);

    if (version && /^\d+\.\d+\.\d+$/.test(version)) ok(`desktop feed advertises semver ${version}`);
    else bad(`desktop feed version "${version}" is not semver; electron-updater cannot compare it`);

    // electron-builder's package.json version is bumped per deploy from the same counter as the
    // APK. If it ever stopped moving, the feed would stay valid and no client would ever update.
    const shipped = JSON.parse(fs.readFileSync(path.join(REPO, "apps/desktop/package.json"), "utf8")).version;
    if (shipped === version) ok(`the built desktop package version matches the feed (${shipped})`);
    else bad(`desktop package.json is ${shipped} but the feed advertises ${version}`);

    const localFile = path.join(REPO, "downloads/desktop", file ?? "");
    if (file && fs.existsSync(localFile)) {
      ok(`the feed names a build that is actually published (${file})`);

      const bytes = fs.readFileSync(localFile);
      const actual = createHash("sha512").update(bytes).digest("base64");
      if (actual === sha512) ok("the feed's sha512 matches the published AppImage");
      else bad("the feed's sha512 does not match the published AppImage — every client would reject it");

      // Checked over HTTP rather than on disk: this is what a client actually receives, and a
      // truncating proxy or a partially-copied file shows up here and nowhere else.
      const head = await fetch(`${BASE}/downloads/desktop/${file}`, { method: "HEAD" });
      const served = Number(head.headers.get("content-length"));
      if (served === size && size === bytes.length) ok(`the AppImage is served whole (${size} bytes)`);
      else bad(`size disagreement: feed ${size}, disk ${bytes.length}, served ${served}`);
    } else {
      bad(`the feed names ${file}, which is not in downloads/desktop`);
    }

    // The single highest-risk desktop misconfiguration: electron-builder embeds the publish block
    // as resources/app-update.yml inside the package, and without it autoUpdater throws
    // "provider not configured" on every check — silently, forever, in a build that otherwise
    // looks perfectly fine. Read out of the actual AppImage rather than off the yml source.
    try {
      const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "lumina-appimage-"));
      execFileSync(path.join(REPO, "downloads/desktop", file), ["--appimage-extract", "resources/app-update.yml"], {
        cwd: tmp,
        stdio: "ignore",
      });
      const embedded = fs.readFileSync(path.join(tmp, "squashfs-root/resources/app-update.yml"), "utf8");
      fs.rmSync(tmp, { recursive: true, force: true });
      if (embedded.includes("provider: generic") && embedded.includes("/downloads/desktop")) {
        ok("the packaged AppImage carries its update feed configuration");
      } else {
        bad(`the packaged app-update.yml does not point at the feed:\n${embedded}`);
      }
    } catch (e) {
      bad(`could not read app-update.yml out of the AppImage: ${e.message}`);
    }

    // The feed file is overwritten in place on every deploy. If the edge caches it, clients keep
    // being told about a version that is no longer the newest — which is indistinguishable from
    // the updater being broken.
    const cc = feedRes.headers.get("cache-control") ?? "";
    if (/no-store|no-cache/.test(cc)) ok(`the update feed is not edge-cached (${cc})`);
    else bad(`the update feed is cacheable ("${cc}") and can pin clients to an old version`);
  }

  // ---- Web ------------------------------------------------------------------------------
  // The web check compares the entry script the tab loaded against the one the current index.html
  // names, so it only works if that filename is content-fingerprinted at all.
  const indexRes = await fetch(`${BASE}/index.html`, { cache: "no-store" });
  const html = await indexRes.text();
  const entry = /<script[^>]*\stype="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
  if (entry && /-[A-Za-z0-9_-]{8,}\.js$/.test(entry)) {
    ok(`the web entry script is content-hashed, so staleness is detectable (${entry})`);
  } else {
    bad(`no fingerprinted module entry found in index.html (got ${entry ?? "nothing"})`);
  }

  const idxCc = indexRes.headers.get("cache-control") ?? "";
  if (!/max-age=[1-9]/.test(idxCc) || /no-cache|no-store|must-revalidate/.test(idxCc)) {
    ok(`index.html is revalidated rather than pinned (${idxCc || "no cache-control"})`);
  } else {
    bad(`index.html is cached with "${idxCc}"; a stale tab would never see the new build`);
  }

  // ---- The installed APK really carries the updater ---------------------------------------
  // Compiled artefacts, not source: the permission and the plugin class have to survive the
  // Gradle build, and a plugin that fails to register is invisible until someone taps Update.
  try {
    const perms = execFileSync(
      `${process.env.HOME}/android-sdk/build-tools/34.0.0/aapt`,
      ["dump", "permissions", path.join(REPO, "downloads/lumina.apk")],
      { encoding: "utf8" },
    );
    if (perms.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
      ok("the published APK declares REQUEST_INSTALL_PACKAGES");
    } else {
      bad("the published APK cannot launch an installer — REQUEST_INSTALL_PACKAGES is missing");
    }
  } catch (e) {
    bad(`could not inspect the APK manifest: ${e.message}`);
  }

  try {
    const dexNames = execFileSync("unzip", ["-Z1", path.join(REPO, "downloads/lumina.apk"), "classes*.dex"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const found = dexNames.some((dex) => {
      const buf = execFileSync("unzip", ["-p", path.join(REPO, "downloads/lumina.apk"), dex], {
        maxBuffer: 64 * 1024 * 1024,
      });
      return buf.includes("AppUpdaterPlugin");
    });
    if (found) ok("the published APK contains the AppUpdater plugin class");
    else bad("AppUpdaterPlugin is not in the published APK — Update would reject with 'not implemented'");
  } catch (e) {
    bad(`could not inspect the APK classes: ${e.message}`);
  }

  // ---- distribution: the right thing from the right place ---------------------------------
  //
  // Downloads are split by whether a filename can change meaning, so the two halves need
  // DIFFERENT assertions — and the mutable half needs the stronger one.
  //
  // A stable name is overwritten every deploy, so the only question that matters is "is what a
  // client receives the build we actually just made?" That is a comparison against the file on
  // disk, not against the bucket. This exact check is what caught Cloudflare serving a cached
  // previous build while every status code said 200.
  for (const [urlPath, localPath] of [
    ["/downloads/lumina.apk", "downloads/lumina.apk"],
    ["/downloads/lumina-owner.apk", "downloads/lumina-owner.apk"],
    ["/downloads/desktop/latest-linux.yml", "downloads/desktop/latest-linux.yml"],
  ]) {
    try {
      const served = Buffer.from(await (await fetch(`${BASE}${urlPath}`)).arrayBuffer());
      const onDisk = fs.readFileSync(path.join(REPO, localPath));
      if (sha("sha256", served) === sha("sha256", onDisk)) {
        ok(`${urlPath} serves the build that was actually just made`);
      } else {
        bad(`${urlPath} is STALE — clients are getting an older build than the one on disk`);
      }
    } catch (e) {
      bad(`${urlPath}: ${e.message}`);
    }
  }

  // An immutable name can never go stale, so here the question is the opposite one: does the
  // origin faithfully proxy the bucket? A byte difference would mean the CDN path is corrupting
  // or truncating what it relays.
  const desktopFile = /^path:\s*(.+)$/m.exec(
    await (await fetch(`${BASE}/downloads/desktop/latest-linux.yml`)).text(),
  )?.[1]?.trim();
  if (desktopFile) {
    try {
      const [viaOrigin, viaBucket] = await Promise.all([
        fetch(`${BASE}/downloads/desktop/${desktopFile}`).then((r) => r.arrayBuffer()),
        fetch(`https://dl.badgerstudios.net/desktop/${desktopFile}`).then((r) => r.arrayBuffer()),
      ]);
      if (sha("sha256", Buffer.from(viaOrigin)) === sha("sha256", Buffer.from(viaBucket))) {
        ok(`${desktopFile} is byte-identical through the origin and straight from the bucket`);
      } else {
        bad(`${desktopFile} differs between the origin proxy and the bucket`);
      }
    } catch (e) {
      bad(`${desktopFile}: ${e.message}`);
    }
  }

  // The bucket holding releases is public by design. The bucket holding backups must not be, and
  // they are different buckets precisely so that sentence can be true.
  const leak = await fetch("https://dl.badgerstudios.net/backups/db-20260811-083401.sql.gz");
  if (leak.status !== 200) ok(`the backups path is not served from the public release host (${leak.status})`);
  else bad("a database backup is downloadable from the public release host");

  await verifyBroadcastReachesAClient();
  await verifyWebBannerInBrowser();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * Proves the deploy-time announcement actually lands in a connected client.
 *
 * Everything else about this path was previously "verified" by watching deploy.sh print
 * `{"notified":0}` — which is exactly what a completely broken broadcast prints too. Zero
 * connected sockets means the assertion was on the response body of the route rather than on
 * anyone receiving anything, and those are not the same claim. So this connects a real socket.io
 * client and waits for the event on the wire.
 *
 * Talks to 127.0.0.1:4000 rather than the public host because that is where deploy.sh calls from,
 * and the shared secret should never leave the box.
 */
async function verifyBroadcastReachesAClient() {
  const LOCAL = "http://127.0.0.1:4000";
  const secret = /^OPS_AGENT_SECRET=(.+)$/m.exec(fs.readFileSync(path.join(REPO, ".env"), "utf8"))?.[1]?.trim();
  if (!secret) return bad("OPS_AGENT_SECRET is unset — deploy.sh cannot announce updates at all");

  const { io } = await import("socket.io-client");
  const username = `vbc_${Date.now()}`;
  let socket;

  try {
    const reg = await fetch(`${LOCAL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        password: "verify-broadcast-pw-1",
        ageBracket: "AGE_25_34",
        birthDate: "1995-04-01",
      }),
    });
    const { accessToken } = await reg.json();
    if (!accessToken) return bad(`could not register a client to receive the broadcast (${reg.status})`);

    socket = io(LOCAL, { auth: { accessToken }, transports: ["websocket"], reconnection: false });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("socket never connected")), 10000);
      socket.on("connect", () => (clearTimeout(t), resolve()));
      socket.on("connect_error", (e) => (clearTimeout(t), reject(e)));
    });

    const received = new Promise((resolve) => socket.once("app:update-available", resolve));

    // The adversarial half first: a wrong secret must not reach the client. Asserting only that
    // the right secret works would pass just as happily against a route with no auth on it.
    const forged = await fetch(`${LOCAL}/api/meta/announce-update`, {
      method: "POST",
      headers: { "x-lumina-agent-secret": "not-the-secret" },
    });
    if (forged.status === 403) ok("a forged agent secret is refused (403)");
    else bad(`a forged agent secret returned ${forged.status} — anyone could nudge every client`);

    const res = await fetch(`${LOCAL}/api/meta/announce-update`, {
      method: "POST",
      headers: { "x-lumina-agent-secret": secret },
    });
    const body = await res.json();
    if (body.notified >= 1) ok(`the announcement reports reaching ${body.notified} connected socket(s)`);
    else bad(`announce-update reported notified=${body.notified} with a client demonstrably connected`);

    const payload = await Promise.race([
      received,
      new Promise((_, r) => setTimeout(() => r(new Error("no app:update-available within 10s")), 10000)),
    ]);
    ok("a connected client actually receives app:update-available over the wire");

    // The payload carries no version numbers on purpose — it means "re-run your own check", so
    // each platform uses the logic it already has rather than trusting a number the server
    // asserted about a platform it isn't running on. A version field appearing here would mean
    // someone reintroduced that coupling.
    if (payload && typeof payload === "object" && !("version" in payload) && !("versionCode" in payload)) {
      ok("the broadcast stays a nudge and does not carry a version the client would trust");
    } else {
      bad(`the broadcast payload carries version data: ${JSON.stringify(payload)}`);
    }
  } catch (e) {
    bad(`update broadcast: ${e.message?.split("\n")[0] ?? e}`);
  } finally {
    socket?.close();
    try {
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc",
          `delete from "User" where username = '${username}';`],
        { cwd: REPO, stdio: "ignore" },
      );
    } catch {
      /* the throwaway account is harmless if cleanup fails; not worth failing the run over */
    }
  }
}

/**
 * Drives the web staleness path in a real browser.
 *
 * Everything above proves the *inputs* are correct; this proves the app does something with them.
 * The trick is to serve the running tab a doctored /index.html naming a different entry chunk —
 * exactly what a mid-session deploy looks like from inside the page — and assert the banner
 * appears. Only the explicit `fetch("/index.html")` the hook makes is intercepted; the SPA
 * navigation itself resolves through a different path, so the app still boots normally.
 */
async function verifyWebBannerInBrowser() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const username = `vup_${Date.now()}`;

  try {
    const real = await (await fetch(`${BASE}/index.html`, { cache: "no-store" })).text();
    const stale = real.replace(/(<script[^>]*\ssrc=")([^"]+?)(-)([A-Za-z0-9_-]{8,})(\.js")/, "$1$2$3deadbeef$5");
    if (stale === real) {
      bad("could not build a doctored index.html — the entry script pattern changed");
      return;
    }

    await page.route("**/index.html", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: stale }),
    );

    await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Email").fill(`${username}@example.com`);
    await page.getByLabel("Password").fill("verify-updates-pw-1");
    await page.getByLabel("Date of birth").fill("1995-04-01");
    await page.getByRole("button", { name: "25–34" }).click();
    await page.getByRole("button", { name: "Register" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 20000 });

    const banner = page.getByText("Lumina has been updated. Reload to get the new version.");
    await banner.waitFor({ state: "visible", timeout: 20000 });
    ok("a tab running a superseded bundle is told to reload");

    const reload = page.getByRole("button", { name: "Reload" });
    if (await reload.isVisible()) ok("the reload action is offered");
    else bad("the update banner rendered without a way to act on it");
  } catch (e) {
    bad(`web update banner: ${e.message?.split("\n")[0] ?? e}`);
  } finally {
    await browser.close();
    try {
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc",
          `delete from "User" where username = '${username}';`],
        { cwd: REPO },
      );
    } catch {
      /* nothing to clean up */
    }
  }
}

main();
