import { prisma } from "../../db/prisma.js";

/**
 * A starting catalog of bots that can actually run here.
 *
 * This exists because of a design failure worth naming: the onboarding panel is a paste box, and
 * the links people reach for are the popular Discord bots — Dank Memer, MEE6, Melpo. Essentially
 * all of those are commercial and closed source. They run on their authors' servers under their
 * authors' tokens, so no amount of compatibility work reaches them, and a box that invites those
 * links and then refuses them is a box that mostly fails.
 *
 * So the panel offers these as well: sources that were checked to resolve, marked verified so they
 * sort to the top of the shared catalog. `verified` here means "the source resolves and the recipe
 * is real", NOT "someone has run this bot end to end on Lumina" — the two entries the compat page
 * reports as tested unmodified against Lumina say so in their notes.
 */
interface SeedRecipe {
  sourceKey: string;
  displayName: string;
  sourceUrl: string;
  repoUrl?: string;
  packageName?: string;
  runtime: string;
  installCmd: string;
  startCmd: string;
  notes: string;
}

const SEEDS: SeedRecipe[] = [
  {
    sourceKey: "npm:discord-tictactoe",
    displayName: "Discord TicTacToe",
    sourceUrl: "discord-tictactoe",
    packageName: "discord-tictactoe",
    runtime: "node",
    installCmd: "npm install discord-tictactoe",
    startCmd: "npx tictactoe",
    notes: "Button-grid game bot. Reported on the Discord-compat page as running unmodified against Lumina — board posted, moves played from Lumina's native UI.",
  },
  {
    sourceKey: "npm:discord-giveaways",
    displayName: "Discord Giveaways",
    sourceUrl: "discord-giveaways",
    packageName: "discord-giveaways",
    runtime: "node",
    installCmd: "npm install discord-giveaways",
    startCmd: "node index.js",
    notes: "Giveaway framework. Reported on the Discord-compat page as running unmodified against Lumina — native users entered by reacting and a winner was drawn.",
  },
  {
    sourceKey: "github:cog-creators/red-discordbot",
    displayName: "Red-DiscordBot",
    sourceUrl: "https://github.com/Cog-Creators/Red-DiscordBot",
    repoUrl: "https://github.com/Cog-Creators/Red-DiscordBot",
    runtime: "python",
    installCmd: "pip install Red-DiscordBot",
    startCmd: "redbot <instance-name>",
    notes: "Large self-hosted, modular bot (music, moderation, custom cogs). Python. Untested against Lumina's compat layer — expect to report gaps.",
  },
  {
    sourceKey: "npm:distube",
    displayName: "DisTube",
    sourceUrl: "distube",
    packageName: "distube",
    runtime: "node",
    installCmd: "npm install distube",
    startCmd: "node index.js",
    notes: "Music framework. Voice is NOT implemented in Lumina's compat layer yet, so playback will not work — listed for when it is.",
  },
];

/**
 * Idempotent, and deliberately create-only: an operator who corrects a start command or flips
 * `verified` must not have it overwritten on the next boot.
 */
export async function seedBotRecipes(): Promise<void> {
  for (const seed of SEEDS) {
    await prisma.botRecipe.upsert({
      where: { sourceKey: seed.sourceKey },
      create: { ...seed, verified: true },
      update: {},
    });
  }
}
