#!/usr/bin/env node
/**
 * Builds the notification badge — the small mark Android puts in the status bar.
 *
 * WHY THIS EXISTS
 * ---------------
 * `badge` is not a small version of the app icon, which is what it was set to. Android takes the
 * badge's ALPHA CHANNEL and paints it in a single colour; the RGB is thrown away. Handing it
 * `pwa-192.png` — a fully opaque square — therefore renders a solid white block in the status bar,
 * because every pixel of an opaque image is "inside the shape".
 *
 * So the badge has to be a silhouette: the mark's outline carried entirely in alpha, with the
 * colour channels set to white and ignored. That is what this produces, cut from the one file that
 * holds a real transparent cutout of the flame (see build-brand-marks.py for why the other
 * "transparent" marks were not).
 *
 * 96x96 is Android's badge size (24dp at xxxhdpi). Larger buys nothing — it is displayed at the
 * height of a status-bar glyph.
 *
 * Run:  node scripts/build-notification-badge.mjs      (uses the sharp already in node_modules)
 */
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, "apps/frontend/public/icons/logo-transparent.png");
const DEST = path.join(ROOT, "apps/frontend/public/icons/badge-96.png");
const SIZE = 96;

const { data, info } = await sharp(SRC)
  // `contain` rather than `cover`: the mark must not be cropped to fill a square, and the padding
  // is transparent, which for a silhouette means genuinely absent rather than a white margin.
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

// Only the alpha survives. Setting RGB to white keeps the file sensible to look at on its own and
// correct anywhere the platform does respect colour.
let opaque = 0;
for (let i = 0; i < data.length; i += 4) {
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
  if (data[i + 3] > 200) opaque++;
}

const total = info.width * info.height;
const coverage = (opaque / total) * 100;
// A silhouette that fills the frame is the bug this script exists to fix, arriving by a different
// route — refuse rather than ship a white square a second time.
if (coverage > 85) {
  console.error(
    `refusing to write: ${coverage.toFixed(1)}% of the badge is opaque, which is a filled square rather than a mark.\n` +
      `the source (${path.relative(ROOT, SRC)}) is probably not a real cutout.`,
  );
  process.exit(1);
}

await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .png()
  .toFile(DEST);

console.log(`wrote ${path.relative(ROOT, DEST)} — ${SIZE}x${SIZE}, ${coverage.toFixed(1)}% opaque`);

/**
 * The same silhouette again, as Android's status-bar icon.
 *
 * Android applies exactly the same rule to a notification's small icon as the web does to a badge:
 * the alpha is the shape and the colour is discarded. So it is the same cut at the densities
 * Android wants, rather than a second asset that could drift from this one.
 *
 * Both apps get it — the chat app and the owner console are separate Gradle projects with no shared
 * resources, so a file has to exist in each.
 */
const DENSITIES = [
  ["mdpi", 24],
  ["hdpi", 36],
  ["xhdpi", 48],
  ["xxhdpi", 72],
  ["xxxhdpi", 96],
];
const ANDROID_APPS = ["apps/mobile", "apps/owner-mobile"];

for (const app of ANDROID_APPS) {
  for (const [density, px] of DENSITIES) {
    const out = path.join(ROOT, app, `android/app/src/main/res/drawable-${density}/ic_stat_notify.png`);
    await sharp(SRC)
      .resize(px, px, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(async ({ data: d, info: i }) => {
        for (let n = 0; n < d.length; n += 4) {
          d[n] = 255;
          d[n + 1] = 255;
          d[n + 2] = 255;
        }
        await sharp(d, { raw: { width: i.width, height: i.height, channels: 4 } }).png().toFile(out);
      });
  }
  console.log(`wrote ${app}/…/drawable-*/ic_stat_notify.png — ${DENSITIES.length} densities`);
}
