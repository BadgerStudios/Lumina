import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("30d"),
  UPLOADS_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // TURN relay for voice/video (see modules/voice/routes.ts + realtime/handlers/voice.ts's
  // scale note) — optional. If unset, GET /api/voice/turn-credentials still responds but with
  // an empty `iceServers` beyond STUN, same STUN-only behavior as before this existed.
  TURN_SECRET: z.string().optional(),
  TURN_HOST: z.string().default("localhost"),
  TURN_PORT: z.coerce.number().default(3478),
  // Web Push (VAPID) — optional. If unset, subscribe/send just no-op (same graceful-degradation
  // pattern as TURN_SECRET above) rather than hard-failing routes that touch push.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@luxffa.com"),
  // Bumped by deploy.sh only when a new Android APK is actually built/published — lets the
  // installed app (see queries/meta.ts's useAppVersionCheck) know a newer build exists.
  ANDROID_VERSION_CODE: z.coerce.number().default(1),
  // Shared secret for the Lumina Control host agent (services/lumina-agent). Unset means the
  // feature is off — the ingest route then refuses everyone rather than admitting everyone.
  OPS_AGENT_SECRET: z.string().optional(),
  // Comma-separated emails granted OWNER / STAFF on their next login. This is the bootstrap path
  // for the very first privileged accounts — without it the video review queue and owner dashboard
  // would be unreachable by anyone, with raw SQL as the only way in.
  //
  // Reconciled on every login in BOTH directions, so removing an email here and having that person
  // log in demotes them: env is the source of truth, not a one-time seed. A consequence worth
  // knowing: promoting someone by editing the database alone is undone the next time they log in.
  //
  // OWNER wins if an address appears in both. SITE_ADMIN_EMAILS is the previous name for
  // STAFF_EMAILS, still read so an existing .env keeps working after the rename.
  // The single master account. Not a list — the master suite is deliberately one person, and a
  // comma-separated field would quietly invite it becoming several.
  MASTER_EMAIL: z.string().default(""),
  OWNER_EMAILS: z.string().default(""),
  STAFF_EMAILS: z.string().default(""),
  SITE_ADMIN_EMAILS: z.string().default(""),
  // Video feed caps. Deliberately separate from MAX_UPLOAD_MB (25) — the global multipart limit
  // stays small for chat attachments; only the video upload route raises it, per-request.
  MAX_VIDEO_UPLOAD_MB: z.coerce.number().default(100),
  MAX_VIDEO_DURATION_SEC: z.coerce.number().default(180),
  MAX_VIDEO_UPLOADS_PER_DAY: z.coerce.number().default(10),
  // Stripe. All optional — with none of them set, billing degrades to a working no-op (the same
  // graceful-if-unconfigured pattern TURN_SECRET and the VAPID keys already use): checkout returns
  // a clear "billing not configured" error, the webhook rejects everything, and the revenue panel
  // honestly reports zero rather than inventing a number.
  //
  // STRIPE_WEBHOOK_SECRET is NOT optional in practice once the others are set: without it, webhook
  // signatures cannot be verified and anyone who finds the endpoint could POST fake payment events
  // to grant themselves a subscription. The webhook route refuses to process anything unless it is
  // configured, rather than falling back to trusting the payload.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Where Stripe Checkout returns the user afterwards.
  PUBLIC_APP_URL: z.string().default("https://lumina.luxffa.com"),
  /// Real-money payout rail. OFF until the operator completes the one-time Stripe Connect setup —
  /// the readiness gate the creator-economy autonomy contract requires (SETUP_ONCE.md).
  STRIPE_CONNECT_ENABLED: z.coerce.boolean().default(false),
  // Bearer token for GET /metrics. Optional because a scrape from inside the Docker network is
  // already authorized by being there — this only matters for a Prometheus running somewhere else.
  // Unset means the endpoint answers 404 to anything off the private network.
  METRICS_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/**
 * Refuses to boot a production instance that is holding development configuration.
 *
 * This exists because of a real incident on 2026-08-12. Docker Compose resolves `${VAR}`
 * interpolation using the `.env` in the **current working directory**, while it walks *up* the tree
 * to find `compose.yml`. So running `cd apps/backend && docker compose up -d backend` finds the
 * right compose file and the wrong environment: `apps/backend/.env` is a local-dev file, and the
 * container came up with dev JWT secrets, `NODE_ENV=development`, and a `localhost:5173` origin —
 * on the live site.
 *
 * Nothing failed. The container reported healthy, the API served traffic, and the only visible
 * symptom was that verification emails contained a link to localhost. The real damage was silent:
 * session tokens signed with a development secret.
 *
 * These checks are fatal rather than warnings. A production instance running on dev secrets is a
 * security problem, and `deploy.sh` waits for the healthcheck — so failing here surfaces the
 * mistake as a failed deploy, which is exactly where it should surface. The alternative, a warning
 * in a log nobody reads, is how this went unnoticed in the first place.
 */
if (env.NODE_ENV === "production") {
  const problems: string[] = [];

  const origins = env.PUBLIC_APP_URL.split(",").map((o) => o.trim()).filter(Boolean);
  if (!origins.some((o) => o.startsWith("https://") && !o.includes("localhost"))) {
    problems.push(
      `PUBLIC_APP_URL has no public https origin (got "${env.PUBLIC_APP_URL}") — every emailed ` +
        "link and payment redirect would point somewhere unreachable",
    );
  }

  if (!env.CORS_ORIGIN.includes("https://")) {
    problems.push(`CORS_ORIGIN looks like a dev value (got "${env.CORS_ORIGIN}")`);
  }

  // Short or repeated secrets are the shape a placeholder takes. Not a strength test — just enough
  // to catch a dev file, which is the failure mode actually seen.
  for (const [name, value] of [
    ["JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET],
    ["JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET],
  ] as const) {
    if (value.length < 32 || /^(dev|test|changeme|secret)/i.test(value)) {
      problems.push(`${name} looks like a development placeholder`);
    }
  }

  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      "Refusing to start: NODE_ENV=production with development configuration.\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nMost likely cause: `docker compose` was run from a subdirectory. Compose reads .env " +
        "from the working directory but finds compose.yml by walking up, so apps/backend/.env " +
        "silently replaced the root .env. Re-run from the project root.",
    );
    process.exit(1);
  }
}
