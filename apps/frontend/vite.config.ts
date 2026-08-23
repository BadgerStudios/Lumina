import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

/**
 * Two builds from one source tree, selected by APP_VARIANT:
 *
 *  - default: the full Lumina app (index.html -> src/main.tsx), output to dist/
 *  - "owner":  the standalone owner console (owner.html -> src/owner-main.tsx), output to
 *              dist-owner/, which the owner Android project wraps.
 *
 * A separate Vite *app* would have meant duplicating the query layer, auth client, theme and
 * components or wiring up cross-package imports for them. A second entry reuses all of it while
 * still producing a genuinely separate bundle that contains none of the chat app.
 */
const isOwnerBuild = process.env.APP_VARIANT === "owner";

/**
 * Landing-page media, dropped from the native bundles.
 *
 * Everything under public/ is copied verbatim into dist/, and Capacitor then copies dist/ into the
 * APK — so the marketing site's assets ship inside the app. That is 20MB+ of nebula loop and
 * product footage, for a page a native build never renders: `/` routes straight to the app when
 * CLIENT_TYPE is set (see App.tsx's LandingGate).
 *
 * Discovered by diffing a rebuilt APK against the shipped one: 34MB vs 14MB, and the entire delta
 * was the five-minute background video.
 *
 * Web builds keep all of it, obviously — that is where it is actually used.
 */
const LANDING_ONLY = ["screens"];

function stripLandingMedia(outDir: string): Plugin {
  return {
    name: "lumina-strip-landing-media",
    apply: "build",
    closeBundle() {
      for (const dir of LANDING_ONLY) {
        rmSync(resolve(__dirname, outDir, dir), { recursive: true, force: true });
      }
    },
  };
}


export default defineConfig(({ mode }) => ({
  // The owner console carries them too — 5MB of the marketing site inside an admin app that has
  // never had a route which renders any of it.
  plugins: [
    react(),
    ...(mode === "mobile" || mode === "desktop" ? [stripLandingMedia("dist")] : []),
    ...(isOwnerBuild ? [stripLandingMedia("dist-owner")] : []),
  ],
  ...(isOwnerBuild
    ? {
        // Relative asset paths so one bundle works in both places it is served: Capacitor loads it
        // from the WebView root, and nginx serves the identical files under /owner-app/. Vite's
        // default absolute "/assets/..." 404s under any subpath, which renders as a blank page with
        // no error on screen.
        base: "./",
        build: {
          outDir: "dist-owner",
          emptyOutDir: true,
          rollupOptions: { input: resolve(__dirname, "owner.html") },
        },
      }
    : {}),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://127.0.0.1:4000",
        ws: true,
        changeOrigin: true,
      },
      "/avatars": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
    },
  },
}));
