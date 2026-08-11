/**
 * A stable-ish identifier for this browser, sent as `X-Device-Fingerprint` on auth requests and
 * stored against the session so a platform ban can cover the device rather than only the account.
 *
 * What this genuinely is, and is not — worth being precise about, because "hardware ban" implies far
 * more than any web app can deliver:
 *
 *  - A browser has NO access to real hardware identifiers. No MAC address, no disk or motherboard
 *    serial, no TPM. Nothing here identifies a machine in the way a native anti-cheat driver would.
 *  - What it does capture is rendering and environment entropy — canvas and WebGL output, screen
 *    geometry, timezone, language, platform, hardware concurrency — which in combination is fairly
 *    distinctive for a given browser profile on a given machine.
 *  - It therefore DOES catch the common case: the same person making a new account in the same
 *    browser right after being banned.
 *  - It does NOT catch a different browser, a fresh/incognito profile in some configurations, a
 *    different machine, or a VPN paired with a new signup.
 *  - It CAN collide between genuinely different people on locked-down or corporate-imaged machines
 *    that expose identical entropy — which is exactly why the ban flow has an appeal path.
 *
 * Treat it as raising the cost of casual evasion, never as proof of identity. The value is also
 * client-supplied and so trivially forgeable by anyone who cares to.
 */

const STORAGE_KEY = "lumina-device-id";

function canvasEntropy(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "nocanvas";
    // Text rendering differs by font stack, antialiasing and GPU — the classic entropy source.
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 120, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("Lumina fingerprint \u{1F512}", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("Lumina fingerprint \u{1F512}", 4, 20);
    return canvas.toDataURL().slice(-120);
  } catch {
    return "canvaserr";
  }
}

function webglEntropy(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as
      | WebGLRenderingContext
      | null;
    if (!gl) return "nowebgl";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return `${String(vendor)}~${String(renderer)}`;
  } catch {
    return "webglerr";
  }
}

/** FNV-1a — a short, dependency-free, non-cryptographic hash. It only needs to be stable and
 * compact; the server salts and re-hashes with SHA-256 before storing anything. */
function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

let cached: string | null = null;

export function getDeviceFingerprint(): string {
  if (cached) return cached;

  // A previously-issued id is reused when available, so the fingerprint stays stable across a
  // browser update that would otherwise shift the rendering entropy and look like a new device.
  // Clearing storage regenerates it — accepted, since the computed entropy below still matches.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    /* storage unavailable (private mode) — fall through and compute each time */
  }

  const parts = [
    navigator.userAgent,
    navigator.language,
    Array.isArray(navigator.languages) ? navigator.languages.join(",") : "",
    String(navigator.hardwareConcurrency ?? ""),
    String((navigator as { deviceMemory?: number }).deviceMemory ?? ""),
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    String(new Date().getTimezoneOffset()),
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    canvasEntropy(),
    webglEntropy(),
  ];

  const value = hash(parts.join("|"));
  cached = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* nothing to persist to; the computed value is still returned */
  }
  return value;
}
