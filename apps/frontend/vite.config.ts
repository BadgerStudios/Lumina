import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

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

export default defineConfig({
  plugins: [react()],
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
});
