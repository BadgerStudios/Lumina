// Verifies smart-fit profile image processing against the REAL deployment.
//
// The interesting assertion is the last one. It is easy to write a test that proves an image was
// resized and prove nothing at all about *where* it was cropped — a centre crop and an attention
// crop both produce a 512x512 WebP. So the fixture is built so the two answers are visibly
// different: a wide grey strip whose only detail sits in the left third. A centre crop returns
// flat grey; an attention crop returns the detail. Anything that isn't actually doing smart
// cropping fails on colour, not on dimensions.
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-imagefit-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m, e) => (console.log(`FAIL: ${m}${e ? " -- " + e : ""}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: "/home/lucid/lumina",
    encoding: "utf8",
  }).trim();

/** True when the file a URL points at still exists in the backend container. */
const onDisk = (url) => {
  const m = /^\/(avatars|banners)\/([^/]+)$/.exec(url ?? "");
  if (!m) return false;
  try {
    execFileSync("docker", ["compose", "exec", "-T", "backend", "test", "-f", `/data/uploads/${m[1]}/${m[2]}`], {
      cwd: "/home/lucid/lumina",
    });
    return true;
  } catch {
    return false;
  }
};

/** Removes exactly the files this script caused to be written — by name, never by glob. */
const rmUpload = (url) => {
  const m = /^\/(avatars|banners)\/([^/]+)$/.exec(url ?? "");
  if (!m) return;
  try {
    execFileSync("docker", ["compose", "exec", "-T", "backend", "rm", "-f", `/data/uploads/${m[1]}/${m[2]}`], {
      cwd: "/home/lucid/lumina",
    });
  } catch {
    /* already gone */
  }
};

async function mkUser(username) {
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      password: PASSWORD,
      ageBracket: "AGE_25_34",
      birthDate: "1995-04-01",
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrUsername: username, password: PASSWORD }),
  });
  return (await res.json()).accessToken;
}

async function upload(token, path, buffer, filename, type) {
  const form = new FormData();
  form.set("file", new Blob([buffer], { type }), filename);
  const res = await fetch(`${BASE}/api/users/me/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * A 1200x400 strip: flat grey everywhere except a high-contrast checkerboard in the LEFT third.
 * The subject is deliberately nowhere near the centre.
 */
async function offCentreSubject() {
  const W = 1200,
    H = 400,
    CELL = 25;
  const px = Buffer.alloc(W * H * 3, 128);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 360; x++) {
      const light = (Math.floor(x / CELL) + Math.floor(y / CELL)) % 2 === 0;
      const i = (y * W + x) * 3;
      px[i] = light ? 250 : 10;
      px[i + 1] = light ? 40 : 10;
      px[i + 2] = light ? 40 : 10;
    }
  }
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** Mean red channel, used to tell "cropped onto the checkerboard" from "cropped onto flat grey". */
async function meanRed(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) total += data[i];
  return total / (data.length / info.channels);
}

