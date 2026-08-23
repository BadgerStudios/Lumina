import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";

/**
 * Public stats for the marketing site. Mounted under /api/site.
 *
 * Unauthenticated by design — this is the data the landing page shows to anyone. Everything returned
 * is an AGGREGATE: totals and per-country counts, never a row, a name, or anything attributable to a
 * person. A public endpoint that could be walked to enumerate users would be a far bigger problem
 * than a nice map is worth.
 */

/** Country of the request, from Cloudflare's edge header. Cloudflare fronts this deployment, so
 * this is available for free and is accurate at country level without shipping a GeoIP database or
 * calling an external lookup service on every signup. */
export function requestCountry(request: FastifyRequest): string | null {
  const raw = request.headers["cf-ipcountry"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  // "XX" and "T1" are Cloudflare's own placeholders for unknown and Tor.
  if (code.length !== 2 || code === "XX" || code === "T1") return null;
  return code;
}

export default async function siteRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/stats",
    {
      // Public and polled by every visitor's browser, so it gets its own budget rather than
      // sharing the app-wide default.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async () => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [users, onlineNow, newUsers, downloads, recentDownloads, videos, byCountryUsers, byCountryDownloads, recentSignups] =
        await Promise.all([
          prisma.user.count({ where: { isBot: false } }),
          // Live count of people connected right now. Presence is flipped to OFFLINE on socket
          // disconnect (realtime/handlers/presence.ts), so "not OFFLINE" is the set of currently
          // connected humans — bots excluded so the number reads as a community size, not traffic.
          prisma.user.count({ where: { isBot: false, presence: { not: "OFFLINE" } } }),
          prisma.user.count({ where: { isBot: false, createdAt: { gte: weekAgo } } }),
          prisma.appDownload.count(),
          prisma.appDownload.count({ where: { createdAt: { gte: weekAgo } } }),
          prisma.video.count({ where: { status: "APPROVED" } }),
          prisma.user.groupBy({
            by: ["signupCountry"],
            where: { isBot: false, signupCountry: { not: null } },
            _count: { _all: true },
          }),
          prisma.appDownload.groupBy({
            by: ["country"],
            where: { country: { not: null } },
            _count: { _all: true },
          }),
          // Recent signups drive the "new" pulses on the map. Country + rough timestamp only.
          prisma.user.findMany({
            where: { isBot: false, signupCountry: { not: null }, createdAt: { gte: monthAgo } },
            select: { signupCountry: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 200,
          }),
        ]);

      const countries = new Map<string, { users: number; downloads: number; recent: number }>();
      for (const row of byCountryUsers) {
        if (!row.signupCountry) continue;
        countries.set(row.signupCountry, {
          users: row._count._all,
          downloads: 0,
          recent: 0,
        });
      }
      for (const row of byCountryDownloads) {
        if (!row.country) continue;
        const entry = countries.get(row.country) ?? { users: 0, downloads: 0, recent: 0 };
        entry.downloads = row._count._all;
        countries.set(row.country, entry);
      }
      for (const s of recentSignups) {
        if (!s.signupCountry) continue;
        if (s.createdAt < dayAgo) continue;
        const entry = countries.get(s.signupCountry) ?? { users: 0, downloads: 0, recent: 0 };
        entry.recent += 1;
        countries.set(s.signupCountry, entry);
      }

      return {
        // Drives the landing-page status pill. "offline" is intentionally not a value the server
        // can return — a reachable server is by definition not offline; the client renders red only
        // when this request fails outright.
        status: env.SITE_STATUS,
        totals: {
          users,
          onlineNow,
          newUsersThisWeek: newUsers,
          downloads,
          downloadsThisWeek: recentDownloads,
          videos,
        },
        countries: Array.from(countries.entries()).map(([code, v]) => ({ code, ...v })),
        // Stated in the payload so the page can label it accurately rather than implying precision
        // it doesn't have.
        note: "Country-level, approximate. Derived from network location at signup or download.",
      };
    },
  );
}
