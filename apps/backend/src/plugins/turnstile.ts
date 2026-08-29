import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { env } from "../config/env.js";
import { BlockedError } from "../lib/errors.js";

/**
 * Cloudflare Turnstile — a bot/abuse challenge on high-value actions (account recovery, password
 * resets, signup, payments, and creating content/conversations).
 *
 * Graceful-if-unconfigured, exactly like the TURN and Stripe integrations: with TURNSTILE_SECRET_KEY
 * unset, `requireTurnstile` is a pass-through and every gated route behaves exactly as it does today.
 * The client sends the solved token in the `cf-turnstile-response` header (or a `turnstileToken` body
 * field); the secret is verified server-side against Cloudflare's siteverify and never leaves here.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Enforcement is on when the secret is present (siteverify can run). */
export function isTurnstileConfigured(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

/** Fully enabled = both the public site key (for the widget) and the secret (for verification). The
 * widget is only surfaced to clients when this is true, so there's never a rendered-but-unenforced
 * challenge. */
export function isTurnstileEnabled(): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/** Approved hostnames a solved token may originate from (Cloudflare's canonical check binds a token
 * to the domain it was solved on, defeating tokens farmed on an attacker-controlled page). Defaults
 * cover the app's own origins; override with TURNSTILE_HOSTNAMES. */
function approvedHostnames(): Set<string> {
  const raw = env.TURNSTILE_HOSTNAMES || "lumina.badgerstudios.net,lumina.luxffa.com,localhost,127.0.0.1";
  return new Set(raw.split(",").map((h) => h.trim()).filter(Boolean));
}

/**
 * The former native-app exemption, now OFF unless explicitly re-enabled.
 *
 * `X-Client-Type` is a plain request header with nothing attesting it, so exempting it meant one
 * line of curl skipped every challenge on signup, password reset and payments — verified against
 * production: the same registration that a browser gets a 403 TURNSTILE_REQUIRED for succeeded with
 * `x-client-type: mobile` and created a real account.
 *
 * The exemption existed because it was unknown whether the widget solves inside the Capacitor
 * WebView, which loads the bundled frontend from `https://localhost` rather than the live domain
 * (apps/mobile/capacitor.config.ts sets `webDir` and no `server.url`). That is now checked: the
 * site key renders on a `localhost` origin with no domain rejection, and `localhost` is already in
 * the approved-hostname list the token binding is validated against. So the apps can solve it, and
 * a claim to be an app is no longer a way to skip it.
 *
 * Kept only as a rollback lever behind TURNSTILE_ALLOW_NATIVE_BYPASS — see the note there.
 */
function nativeBypassAllowed(request: FastifyRequest): boolean {
  if (!env.TURNSTILE_ALLOW_NATIVE_BYPASS) return false;
  return request.headers["x-client-type"] === "mobile" || request.headers["x-client-type"] === "desktop";
}

function tokenFrom(request: FastifyRequest): string | null {
  const header = request.headers["cf-turnstile-response"];
  if (typeof header === "string" && header) return header;
  const body = request.body as { turnstileToken?: unknown } | undefined;
  if (body && typeof body.turnstileToken === "string" && body.turnstileToken) return body.turnstileToken;
  return null;
}

type VerifyResult = { ok: boolean; reason: string; hostname?: string };

/**
 * Verify a token, and say WHY when it does not pass.
 *
 * The reason is the whole point. A bare `false` cannot distinguish "someone is farming tokens on
 * their own page" from "we forgot to add our new origin to TURNSTILE_HOSTNAMES", and those two need
 * opposite responses. Both used to look identical from outside: a 403 and no record of it.
 */
async function verify(token: string, ip: string | undefined): Promise<VerifyResult> {
  if (token.length > 2048) return { ok: false, reason: "token-too-long" }; // a token is never this long
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY!,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    const data = (await res.json()) as { success?: boolean; hostname?: string; "error-codes"?: string[] };
    if (data.success !== true) {
      const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].join(",") : "none";
      return { ok: false, reason: `siteverify-rejected:${codes}` };
    }
    // Canonical hostname binding: reject a token solved on a domain that isn't ours. Fail CLOSED if
    // the hostname is missing on an otherwise-successful verify — a token with no provable origin is
    // exactly the shape a farmed/relayed token would take, so it must not pass by default.
    if (!data.hostname || !approvedHostnames().has(data.hostname)) {
      return { ok: false, reason: "hostname-not-approved", hostname: data.hostname ?? "(none)" };
    }
    return { ok: true, reason: "verified", hostname: data.hostname };
  } catch (err) {
    // A siteverify outage should not become a hard outage of signup/login. Fail OPEN on transport
    // error only (a present-but-invalid token still fails closed above). Logged so an outage-driven
    // abuse spike — the window where all bot protection silently drops — is at least visible.
    console.error("[turnstile] siteverify transport error — failing open:", (err as Error)?.message ?? err);
    return { ok: true, reason: "transport-error-failed-open" };
  }
}

