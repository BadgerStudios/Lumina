import fp from "fastify-plugin";
import multipart from "@fastify/multipart";
import { env } from "../config/env.js";

export default fp(async (fastify) => {
  // Registered at the PREMIUM ceiling, not the free one. This plugin is configured once at
  // boot and cannot vary per request, so a limit of MAX_UPLOAD_MB here would truncate a
  // subscriber's upload at the socket before any code could check who they are. The free limit
  // is enforced per request against the actual sender — see modules/messages/multipart.ts.
  await fastify.register(multipart, {
    limits: { fileSize: env.PREMIUM_MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  });
});
