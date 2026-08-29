import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
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
  // Public site status shown by the landing-page status pill. "online" (green) is normal;
  // "maintenance" (yellow) is a deliberate heads-up during planned work. "offline" (red) is never
  // set here — it's what a visitor's browser infers when this endpoint can't be reached at all, so
  // it can't be self-reported. Flippable without a code change; a redeploy picks up the new value.
  SITE_STATUS: z.enum(["online", "maintenance"]).default("online"),
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
  // Imageframe video screens (Minecraft plugin). 100MB cap per the product ask.
  MAX_IMAGEFRAME_MB: z.coerce.number().default(100),
  IMAGEFRAME_FPS: z.coerce.number().default(10),
  IMAGEFRAME_DEFAULT_COLS: z.coerce.number().default(3),
  IMAGEFRAME_DEFAULT_ROWS: z.coerce.number().default(2),
  IMAGEFRAME_MAX_COLS: z.coerce.number().default(8),
  IMAGEFRAME_MAX_ROWS: z.coerce.number().default(8),
  IMAGEFRAME_PUBLIC_URL: z.string().default(""),
  IMAGEFRAME_LOG_TOKEN: z.string().optional(),
  IMAGEFRAME_LOG_LEVEL: z.string().optional(),

  // ---- Age verification (Persona) ----
  // Same graceful-if-unconfigured contract as Stripe: with none set, the whole verification stack is
  // inert — /persona/start reports "not configured", the webhook rejects everything, and no account
  // can be upgraded to DOCUMENT_VERIFIED except by the admin selfie-review path. Going live is adding
  // env vars, no code change. PERSONA_WEBHOOK_SECRET, like the Stripe one, is mandatory-in-practice
  // once the API key is set: without it inbound webhooks cannot be signature-verified and are refused.
  PERSONA_API_KEY: z.string().optional(),
  PERSONA_WEBHOOK_SECRET: z.string().optional(),
  PERSONA_TEMPLATE_ID: z.string().optional(),
  PERSONA_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  // Free-tier allotment before falling back to admin selfie review. 500 on the current plan.
  PERSONA_MONTHLY_LIMIT: z.coerce.number().default(500),

  // ---- Age verification (Didit) ----
  // The automated alternative to Persona: ID_VERIFICATION + LIVENESS + FACE_MATCH + IP_ANALYSIS with
  // no operator in the loop. Same graceful-if-unconfigured contract — with DIDIT_ENABLED false or the
  // key absent, /didit/start reports not-configured and startVerification falls through to Persona
  // and then to manual review exactly as before.
  //
  // DIDIT_WEBHOOK_SECRET is OPTIONAL here, unlike the Persona/Stripe equivalents, because the
  // decision is read by polling the session when the user returns. The webhook is only an
  // accelerator; without the secret inbound webhooks are refused and nothing else changes.
  DIDIT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  DIDIT_API_KEY: z.string().optional(),
  DIDIT_WORKFLOW_ID: z.string().optional(),
  DIDIT_WEBHOOK_SECRET: z.string().optional(),
  DIDIT_BASE_URL: z.string().default("https://verification.didit.me"),

  // ---- Native device attestation (fail-closed) ----
  // A native Apple/Google age band is only trusted with a valid app-attestation proving the request
  // came from the genuine, unmodified app. If these are unset the DEVICE_DECLARED upgrade is simply
  // NOT granted (the band is ignored and we fall back to self-declared) — never trusted unverified.
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_INTEGRITY_SA_JSON: z.string().optional(), // service-account JSON (or a path) for Play Integrity API
  GOOGLE_CLOUD_PROJECT_NUMBER: z.string().optional(),
  APPLE_APP_ATTEST_TEAM_ID: z.string().optional(),
  APPLE_APP_ATTEST_BUNDLE_ID: z.string().optional(),

  // ---- Cloudflare Turnstile (bot/abuse challenge) ----
  // Verifies a client-solved challenge token server-side. Unset = the requireTurnstile preHandler is
  // a no-op (routes work unchallenged, as today), so this ships inert and activates by adding keys.
  // The site key is public and surfaced to clients via GET /api/meta; the secret never leaves here.
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Comma-separated hostnames a solved Turnstile token may originate from (Cloudflare's canonical
  // hostname binding). Defaults to the app's own origins when unset.
  TURNSTILE_HOSTNAMES: z.string().default("lumina.badgerstudios.net,lumina.luxffa.com,localhost,127.0.0.1"),
  // 0 = challenge EVERY login (owner directive 2026-08-22, matching signup). Set it above zero to
  // relax back to "only after N failed logins for this IP+account pair inside 15 minutes", which
  // spares honest users a captcha while still biting a password-list run. Failures are counted
  // either way, so flipping this back takes effect immediately.
  TURNSTILE_LOGIN_FAILURE_THRESHOLD: z.coerce.number().default(0),
  /**
   * Emergency re-open of the native-app Turnstile exemption. Defaults to OFF: packaged apps must
   * solve the challenge like every other client (see plugins/turnstile.ts).
   *
   * This exists purely as a rollback lever. If a real device turns out not to solve the widget in
   * the Capacitor WebView, signup and payments would be dead for every app install — and the fix
   * must not require a code change and redeploy at whatever hour that is discovered. Set to "true"
   * and restart the backend to restore the old spoofable-header exemption, then investigate.
   */
  /**
   * When identity verification becomes mandatory for NEW signups, as an ISO date.
   *
   * UNSET = never required, which is the default and the safe posture. This used to be a hardcoded
   * 2026-08-21T16:00Z, and with Persona unconfigured the only route through the gate was a manual
   * selfie + government-ID queue that an operator had to work by hand. Signups went from 34 in the
   * preceding 12 days to zero in the 5 days after; the one account that did register is still
   * sitting behind the wall. A verification requirement that has no working path through it is an
   * outage, so it now has to be switched on deliberately rather than being on by default.
   *
   * Turn it on only once a path actually exists (PERSONA_* set, or someone is genuinely working
   * the manual queue), and set it to the moment you switch it on so existing accounts stay
   * grandfathered.
   */
  // Empty string is treated as ABSENT, not as an invalid value.
  //
  // compose.yml passes this as `${IDENTITY_REQUIRED_FROM:-}`, so commenting the line out in .env
  // delivers "" rather than nothing — and `.optional()` accepts undefined, not "". That mismatch
  // took the whole backend down in a boot loop: the container refused to start, which for a
  // config value whose entire purpose is to be switchable is the worst possible failure mode.
  IDENTITY_REQUIRED_FROM: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().datetime().optional(),
  ),
  TURNSTILE_ALLOW_NATIVE_BYPASS: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
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
