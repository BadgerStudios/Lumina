import sharp from "sharp";
import { BadRequestError } from "./errors.js";

/**
 * Server-side normalisation of every user-supplied profile image (user avatar/banner, server
 * icon/banner).
 *
 * Before this, uploads were written to disk byte-for-byte and cropped purely by CSS
 * `object-fit: cover` / `background-position: center` at render time. That has three problems,
 * only the first of which is cosmetic:
 *
 * 1. **Centre-cropping is the wrong crop.** A phone photo is 3:4 and the subject is rarely dead
 *    centre, so a portrait uploaded as an avatar routinely renders as a crop of someone's chest.
 *    Here the crop is chosen by libvips' `attention` strategy, which scores regions by luminance
 *    frequency with a skin-tone bias — i.e. it lands on faces.
 * 2. **The browser was downloading the original.** A 6MB 4000x3000 JPEG was fetched in full to
 *    paint a 32px member-list row, once per distinct avatar per page.
 * 3. **An uploaded SVG was a stored-XSS vector.** `/avatars/*` is proxied on the *same origin* as
 *    the app (see apps/frontend/nginx.conf), `image/svg+xml` passes an `image/` mimetype check,
 *    and an SVG opened directly in a tab executes its own scripts. Rasterising every upload means
 *    an `.svg` never reaches disk at all — the fix is structural rather than a blocklist.
 *
 * Two smaller things fall out of doing this at all: EXIF is dropped (sharp does not copy metadata
 * unless asked, so uploading a holiday photo no longer publishes its GPS coordinates), and EXIF
 * orientation is baked into the pixels first, so a sideways phone photo stays upright everywhere
 * rather than only in the surfaces whose CSS happens to honour `image-orientation`.
 */

export type ImagePreset = "avatar" | "userBanner" | "serverIcon" | "serverBanner";

interface PresetSpec {
  width: number;
  height: number;
  /** Animation is worth preserving on the small square marks (Discord-style animated avatars) and
   * pointless on a wide banner, where it is mostly a way to make a page strobe. */
  allowAnimation: boolean;
  quality: number;
}

const PRESETS: Record<ImagePreset, PresetSpec> = {
  avatar: { width: 512, height: 512, allowAnimation: true, quality: 82 },
  serverIcon: { width: 512, height: 512, allowAnimation: true, quality: 82 },
  // 3:1. Matches how every banner surface renders today (a short, full-width strip), so the
  // stored pixels and the displayed box agree and nothing is cropped twice.
  userBanner: { width: 1500, height: 500, allowAnimation: false, quality: 80 },
  serverBanner: { width: 1920, height: 640, allowAnimation: false, quality: 80 },
};

/** Frames beyond this are dropped to the first frame. An animated WebP is re-encoded frame by
 * frame, so an unbounded page count is an unbounded amount of CPU on an upload route. */
const MAX_ANIMATION_FRAMES = 120;

/** Guards against a decompression bomb: a few-KB PNG can declare 30000x30000 and cost gigabytes to
 * decode. sharp's own default is ~268MP; this is deliberately far tighter, since nothing here is a
 * legitimate profile image. */
const MAX_INPUT_PIXELS = 50_000_000;

export interface FittedImage {
  data: Buffer;
  /** Always "webp" today, but returned rather than assumed so call sites build filenames from what
   * was actually encoded. */
  extension: string;
  mimeType: string;
  width: number;
  height: number;
  animated: boolean;
}

/** Crops and re-encodes one upload to its preset. */
export async function fitImage(input: Buffer, preset: ImagePreset): Promise<FittedImage> {
  const spec = PRESETS[preset];

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    // Reached when the bytes aren't a decodable image at all. The mimetype check upstream only
    // reads the client's claim about the file, which is trivially wrong or trivially forged.
    throw new BadRequestError("That file isn't a readable image");
  }

  const target = fitBox(spec, sourceSize(metadata));
  const frames = metadata.pages ?? 1;
  const wantsAnimation = spec.allowAnimation && frames > 1 && frames <= MAX_ANIMATION_FRAMES;

  if (wantsAnimation) {
    try {
      return await encode(input, spec, target, { animated: true });
    } catch {
      // Fall through to the still path. An animated source that libvips can decode as a single
      // image but not as a filmstrip should still produce a working avatar rather than a 500.
    }
  }

  return encode(input, spec, target, { animated: false });
}

/** The source's dimensions **as they will be after auto-orientation** — EXIF orientations 5-8
 * transpose the image, so reading width/height straight off the metadata would have them the
 * wrong way round for a photo taken in portrait on a phone. */
function sourceSize(metadata: sharp.Metadata): { width: number; height: number } {
  // For an animated source, `height` is the whole filmstrip; `pageHeight` is one frame.
  const width = metadata.width ?? 0;
  const height = metadata.pageHeight ?? metadata.height ?? 0;
  const transposed = (metadata.orientation ?? 1) >= 5;
  return transposed ? { width: height, height: width } : { width, height };
}

/**
 * The output box: the preset, scaled down uniformly if the source is smaller than it.
 *
 * The obvious implementation of "don't upscale" is sharp's own `withoutEnlargement`, and it is
 * wrong here — it clamps each axis independently, so a 400x1200 portrait against a 512x512 avatar
 * target came out **400x512**, i.e. not square at all, and every circular avatar frame then
 * squashed it. Scaling the target box as a unit keeps the preset's aspect ratio exactly while
 * still never inventing pixels.
 */
function fitBox(spec: PresetSpec, source: { width: number; height: number }): { width: number; height: number } {
  if (source.width <= 0 || source.height <= 0) return { width: spec.width, height: spec.height };
  const scale = Math.min(1, source.width / spec.width, source.height / spec.height);
  return {
    width: Math.max(1, Math.round(spec.width * scale)),
    height: Math.max(1, Math.round(spec.height * scale)),
  };
}

async function encode(
  input: Buffer,
  spec: PresetSpec,
  target: { width: number; height: number },
  { animated }: { animated: boolean },
): Promise<FittedImage> {
  const pipeline = sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    animated,
    // 'error' rather than sharp's default 'warning': a great many perfectly viewable JPEGs off
    // real cameras and phones carry non-fatal warnings, and rejecting those would read to the
    // user as "this app won't accept my photo" for no benefit.
    failOn: "error",
  });

  const resized = pipeline
    // No argument: apply the EXIF orientation to the pixels, then forget it. Must come before
    // resize, or the crop is computed against the un-rotated frame.
    .rotate()
    .resize(target.width, target.height, {
      fit: "cover",
      // The whole point of the exercise. Not supported for a filmstrip — every frame would want
      // its own crop window and the subject would jitter — so animated inputs get a centre crop.
      position: animated ? "centre" : sharp.strategy.attention,
    })
    .webp({ quality: spec.quality, effort: 4 });

  const { data, info } = await resized.toBuffer({ resolveWithObject: true });

  return {
    data,
    extension: "webp",
    mimeType: "image/webp",
    width: info.width,
    // For an animated WebP, info.height is the height of the whole filmstrip rather than of one
    // frame, which would otherwise be recorded as a nonsense aspect ratio.
    height: animated && info.pages && info.pages > 1 ? Math.round(info.height / info.pages) : info.height,
    animated,
  };
}
