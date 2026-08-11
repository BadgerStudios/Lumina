import { defineConfig } from "vitest/config";

/**
 * Unit tests for the pure logic that live-integration scripts cannot reach cheaply.
 *
 * This tier does NOT replace the verify-*.mjs scripts — those exercise the real deployment and
 * catch entirely different things (a stale CDN, a route that moved, a broadcast nobody receives).
 * What belongs here is logic whose failure modes are combinatorial rather than environmental:
 * permission precedence, crypto round-trips, code verification. Things where you want fifty cases,
 * not one happy path against a live server.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // No database, no Redis, no network. A unit test that needs a container is an integration test
    // wearing the wrong hat, and it will be the reason nobody runs the suite.
    environment: "node",
    // Runs before any test module is imported, which is the only point early enough to satisfy
    // config/env.ts — it validates at import time and exits the process when unsatisfied.
    setupFiles: ["src/test-setup.ts"],
  },
});
