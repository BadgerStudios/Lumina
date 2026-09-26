import type { FastifyInstance } from "fastify";
import { LANGUAGE_CODES, pickAutoLanguage } from "@lumina/shared";
import { NotFoundError } from "../../lib/errors.js";
import { requestCountry } from "../site/routes.js";
import { buildPack, readyLanguages } from "./service.js";

/**
 * Interface translation.
 *
 *   GET /api/i18n/locale       { country, suggested, ready } — the country the request comes from
 *                              (Cloudflare's header) and the language an "auto" person gets from it
 *   GET /api/i18n/pack/:lang   the language pack: English interface text -> that language
 *
 * Open without a session on purpose: the sign-in and sign-up screens are translated too. Neither
 * route translates anything on request — packs are built ahead of time from the app's own text
 * (see service.ts), so there is nothing here for anyone to feed arbitrary text into.
 */
export default async function i18nRoutes(fastify: FastifyInstance) {
  fastify.get("/locale", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const country = requestCountry(request);
    const header = request.headers["accept-language"];
    const tags = typeof header === "string" ? header.split(",").map((part) => part.split(";")[0]!.trim()) : [];
    return { country, suggested: pickAutoLanguage(country, tags), ready: await readyLanguages() };
  });

  fastify.get<{ Params: { lang: string } }>(
    "/pack/:lang",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { lang } = request.params;
      if (!LANGUAGE_CODES.includes(lang)) throw new NotFoundError("No such language");
      const pack = await buildPack(lang);
      // A complete pack only changes with a deploy (new version), so a browser may keep it a while;
      // a partial one is still filling in, so it must be asked for again.
      reply.header("cache-control", pack.complete ? "public, max-age=3600" : "no-store");
      return pack;
    },
  );
}
