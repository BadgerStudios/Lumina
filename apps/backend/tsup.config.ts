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
  // @prisma/client ships native query-engine binaries that must not be bundled.
  external: ["@prisma/client"],
  noExternal: [/^@lumina\//],
});
