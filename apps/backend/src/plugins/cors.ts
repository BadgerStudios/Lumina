import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { env } from "../config/env.js";

export default fp(async (fastify) => {
  const origins = env.CORS_ORIGIN.split(",").map((s) => s.trim());
  await fastify.register(cors, {
    origin: origins,
    credentials: true,
    // The PQ transport marks a sealed response with a custom `x-pq: 1` header, and the client
    // decides whether to UNSEAL by reading it (lib/apiClient.ts). Cross-origin JS can only read
    // CORS-safelisted response headers plus whatever is named here — so without this line the
    // header was invisible to every cross-origin client (the Android/desktop WebViews, whose
    // origin is https://localhost / app://bundle), while the same-origin web app read it fine.
    // Those clients then fed raw ciphertext to res.json() and every sealed call failed with an
    // unexplained parse error — the owner app's "Login failed" with a clean 200 in the server
    // log was exactly this. Reproduced in an emulator and fixed by this line alone.
    exposedHeaders: ["x-pq"],
  });
});
