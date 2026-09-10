import fp from "fastify-plugin";
import multipart from "@fastify/multipart";
import { env } from "../config/env.js";

export default fp(async (fastify) => {
  // The DEFAULT ceiling, inherited by every upload path that does not set its own — avatars,
  // server icons and banners, stickers and custom emoji all rely on it. It stays at the free
  // limit deliberately: raising it here to accommodate Premium raised it for all of those too,
  // and a 100MB avatar is nobody's idea of a subscriber perk.
  //
  // Premium's larger attachment is granted per request instead, by the one path that knows who
  // is sending — see modules/messages/multipart.ts.
  await fastify.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  });
});
