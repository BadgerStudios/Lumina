import { defineConfig } from "tsup";

export default defineConfig({
  // Two entrypoints, one image: the API (dist/index.js) and the video transcode worker
  // (dist/worker.js), selected by the container's command in compose.yml. Sharing a build keeps
  // the Prisma client, schema and env parsing identical between them by construction.
  entry: ["src/index.ts", "src/worker.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  // @prisma/client ships native query-engine binaries that must not be bundled. ws and
  // socket.io-client are CommonJS with dynamic require()s ("events", "fs") that esbuild cannot
  // rewrite into an ESM bundle — inlining either crash-loops the container at boot (learned in
  // production, twice, one transitive layer apart). They're declared runtime dependencies, so
  // the image resolves them from node_modules like @prisma/client.
  external: ["@prisma/client", "ws", "socket.io-client"],
  noExternal: [/^@lumina\//],
});
