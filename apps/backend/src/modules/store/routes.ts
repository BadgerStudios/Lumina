import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { primaryAppOrigin } from "../../lib/appOrigin.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError } from "../../lib/errors.js";
import { getStripe, isBillingConfigured } from "../billing/stripe.js";
import {
  COIN_BUNDLES,
  bundleByKey,
  catalogue,
  getBalance,
  inventory,
  purchase,
} from "./service.js";

const purchaseSchema = z.object({ itemId: z.string().min(1) });
const topUpSchema = z.object({ bundleKey: z.string().min(1) });

/** Mounted under /api/store */
export default async function storeRoutes(fastify: FastifyInstance) {
  fastify.get("/catalogue", { preHandler: [requireAuth] }, async (request) => {
    const [items, balance] = await Promise.all([
      catalogue(request.userId!),
      getBalance(request.userId!),
    ]);
    return {
      items,
      balance,
      // Advertised even when Stripe is unconfigured, with a flag, so the UI can show the shelf and
      // explain why buying is unavailable rather than rendering an empty page that looks broken.
      bundles: COIN_BUNDLES.map((b) => ({ key: b.key, coins: b.coins, label: b.label })),
      topUpAvailable: isBillingConfigured(),
    };
  });

  fastify.get("/inventory", { preHandler: [requireAuth] }, async (request) => ({
    items: await inventory(request.userId!),
    balance: await getBalance(request.userId!),
  }));

  fastify.post(
    "/purchase",
    {
      preHandler: [requireAuth],
      schema: { body: purchaseSchema },
      // Spending is cheap to attempt and idempotent by constraint, but a tight limit keeps a
      // runaway client from hammering a transaction that touches the ledger.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { itemId } = request.body as z.infer<typeof purchaseSchema>;
      const result = await purchase(request.userId!, itemId);
      return {
        purchased: true,
        sku: result.item.sku,
        balance: result.balance,
      };
    },
  );

  /**
   * Starts a Stripe Checkout session for a coin bundle.
   *
   * The coins are NOT credited here — only when the webhook confirms payment. Crediting on redirect
   * would hand sparks to anyone who can guess the success URL.
   */
  fastify.post(
    "/top-up",
    { preHandler: [requireAuth], schema: { body: topUpSchema } },
    async (request) => {
      if (!isBillingConfigured()) {
        throw new BadRequestError("Payments aren't configured on this server yet");
      }
      const { bundleKey } = request.body as z.infer<typeof topUpSchema>;
      const bundle = bundleByKey(bundleKey);
      if (!bundle) throw new BadRequestError("No such bundle");

      const priceId = process.env[bundle.priceEnvVar]?.trim();
      if (!priceId) {
        throw new BadRequestError(`No Stripe price configured for the ${bundle.label} bundle`);
      }

      const stripe = getStripe();
      // isBillingConfigured() above already implies this, but getStripe() is independently nullable
      // and a non-null assertion here would be a lie the day those two disagree.
      if (!stripe) throw new BadRequestError("Payments aren't configured on this server yet");

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${primaryAppOrigin()}/store?topup=success`,
        cancel_url: `${primaryAppOrigin()}/store?topup=cancelled`,
        // Carried through to the webhook, which is the only place coins are actually granted.
        metadata: { userId: request.userId!, bundleKey: bundle.key, coins: String(bundle.coins) },
      });

      return { url: session.url };
    },
  );
}
