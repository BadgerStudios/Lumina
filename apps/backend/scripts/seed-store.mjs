/**
 * Seeds the store catalogue.
 *
 * Idempotent by `sku` — safe to re-run after a deploy, which matters because this is how the
 * catalogue is edited: change a price or a name here, re-run, done. Items are never deleted, only
 * deactivated, because a withdrawn item still has to resolve for everyone who already owns it.
 *
 * Nothing here takes away something that is currently free. The seven existing themes and five
 * accents stay free forever; the store sells NEW cosmetics alongside them. Removing a free feature
 * to sell it back is the fastest way to make a small community resent a store.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ITEMS = [
  // --- Themes -----------------------------------------------------------------------------------
  {
    sku: "theme.nebula",
    kind: "THEME",
    name: "Nebula",
    description: "Deep violet dark theme with an ion glow. Built from Lumina's own palette.",
    payload: { theme: "nebula" },
    priceCoins: 450,
    sortOrder: 10,
  },
  {
    sku: "theme.ember",
    kind: "THEME",
    name: "Ember",
    description: "Warm charcoal with a low amber burn. Easy on the eyes at 2am.",
    payload: { theme: "ember" },
    priceCoins: 450,
    sortOrder: 11,
  },
  {
    sku: "theme.frost",
    kind: "THEME",
    name: "Frost",
    description: "Pale, high-contrast light theme with a cold blue cast.",
    payload: { theme: "frost" },
    priceCoins: 450,
    sortOrder: 12,
  },

  // --- Accents ----------------------------------------------------------------------------------
  {
    sku: "accent.plasma",
    kind: "ACCENT",
    name: "Plasma accent",
    description: "Magenta-to-violet gradient accent across buttons, links and highlights.",
    payload: { accent: "plasma" },
    priceCoins: 250,
    sortOrder: 20,
  },
  {
    sku: "accent.citrus",
    kind: "ACCENT",
    name: "Citrus accent",
    description: "Bright lime accent. Loud, deliberately.",
    payload: { accent: "citrus" },
    priceCoins: 250,
    sortOrder: 21,
  },

  // --- Profile badges ---------------------------------------------------------------------------
  {
    sku: "badge.founder-circle",
    kind: "BADGE",
    name: "Founder's Circle",
    description: "A badge on your profile and beside your name in chat.",
    payload: { badge: "founder-circle", emoji: "◈" },
    priceCoins: 800,
    sortOrder: 30,
  },
  {
    sku: "badge.night-owl",
    kind: "BADGE",
    name: "Night Owl",
    description: "For the people still posting at 4am.",
    payload: { badge: "night-owl", emoji: "☾" },
    priceCoins: 300,
    sortOrder: 31,
  },

  // --- Profile effects --------------------------------------------------------------------------
  {
    sku: "effect.aurora-banner",
    kind: "PROFILE_EFFECT",
    name: "Aurora banner",
    description: "An animated aurora wash behind your profile header.",
    payload: { effect: "aurora-banner" },
    priceCoins: 1200,
    sortOrder: 40,
  },
];

async function main() {
  let created = 0;
  let updated = 0;

  for (const item of ITEMS) {
    const existing = await prisma.storeItem.findUnique({ where: { sku: item.sku } });
    await prisma.storeItem.upsert({
      where: { sku: item.sku },
      create: item,
      // Deliberately does NOT reset `active`: an item withdrawn by an operator should stay
      // withdrawn across a re-seed, otherwise this script silently un-retires things.
      update: {
        kind: item.kind,
        name: item.name,
        description: item.description,
        payload: item.payload,
        priceCoins: item.priceCoins,
        sortOrder: item.sortOrder,
      },
    });
    if (existing) updated += 1;
    else created += 1;
  }

  const total = await prisma.storeItem.count();
  console.log(`store seed: ${created} created, ${updated} updated, ${total} items total`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
