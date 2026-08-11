import path from "node:path";
import fs from "node:fs";

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * SPA fallback for the app:// protocol handler: any requested path that isn't a real built
 * file (a client-side route like /channels/x/y) resolves to index.html instead — same
 * reasoning as nginx.conf's `try_files $uri $uri/ /index.html` for the web build. Pulled out of
 * main.ts as a pure function (no Electron imports) so it's unit-testable with plain Node —
 * `protocol.handle` itself can't be exercised without a real Electron GUI process, which this
 * sandboxed dev environment can't run (no Xvfb/root access), but this is the one part of the
 * handler with actual logic worth verifying directly.
 */
export function resolveRendererFile(rendererDir: string, requestedPathname: string): string {
  const requested = decodeURIComponent(requestedPathname);
  const candidate = path.join(rendererDir, requested === "/" ? "/index.html" : requested);
  const isRealFile = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  return isRealFile ? candidate : path.join(rendererDir, "index.html");
}