/**
 * One structured line per Turnstile decision, including the passes.
 *
 * Logging only refusals was the previous state and it was actively misleading: with nothing written
 * on either path, "no TURNSTILE_FAILED in the logs" was read as "the web path is healthy" when it
 * could never have been anything else. Absence of evidence was being read as evidence. Passes are
 * logged too so the ratio is visible and silence means genuinely no traffic.
 */
function logTurnstile(request: FastifyRequest, surface: string, outcome: string, detail?: VerifyResult): void {
  const parts = [
    `outcome=${outcome}`,
    `surface=${surface}`,
    `route=${request.method} ${request.url}`,
    `ip=${request.ip}`,
  ];
  if (detail?.reason) parts.push(`reason=${detail.reason}`);
  if (detail?.hostname) parts.push(`hostname=${detail.hostname}`);
  console.log(`[turnstile] ${parts.join(" ")}`);
}

/**
 * The shared challenge all three gates run.
 *
 * These four lines were duplicated across requireTurnstile, requireTurnstileForLogin and
 * requireTurnstileForRisky, which is why adding observability to one of them would have quietly
 * left the other two blind.
 */
async function challenge(request: FastifyRequest, surface: string): Promise<void> {
  const token = tokenFrom(request);
  if (!token) {
    logTurnstile(request, surface, "REQUIRED");
    throw new BlockedError("TURNSTILE_REQUIRED");
  }
  const result = await verify(token, request.ip);
  if (!result.ok) {
    logTurnstile(request, surface, "FAILED", result);
    throw new BlockedError("TURNSTILE_FAILED");
  }
  logTurnstile(request, surface, "PASSED", result);
}

/**
 * Hard challenge: the token must be present and valid (when Turnstile is configured).
 *
 * EVERY client must solve it — there is no longer a client type that opts out. The old
 * `X-Client-Type` exemption is closed (see nativeBypassAllowed); it is reachable only by setting
 * TURNSTILE_ALLOW_NATIVE_BYPASS=true as an emergency rollback.
 */
export const requireTurnstile: preHandlerHookHandler = async (request: FastifyRequest) => {
  if (!isTurnstileConfigured() || nativeBypassAllowed(request)) return;
  await challenge(request, "hard");
};

/**
 * Login challenge.
 *
 * Signup and password reset are challenged unconditionally, but login was left with rate limiting
 * only - and credential stuffing is the attack Turnstile is actually for. Challenging every login
 * would put a captcha in front of every user every day, so the challenge arms itself only once an
 * IP+account pair has failed repeatedly: a normal person signing in never sees it, while an
 * attacker walking a password list hits one after their first few misses.
 *
 * Counters live in Redis (already a hard dependency) rather than in process memory, so a backend
 * restart is not a free way to wipe an attacker's failure count.
 */
const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

function loginFailureRedisKey(ip: string, identifier: string): string {
  return `turnstile:loginfail:${ip}:${identifier.trim().toLowerCase()}`;
}

/** Count one failed login for this IP+account pair. Never throws: a Redis blip must not break login. */
export async function noteLoginFailure(ip: string, identifier: string): Promise<void> {
  try {
    const key = loginFailureRedisKey(ip, identifier);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
  } catch {
    /* counter unavailable - the challenge simply stays disarmed */
  }
}

/** A correct password clears the streak, so one fat-fingered morning cannot arm a challenge later. */
export async function clearLoginFailures(ip: string, identifier: string): Promise<void> {
  try {
    await redis.del(loginFailureRedisKey(ip, identifier));
  } catch {
    /* nothing to do */
  }
}

export const requireTurnstileForLogin: preHandlerHookHandler = async (request: FastifyRequest) => {
  if (!isTurnstileConfigured() || nativeBypassAllowed(request)) return;
  const threshold = env.TURNSTILE_LOGIN_FAILURE_THRESHOLD;

  // threshold 0 = unconditional, the same hard gate signup gets. Above zero, only an IP+account
  // pair that has already failed that many times in the window is asked.
  if (threshold > 0) {
    const body = request.body as { emailOrUsername?: string } | undefined;
    const identifier = body?.emailOrUsername;
    if (!identifier) return;

    let failures = 0;
    try {
      failures = Number((await redis.get(loginFailureRedisKey(request.ip, identifier))) ?? 0);
    } catch {
      // Redis down: fail open rather than locking everyone out of login. Rate limiting still applies.
      return;
    }

    if (failures < threshold) return;
  }

  await challenge(request, "login");
};

/**
 * Softer challenge for high-frequency surfaces (posting, messaging): only challenges accounts that
 * look risky — brand new (< 24h) — so established users are never pestered with a captcha while a
 * freshly-minted spam account is. Still a no-op when Turnstile is unconfigured.
 */
const RISKY_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

export const requireTurnstileForRisky: preHandlerHookHandler = async (request: FastifyRequest) => {
  // Same rule as the hard gate: a claimed client type is not a reason to skip the challenge.
  if (!isTurnstileConfigured() || nativeBypassAllowed(request)) return;
  if (!request.userId) return;
  const user = await prisma.user.findUnique({
    where: { id: request.userId },
    select: { createdAt: true },
  });
  const risky = user ? Date.now() - user.createdAt.getTime() < RISKY_ACCOUNT_AGE_MS : true;
  if (!risky) return;
  await challenge(request, "risky");
};
