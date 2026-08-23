/**
 * The Minecraft map-color palette and a nearest-color quantizer.
 *
 * A filled map stores one byte per pixel: the byte is a *map color id* = base*4 + shade, where the
 * base is one of the 62 block-derived colors below and the shade is one of four brightness
 * multipliers. Ids 0..3 (base 0) are fully transparent and never emitted for opaque video. This is
 * the exact palette LOOHP's ImageFrame and every map renderer use, so a byte we emit here can be
 * blitted straight into a MapCanvas / map packet with no re-matching on the game server.
 *
 * paletteVersion is stamped into every cached pack: the base table has grown across MC versions
 * (49 → 59 → 62 entries), and a plugin on an older server must be able to tell it was handed colors
 * its client can't render. Bumping BASE_COLORS bumps this.
 */
export const PALETTE_VERSION = 1;

// Base colors as of MC 1.20 (62 entries). Index is the base id; stored map byte is id*4 + shade.
// prettier-ignore
const BASE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],       // 0  TRANSPARENT
  [127, 178, 56],  // 1  GRASS
  [247, 233, 163], // 2  SAND
  [199, 199, 199], // 3  WOOL
  [255, 0, 0],     // 4  FIRE
  [160, 160, 255], // 5  ICE
  [167, 167, 167], // 6  METAL
  [0, 124, 0],     // 7  PLANT
  [255, 255, 255], // 8  SNOW
  [164, 168, 184], // 9  CLAY
  [151, 109, 77],  // 10 DIRT
  [112, 112, 112], // 11 STONE
  [64, 64, 255],   // 12 WATER
  [143, 119, 72],  // 13 WOOD
  [255, 252, 245], // 14 QUARTZ
  [216, 127, 51],  // 15 COLOR_ORANGE
  [178, 76, 216],  // 16 COLOR_MAGENTA
  [102, 153, 216], // 17 COLOR_LIGHT_BLUE
  [229, 229, 51],  // 18 COLOR_YELLOW
  [127, 204, 25],  // 19 COLOR_LIGHT_GREEN
  [242, 127, 165], // 20 COLOR_PINK
  [76, 76, 76],    // 21 COLOR_GRAY
  [153, 153, 153], // 22 COLOR_LIGHT_GRAY
  [76, 127, 153],  // 23 COLOR_CYAN
  [127, 63, 178],  // 24 COLOR_PURPLE
  [51, 76, 178],   // 25 COLOR_BLUE
  [102, 76, 51],   // 26 COLOR_BROWN
  [102, 127, 51],  // 27 COLOR_GREEN
  [153, 51, 51],   // 28 COLOR_RED
  [25, 25, 25],    // 29 COLOR_BLACK
  [250, 238, 77],  // 30 GOLD
  [92, 219, 213],  // 31 DIAMOND
  [74, 128, 255],  // 32 LAPIS
  [0, 217, 58],    // 33 EMERALD
  [129, 86, 49],   // 34 PODZOL
  [112, 2, 0],     // 35 NETHER
  [209, 177, 161], // 36 TERRACOTTA_WHITE
  [159, 82, 36],   // 37 TERRACOTTA_ORANGE
  [149, 87, 108],  // 38 TERRACOTTA_MAGENTA
  [112, 108, 138], // 39 TERRACOTTA_LIGHT_BLUE
  [186, 133, 36],  // 40 TERRACOTTA_YELLOW
  [103, 117, 53],  // 41 TERRACOTTA_LIGHT_GREEN
  [160, 77, 78],   // 42 TERRACOTTA_PINK
  [57, 41, 35],    // 43 TERRACOTTA_GRAY
  [135, 107, 98],  // 44 TERRACOTTA_LIGHT_GRAY
  [87, 92, 92],    // 45 TERRACOTTA_CYAN
  [122, 73, 88],   // 46 TERRACOTTA_PURPLE
  [76, 62, 92],    // 47 TERRACOTTA_BLUE
  [76, 50, 35],    // 48 TERRACOTTA_BROWN
  [76, 82, 42],    // 49 TERRACOTTA_GREEN
  [142, 60, 46],   // 50 TERRACOTTA_RED
  [37, 22, 16],    // 51 TERRACOTTA_BLACK
  [189, 48, 49],   // 52 CRIMSON_NYLIUM
  [148, 63, 97],   // 53 CRIMSON_STEM
  [92, 25, 29],    // 54 CRIMSON_HYPHAE
  [22, 126, 134],  // 55 WARPED_NYLIUM
  [58, 142, 140],  // 56 WARPED_STEM
  [86, 44, 62],    // 57 WARPED_HYPHAE
  [20, 180, 133],  // 58 WARPED_WART_BLOCK
  [100, 100, 100], // 59 DEEPSLATE
  [216, 175, 147], // 60 RAW_IRON
  [127, 167, 150], // 61 GLOW_LICHEN
];

// The four shade multipliers, in map-byte shade order (m = 0,1,2,3), as x/255.
const SHADES = [180, 220, 255, 135] as const;

/**
 * The full expanded palette: one entry per emittable map byte. Built once at module load.
 * `bytes[i]` is the map color id; `rgb[i*3..]` its resolved RGB. Base 0 (transparent, ids 0..3) is
 * skipped — opaque video never wants it, and including it would let a dark frame match to
 * "transparent" and punch holes in the screen.
 */
const paletteBytes: number[] = [];
const paletteRgb: number[] = [];
for (let base = 1; base < BASE_COLORS.length; base++) {
  const [r, g, b] = BASE_COLORS[base]!;
  for (let s = 0; s < SHADES.length; s++) {
    const m = SHADES[s]!;
    paletteBytes.push(base * 4 + s);
    paletteRgb.push(Math.floor((r * m) / 255), Math.floor((g * m) / 255), Math.floor((b * m) / 255));
  }
}

/**
 * A 32K-entry lookup cache keyed by the top 5 bits of each channel (RGB555). Nearest-color match
 * over ~244 palette entries per pixel is the transcoder's hot loop — at 640x384x10fps that's ~2.4M
 * matches/sec, and an exact per-pixel search would dominate the whole job. Quantizing the key to
 * RGB555 collapses that to a one-time fill of 32768 slots; the visual error from dropping 3 bits
 * per channel is far below the palette's own step size, so it's free accuracy-wise.
 */
const cache = new Int16Array(32768).fill(-1);

function nearestByte(r: number, g: number, b: number): number {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const hit = cache[key]!;
  if (hit >= 0) return hit;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < paletteBytes.length; i++) {
    const dr = r - paletteRgb[i * 3]!;
    const dg = g - paletteRgb[i * 3 + 1]!;
    const db = b - paletteRgb[i * 3 + 2]!;
    // Perceptually weighted (approx. Rec. 601) — plain Euclidean makes greens and blues swap in a
    // way the eye notices on skin tones and skies.
    const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (dist < bestDist) {
      bestDist = dist;
      best = paletteBytes[i]!;
    }
  }
  cache[key] = best;
  return best;
}

/**
 * Quantize a raw rgb24 frame (length = w*h*3) into w*h map bytes, in place into `out`. Row-major,
 * matching ffmpeg's rawvideo output and a map canvas's own layout.
 */
export function quantizeFrame(rgb: Buffer, out: Uint8Array): void {
  for (let p = 0, o = 0; o < out.length; p += 3, o++) {
    out[o] = nearestByte(rgb[p]!, rgb[p + 1]!, rgb[p + 2]!);
  }
}
