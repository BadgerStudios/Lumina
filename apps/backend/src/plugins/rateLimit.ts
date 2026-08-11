import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";

export default fp(async (fastify) => {
  await fastify.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });
});
