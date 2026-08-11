import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { env } from "../config/env.js";

export default fp(async (fastify) => {
  const origins = env.CORS_ORIGIN.split(",").map((s) => s.trim());
  await fastify.register(cors, {
    origin: origins,
    credentials: true,
  });
});
