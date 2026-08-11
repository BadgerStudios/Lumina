/**
 * Minimal fake environment for unit tests.
 *
 * `config/env.ts` validates the whole environment at import time and calls `process.exit(1)` if it
 * is incomplete — which is exactly right for a server that should refuse to boot misconfigured, and
 * fatal for a test runner, since importing any module that transitively touches it kills the
 * process before a single test runs.
 *
 * The fix is a fake environment rather than relaxing that validation: production keeps its fail-fast
 * behaviour, and the tests stay hermetic. These are deliberately obvious dummy values — nothing here
 * reaches a real database, Redis or network, and a test that needed a real one would belong in the
 * verify-*.mjs tier instead.
 */
const FAKE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  REDIS_URL: "redis://127.0.0.1:6379",
  JWT_ACCESS_SECRET: "unit-test-access-secret-not-a-real-key",
  JWT_REFRESH_SECRET: "unit-test-refresh-secret-not-a-real-key",
};

for (const [key, value] of Object.entries(FAKE_ENV)) {
  // Never overwrite something the caller set on purpose — running the suite against a real .env is
  // occasionally useful, and silently replacing those values would make the result a lie.
  process.env[key] ??= value;
}
