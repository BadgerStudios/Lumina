import type { FastifyInstance, FastifyRequest } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";

/**
 * Prometheus metrics.
 *
 * Until this existed the entire observability surface was `GET /healthz` returning `{status:"ok"}`,
 * which proves one thing: the process is running. It cannot distinguish a healthy instance from one
 * where every request is 500ing, the event loop is blocked, memory is climbing toward the 768MB
 * limit, or the transcode queue has been stuck for an hour. Every real problem this deployment has
 * had was found by someone reporting it or by reading logs by hand afterwards.
 *
 * ## Access
 *
 * `/metrics` is NOT public. It exposes route-level traffic shape, user counts and queue depth —
 * nothing secret, but it is exactly the kind of free reconnaissance the OpenAPI spec was trimmed to
 * avoid publishing. It is served only to callers on the Docker network or holding METRICS_TOKEN,
 * and nginx does not proxy it at all, so the public hostname has no path to it either. Two
 * independent barriers, because a single one that silently stops working is how these get exposed.
 *
 * ## Cardinality
 *
 * Route labels use the Fastify route *pattern* (`/api/channels/:id/messages`), never the resolved
 * URL. Labelling by resolved path would mint a new time series per channel id, which is the
 * classic way to make a Prometheus server run out of memory.
 */

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "lumina_" });

const httpRequests = new Counter({
  name: "lumina_http_requests_total",
  help: "HTTP requests by route pattern, method and status class",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: "lumina_http_request_duration_seconds",
  help: "HTTP request duration by route pattern",
  labelNames: ["method", "route"] as const,
  // Bucketed around what actually matters here: sub-100ms is "fine", the interesting questions are
  // how much traffic crosses 250ms and how much crosses a second.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const socketConnections = new Gauge({
  name: "lumina_socket_connections",
  help: "Currently connected Socket.IO clients on this instance",
  registers: [registry],
});

/**
 * Business-level gauges, refreshed on scrape rather than continuously.
 *
 * Deliberately a small set of cheap COUNTs on indexed columns. It is tempting to expose far more,
 * and the reason not to is that every gauge here becomes a query that runs on every scrape forever
 * — a metrics endpoint that makes the database slower is a strange thing to add for the sake of
 * watching the database.
 */
const gauges = {
  users: new Gauge({ name: "lumina_users_total", help: "Registered, non-bot users", registers: [registry] }),
  servers: new Gauge({ name: "lumina_servers_total", help: "Servers", registers: [registry] }),
  videosPendingReview: new Gauge({
    name: "lumina_videos_pending_review",
    help: "Videos waiting on a staff decision",
    registers: [registry],
  }),
  videosProcessing: new Gauge({
    name: "lumina_videos_processing",
    help: "Videos mid-transcode — a number that only ever climbs means the worker is stuck",
    registers: [registry],
  }),
  openReports: new Gauge({ name: "lumina_reports_open", help: "Unresolved report tickets", registers: [registry] }),
  linkPreviewsPending: new Gauge({
    name: "lumina_link_previews_pending",
    help: "Link previews queued but not yet fetched",
    registers: [registry],
  }),
};

/** Called from the Socket.IO connection/disconnect handlers. */
export function setSocketConnections(n: number): void {
  socketConnections.set(n);
}

export function registerMetricsHooks(fastify: FastifyInstance): void {
  fastify.addHook("onResponse", async (request, reply) => {
    // The route PATTERN, not the URL — see the cardinality note above. Requests that matched no
    // route (404s on random paths) all collapse into one series rather than one per probe.
    const route = request.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    const labels = { method: request.method, route };
    httpRequests.inc({ ...labels, status: `${Math.floor(reply.statusCode / 100)}xx` });
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });
}

async function refreshGauges(): Promise<void> {
  const [users, servers, pendingReview, processing, openReports, previewsPending] = await Promise.all([
    prisma.user.count({ where: { isBot: false } }),
    prisma.server.count(),
    prisma.video.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.video.count({ where: { status: "PROCESSING" } }),
    prisma.videoReport.count({ where: { status: "OPEN" } }),
    prisma.linkPreview.count({ where: { status: "PENDING" } }),
  ]);
  gauges.users.set(users);
  gauges.servers.set(servers);
  gauges.videosPendingReview.set(pendingReview);
  gauges.videosProcessing.set(processing);
  gauges.openReports.set(openReports);
  gauges.linkPreviewsPending.set(previewsPending);
}

/**
 * Private-network check.
 *
 * Prometheus (or any operator tool) scraping from inside the compose network arrives with a
 * private source address. Anything from outside must present the token instead. `request.ip`
 * honours trustProxy, which is correct here: the whole reason CF-Connecting-IP is trustworthy on
 * this deployment is that no public listener reaches the origin except through Cloudflare — the
 * same property that makes a private `request.ip` meaningful.
 */
function isLocalScrape(request: FastifyRequest): boolean {
  const ip = request.ip;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("172.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("::ffff:172.") ||
    ip.startsWith("::ffff:10.") ||
    ip.startsWith("::ffff:192.168.")
  );
}

export function registerMetricsRoute(fastify: FastifyInstance): void {
  fastify.get("/metrics", async (request, reply) => {
    const token = env.METRICS_TOKEN;
    const presented = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    // Token check first: an operator who set one can scrape from anywhere, and someone on the
    // Docker network is already inside the trust boundary.
    const authorized = (token && presented === token) || isLocalScrape(request);
    if (!authorized) {
      // 404, not 403. A 403 confirms the endpoint exists and is worth coming back to.
      reply.code(404);
      return { error: "Not found" };
    }

    await refreshGauges().catch(() => {
      // A database hiccup must not make the metrics endpoint fail — the process metrics are still
      // worth serving, and a monitoring endpoint that goes down with its dependencies is the
      // opposite of useful.
    });

    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
