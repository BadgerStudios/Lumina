// End-to-end verification of the video upload path against the REAL deployment.
//
// Written after an upload that produced NOTHING: no video row, no request in the backend log, and
// no message on screen. The cause was the local metadata probe never settling for a file the
// browser could not decode, which left the modal permanently inert. So the assertions here are
// deliberately about the paths that FAIL, not just the happy one — an upload flow that can go
// silent is worse than one that errors.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-upload-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m, e) => (console.log(`FAIL: ${m}${e ? " -- " + e : ""}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: "/home/lucid/lumina",
    encoding: "utf8",
  }).trim();

// A real, tiny H.264 clip built with the same ffmpeg the worker uses, plus a file that is
// definitely not decodable — the case that used to hang the modal forever.
const GOOD = "/tmp/verify-upload-good.mp4";
const UNDECODABLE = "/tmp/verify-upload-broken.mp4";

function makeFixtures() {
  execFileSync("docker", [
    "compose", "exec", "-T", "worker", "ffmpeg", "-y", "-f", "lavfi",
    "-i", "testsrc=size=360x640:rate=15:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "/tmp/out.mp4",
  ], { cwd: "/home/lucid/lumina", stdio: "ignore" });
  execFileSync("bash", ["-c",
    `cd /home/lucid/lumina && docker compose cp worker:/tmp/out.mp4 ${GOOD}`], { stdio: "ignore" });
  // Valid .mp4 name, contents no decoder will accept.
  writeFileSync(UNDECODABLE, Buffer.from("not a video, just bytes pretending to be one".repeat(64)));
}

async function register(username) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username, email: `${username}@example.com`, password: PASSWORD,
      ageBracket: "AGE_25_34", birthDate: "1995-04-01",
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
}

async function main() {
  makeFixtures();
  const user = `vup_${rand}`;
  await register(user);
  // The feed is adults-only and enforced server-side; registration already records the age.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => bad("uncaught page error", String(e)));

  try {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.getByLabel(/email or username/i).fill(user);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^(sign in|log in)$/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

    await page.goto(`${BASE}/foryou`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /upload a video/i }).click();
    await page.getByRole("heading", { name: /upload a video/i }).waitFor({ timeout: 8000 });
    ok("upload modal opens");

    // --- The regression case: a file no browser can decode -------------------------------
    await page.setInputFiles('input[type="file"]', UNDECODABLE);
    // Must resolve within the probe timeout and leave the form USABLE, not frozen.
    await page.waitForTimeout(12000);
    const stillChecking = await page.getByText(/reading video/i).isVisible().catch(() => false);
    if (!stillChecking) ok("an undecodable file does not leave the picker stuck on 'Reading video…'");
    else bad("picker is still stuck reading the file after the probe timeout");

    const submit = page.getByRole("button", { name: /^upload$/i }).last();
    if (await submit.isEnabled()) ok("an undecodable file is still accepted for upload (server decides)");
    else bad("upload button stayed disabled — the client refused a file the server should judge");

    // The server cannot know a file is undecodable until ffprobe runs in the worker, so the
    // correct behaviour is: accept it, then fail it with a reason the uploader can read. Anything
    // that leaves the upload in limbo is the bug — a video must never just vanish.
    await submit.click();
    const settled = await Promise.race([
      page.getByText(/being processed|uploaded/i).waitFor({ timeout: 40000 }).then(() => "accepted"),
      page.locator("p.text-flare").first().waitFor({ timeout: 40000 }).then(() => "rejected"),
    ]).catch(() => "silent");
    if (settled === "silent") {
      bad("a corrupt upload neither succeeded nor reported an error — it went silent");
    } else {
      ok(`a corrupt upload settles visibly (${settled})`);
    }

    if (settled === "accepted") {
      let corruptStatus = "";
      for (let i = 0; i < 40; i++) {
        corruptStatus = sql(
          `select v.status from "Video" v join "User" u on u.id = v."authorId"
           where u.username = '${user}' order by v.id desc limit 1;`,
        );
        if (corruptStatus && corruptStatus !== "PROCESSING") break;
        await page.waitForTimeout(2000);
      }
      const reason = sql(
        `select coalesce(v."failureReason",'') from "Video" v join "User" u on u.id = v."authorId"
         where u.username = '${user}' order by v.id desc limit 1;`,
      );
      if (corruptStatus === "FAILED" && reason) {
        ok(`the worker marks an undecodable file FAILED with a reason ("${reason.slice(0, 60)}")`);
      } else {
        bad(`undecodable file ended as ${corruptStatus || "(none)"} with reason "${reason}"`);
      }
    }

    // --- The happy path ------------------------------------------------------------------
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /upload a video/i }).click();
    await page.getByRole("heading", { name: /upload a video/i }).waitFor({ timeout: 8000 });
    await page.setInputFiles('input[type="file"]', GOOD);
    await page.waitForTimeout(3000);
    await page.getByPlaceholder(/caption/i).fill(`verify upload ${rand}`);
    await page.getByRole("button", { name: /^upload$/i }).last().click();

    await page.getByText(/being processed|uploaded/i).waitFor({ timeout: 45000 });
    ok("a valid upload reports success in the UI");

    // Asserted against the database, not the UI's optimism.
    const row = sql(
      `select v.id||' '||v.status from "Video" v join "User" u on u.id = v."authorId"
       where u.username = '${user}' order by v.id desc limit 1;`,
    );
    if (row) ok(`a Video row exists after upload (${row})`);
    else bad("no Video row was created despite the UI reporting success");

    // The worker must actually pick it up and move it off PROCESSING.
    let status = "";
    for (let i = 0; i < 30; i++) {
      status = sql(
        `select v.status from "Video" v join "User" u on u.id = v."authorId"
         where u.username = '${user}' order by v.id desc limit 1;`,
      );
      if (status && status !== "PROCESSING") break;
      await page.waitForTimeout(2000);
    }
    if (status === "PENDING_REVIEW") ok("the worker transcoded it to PENDING_REVIEW");
    else bad(`video ended in status ${status || "(none)"} rather than PENDING_REVIEW`);
  } catch (e) {
    bad("upload flow", String(e));
    await page.screenshot({ path: "/tmp/verify-upload-failure.png", fullPage: true }).catch(() => {});
    console.log("screenshot: /tmp/verify-upload-failure.png");
  } finally {
    await browser.close();
    sql(`delete from "User" where username = '${user}';`);
    console.log(`cleaned up ${user}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