async function main() {
  const username = `vif_${rand}`;
  const written = [];

  try {
    const token = await mkUser(username);

    // --- 1. A tall portrait becomes a square avatar ---------------------------------------
    // Deliberately narrower than the 512px avatar target, so this also pins the no-upscaling
    // rule: a small source must stay its own size rather than being blown up to 512 and served
    // as a blurry file several times the weight.
    const portrait = await sharp({
      create: { width: 400, height: 1200, channels: 3, background: { r: 40, g: 90, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const av = await upload(token, "avatar", portrait, "portrait.jpg", "image/jpeg");
    if (av.status !== 200) return bad(`avatar upload failed: ${av.status} ${JSON.stringify(av.body)}`);
    written.push(av.body.avatarUrl);

    if (av.body.avatarUrl.endsWith(".webp")) ok("avatar is re-encoded to .webp");
    else bad(`avatar kept its original container: ${av.body.avatarUrl}`);

    const avRes = await fetch(`${BASE}${av.body.avatarUrl}`);
    const avBuf = Buffer.from(await avRes.arrayBuffer());
    const avMeta = await sharp(avBuf).metadata();
    if (avMeta.width === avMeta.height && avMeta.width === 400) {
      ok(`400x1200 portrait cropped to a ${avMeta.width}x${avMeta.height} square, not upscaled`);
    } else {
      bad(`avatar is ${avMeta.width}x${avMeta.height}; expected a 400x400 square`);
    }

    if (avRes.headers.get("content-type")?.includes("image/webp")) ok("avatar is served as image/webp");
    else bad(`avatar content-type was ${avRes.headers.get("content-type")}`);

    const cc = avRes.headers.get("cache-control") ?? "";
    if (cc.includes("immutable")) ok(`avatar is cacheable: ${cc}`);
    else bad(`avatar has no immutable cache header (got "${cc}")`);

    // --- 2. EXIF is not republished -------------------------------------------------------
    // Uploading a holiday photo should not publish where it was taken.
    const withExif = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 200, g: 200, b: 40 } },
    })
      .withExif({ IFD0: { Copyright: "verify-image-fit", Artist: "verify-image-fit" } })
      .jpeg()
      .toBuffer();
    const exifUp = await upload(token, "avatar", withExif, "exif.jpg", "image/jpeg");
    written.push(exifUp.body?.avatarUrl);
    const exifOut = Buffer.from(await (await fetch(`${BASE}${exifUp.body.avatarUrl}`)).arrayBuffer());
    const exifMeta = await sharp(exifOut).metadata();
    if (!exifMeta.exif) ok("EXIF metadata is stripped from the stored image");
    else bad("the uploaded image's EXIF block survived re-encoding");

    // --- 3. The previous file is cleaned up -----------------------------------------------
    // Asserted against the container's filesystem rather than by re-fetching the URL. These
    // responses carry `immutable`, so Cloudflare will happily keep serving a 200 for a path
    // whose bytes no longer exist at the origin — re-fetching would test the CDN, not the app.
    if (!onDisk(av.body.avatarUrl)) ok("the replaced avatar file is deleted from disk");
    else bad("the replaced avatar file is still on disk — disk leaks on every change");

    // --- 4. An SVG can never land on disk as an SVG ---------------------------------------
    // /avatars/* is proxied on the app's own origin, so a stored SVG would execute its scripts
    // in that origin when opened directly.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
        `<rect width="400" height="400" fill="#3b82f6"/><script>alert(1)</script></svg>`,
    );
    const svgUp = await upload(token, "avatar", svg, "x.svg", "image/svg+xml");
    if (svgUp.status === 200) {
      written.push(svgUp.body.avatarUrl);
      const svgRes = await fetch(`${BASE}${svgUp.body.avatarUrl}`);
      const ct = svgRes.headers.get("content-type") ?? "";
      if (!svgUp.body.avatarUrl.endsWith(".svg") && !ct.includes("svg")) {
        ok(`an uploaded SVG is rasterised (served as ${ct})`);
      } else {
        bad(`an SVG is still stored/served as SVG on the app origin: ${svgUp.body.avatarUrl} (${ct})`);
      }
    } else if (svgUp.status === 400) {
      ok("an uploaded SVG is rejected outright");
    } else {
      bad(`unexpected status for an SVG upload: ${svgUp.status}`);
    }

    // --- 5. A file that isn't an image is refused, not written -----------------------------
    const junk = await upload(token, "avatar", Buffer.from("not an image at all"), "a.png", "image/png");
    if (junk.status === 400) ok("a non-image sent with an image mimetype is rejected");
    else bad(`a corrupt file returned ${junk.status} instead of 400`);

    // --- 6. Banners get the banner aspect, not the avatar's square -------------------------
    const wide = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 20, g: 160, b: 90 } },
    })
      .png()
      .toBuffer();
    const bn = await upload(token, "banner", wide, "wide.png", "image/png");
    if (bn.status !== 200) return bad(`banner upload failed: ${bn.status}`);
    written.push(bn.body.bannerUrl);
    const bnMeta = await sharp(Buffer.from(await (await fetch(`${BASE}${bn.body.bannerUrl}`)).arrayBuffer())).metadata();
    const ratio = bnMeta.width / bnMeta.height;
    if (Math.abs(ratio - 3) < 0.02) ok(`banner is cropped to 3:1 (${bnMeta.width}x${bnMeta.height})`);
    else bad(`banner is ${bnMeta.width}x${bnMeta.height} (ratio ${ratio.toFixed(2)}), expected 3:1`);

    // --- 7. THE ONE THAT MATTERS: the crop follows the subject ----------------------------
    const strip = await offCentreSubject();
    const centreCrop = await sharp(strip).resize(400, 400, { fit: "cover", position: "centre" }).png().toBuffer();
    const centreRed = await meanRed(centreCrop);

    const smart = await upload(token, "avatar", strip, "strip.png", "image/png");
    if (smart.status !== 200) return bad(`smart-crop upload failed: ${smart.status}`);
    written.push(smart.body.avatarUrl);
    const smartBuf = Buffer.from(await (await fetch(`${BASE}${smart.body.avatarUrl}`)).arrayBuffer());
    const smartRed = await meanRed(smartBuf);

    // Grey is 128; the checkerboard averages ~130 red but with saturated 250/10 extremes, so the
    // discriminating measure is distance from flat grey rather than absolute brightness.
    const centreDev = Math.abs(centreRed - 128);
    const smartDev = Math.abs(smartRed - 128);
    const contrast = await sharp(smartBuf).stats();
    const smartStdev = contrast.channels[0].stdev;

    if (smartStdev > 40) {
      ok(
        `the crop landed on the off-centre subject, not the middle ` +
          `(stdev ${smartStdev.toFixed(1)} vs flat grey; centre-crop deviation ${centreDev.toFixed(2)}, ` +
          `smart ${smartDev.toFixed(2)})`,
      );
    } else {
      bad(
        `the crop looks like a plain centre crop — output is nearly flat ` +
          `(stdev ${smartStdev.toFixed(1)}); attention cropping is not being applied`,
      );
    }
  } catch (e) {
    bad("image fit flow", String(e));
  } finally {
    for (const url of written) rmUpload(url);
    sql(`delete from "User" where username = '${username}';`);
    console.log(`cleaned up ${username} and ${written.length} uploaded file(s)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
