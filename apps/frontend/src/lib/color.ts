/** Mixes a hex color toward white by `amount` (0-1) — used to derive a lighter gradient
 * partner / hover shade from a single admin-picked server accent color, since only one color is
 * collected in the UI (see ServerSettingsModal.tsx's color input) but index.css's accent system
 * expects a --ion/--aurora pair plus a --accent-hover. */
export function mixWithWhite(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Mixes a hex color toward black by `amount` (0-1) — for --accent-hover. */
export function mixWithBlack(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c * (1 - amount));
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function intColorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
