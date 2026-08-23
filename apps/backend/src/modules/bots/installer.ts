import { prisma } from "../../db/prisma.js";
import { createApplication } from "../applications/service.js";
import { classify, gatherFacts, lookupDiscordApp } from "./resolver.js";
import type { BotInstallJobData } from "./queue.js";

/** One entry in the live step log the settings screen renders. */
interface Step {
  at: string;
  key: string;
  label: string;
  detail?: string;
  ok: boolean;
}

/**
 * Where the bar sits at the end of each phase. Named phases rather than "step N of 6" because the
 * pipeline genuinely takes different routes — a recipe hit skips the two slowest phases entirely,
 * and a bar that jumped 30 -> 88 with no explanation would read as a stall followed by a glitch.
 */
const PHASES = {
  queued: { pct: 5, label: "Queued" },
  classify: { pct: 18, label: "Reading the link" },
  lookup: { pct: 32, label: "Checking what we already know" },
  metadata: { pct: 58, label: "Working out how it runs" },
  saved: { pct: 72, label: "Saving it for other servers" },
  application: { pct: 90, label: "Preparing the compatibility relay" },
  ready: { pct: 100, label: "Ready" },
} as const;

type PhaseKey = keyof typeof PHASES;

async function pushStep(requestId: string, step: Omit<Step, "at">, phase?: PhaseKey): Promise<void> {
  const row = await prisma.botInstallRequest.findUnique({ where: { id: requestId }, select: { steps: true } });
  const steps = Array.isArray(row?.steps) ? (row!.steps as unknown as Step[]) : [];
  steps.push({ ...step, at: new Date().toISOString() });
  await prisma.botInstallRequest.update({
    where: { id: requestId },
    data: {
      steps: steps as unknown as object,
      // A failure leaves the bar exactly where it stopped — rewinding it to zero would throw away
      // the one piece of information a failed run still carries: how far it got.
      ...(phase ? { progress: PHASES[phase].pct, phase: PHASES[phase].label } : {}),
    },
  });
}

/**
 * The onboarding worker.
 *
 * It is written to be READ, not just run: every branch records a step with a human sentence, so an
 * admin watching the settings screen sees what was recognised, what was inferred and what is
 * missing. A run that ends in FAILED still leaves the evidence of how far it got.
 *
 * The knowledge half is the recipe lookup at the top and the recipe write at the bottom. Resolving
 * "this link is that bot and here is how it runs" is the slow part and it is identical for every
 * server that ever wants the same bot — so it is done once, keyed by a normalised source, and every
 * later worker starts from the answer.
 */
export async function processBotInstall(data: BotInstallJobData): Promise<void> {
  const request = await prisma.botInstallRequest.findUnique({ where: { id: data.requestId } });
  if (!request) return;

  const fail = async (message: string, detail?: string) => {
    await pushStep(request.id, { key: "failed", label: message, detail, ok: false });
    await prisma.botInstallRequest.update({ where: { id: request.id }, data: { status: "FAILED", error: message } });
  };

  try {
    await prisma.botInstallRequest.update({
      where: { id: request.id },
      data: { status: "RESOLVING", progress: PHASES.queued.pct, phase: PHASES.queued.label },
    });

    // ---- 1. What is this link? -------------------------------------------------------------
    let source = classify(request.sourceUrl);
    await pushStep(
      request.id,
      { key: "classify", label: `Recognised the link as ${describeKind(source.kind)}`, detail: source.displayName, ok: true },
      "classify",
    );

    // ---- 2. Has anyone onboarded this before? ----------------------------------------------
    let recipe = await prisma.botRecipe.findUnique({ where: { sourceKey: source.sourceKey } });
    if (recipe) {
      await pushStep(
        request.id,
        {
          key: "recipe-hit",
          label: "Already known — reusing what a previous install worked out",
          detail: `${recipe.displayName}${recipe.verified ? " (verified)" : ""}, used ${recipe.installCount} time(s) before`,
          ok: true,
        },
        // A hit skips resolution entirely, so it lands where "saved" would have.
        "saved",
      );
    } else {
      await pushStep(
        request.id,
        { key: "recipe-miss", label: "First time anyone has asked for this one — working it out", ok: true },
        "lookup",
      );
    }

    // ---- 3. A Discord link carries no code — but it may say where the code lives -----------
    let discordApp: Awaited<ReturnType<typeof lookupDiscordApp>> = null;
    if (!recipe && source.kind === "discord-app") {
      const clientId = source.sourceKey.split(":")[1] ?? "";
      discordApp = clientId ? await lookupDiscordApp(clientId) : null;

      if (discordApp) {
        await pushStep(request.id, {
          key: "discord-app",
          label: `Identified it — ${discordApp.name}${discordApp.verified ? " (verified on Discord)" : ""}`,
          detail: discordApp.repoUrl
            ? `Its published source: ${discordApp.repoUrl}`
            : "Discord publishes no source link for this one.",
          ok: true,
        });
      }

      if (discordApp?.repoUrl) {
        // Resolve against the repository from here on, but keep the recipe keyed by the Discord
        // link so the NEXT person to paste that same link skips all of this.
        source = { ...classify(discordApp.repoUrl), sourceKey: source.sourceKey, displayName: discordApp.name };
      }
    }

    if (!recipe && source.needsSource) {
      const commercial = discordApp?.monetized || discordApp?.verified;
      await fail(
        discordApp ? `${discordApp.name} is closed source` : "That link identifies a bot but doesn't contain it",
        source.kind === "discord-app"
          ? `${
              commercial
                ? `${discordApp!.name} is a ${discordApp!.monetized ? "commercial" : "verified"} Discord bot: it runs on its author's own servers under their token and publishes no source, so there is no copy of it to bring here. Most of the well-known Discord bots are like this.`
                : "This application publishes no source repository, so there is nothing to bring across."
            } What DOES work is a bot you can run yourself — an open-source one. Pick something from the list of bots known to work, or paste a GitHub repository or npm package. If you know where this bot's real source lives, paste that and everyone who pastes this Discord link later gets your answer.`
          : "Paste a GitHub repository or an npm package so the worker has something to work from.",
      );
      return;
    }

    // ---- 4. Learn how it runs ---------------------------------------------------------------
    if (!recipe) {
      await prisma.botInstallRequest.update({ where: { id: request.id }, data: { status: "PREPARING" } });
      const facts = await gatherFacts(source);

      // A repo or package that does not answer at all is a dead end: the recipe would be empty and
      // the application minted for nothing. Say which link failed rather than reporting success.
      // A repo discovered FROM a Discord link is only a guess — the evidence was a terms-of-service
      // URL, and docs-only repos exist precisely to host those. Without a dependency manifest there
      // is no reason to believe it is the bot's source, and claiming READY would mint an
      // application and teach every other server a recipe for something that cannot run.
      if (discordApp?.repoUrl && facts.found !== false && !facts.hasManifest) {
        await fail(
          `Found ${discordApp.name}, but not its source`,
          `Its published GitHub link (${discordApp.repoUrl}) holds only documentation — no dependency manifest, so it is the bot's terms of service rather than its code. This bot looks closed source: it runs on its author's servers and cannot be brought across. If you know where the real source lives, paste that instead and everyone who pastes this Discord link later gets your answer.`,
        );
        return;
      }

      if (facts.found === false) {
        await fail(
          "Couldn't find that repository or package",
          "Nothing answered at that address. Check the spelling, and note that a private repository is not reachable from here.",
        );
        return;
      }

      if (facts.runtime) {
        await pushStep(
          request.id,
          {
            key: "facts",
            label: `Read its public metadata — ${facts.runtime} project`,
            detail: [facts.installCmd, facts.startCmd].filter(Boolean).join("  ·  "),
            ok: true,
          },
          "metadata",
        );
      } else {
        await pushStep(
          request.id,
          {
            key: "facts",
            label: "Couldn't determine how it starts from public metadata",
            detail: "Recorded anyway — the runtime and start command can be filled in and the next install will have them.",
            ok: true,
          },
          "metadata",
        );
      }

      recipe = await prisma.botRecipe.create({
        data: {
          sourceKey: source.sourceKey,
          displayName: facts.displayName ?? source.displayName,
          sourceUrl: request.sourceUrl,
          repoUrl: source.repoUrl ?? discordApp?.repoUrl,
          packageName: source.packageName,
          runtime: facts.runtime,
          installCmd: facts.installCmd,
          startCmd: facts.startCmd,
          tokenEnvVar: facts.tokenEnvVar,
          apiBaseEnvVar: facts.apiBaseEnvVar,
          notes: facts.notes,
        },
      });
      await pushStep(
        request.id,
        { key: "recipe-saved", label: "Saved what it learned so other servers skip this", detail: `Recipe ${recipe.sourceKey}`, ok: true },
        "saved",
      );
    }

    // ---- 5. Mint the Lumina identity the bot will connect as ---------------------------------
    const app = await createApplication({ ownerId: request.requestedById, name: recipe.displayName.slice(0, 60) });
    await pushStep(
      request.id,
      {
        key: "application",
        label: "Prepared the compatibility relay",
        detail: `Bot user @${app.botUsername} — the identity it connects as. Its token is held by whoever runs the bot; Lumina stores only a hash.`,
        ok: true,
      },
      "application",
    );

    await prisma.botRecipe.update({ where: { id: recipe.id }, data: { installCount: { increment: 1 } } });

    await pushStep(request.id, {
      key: "ready",
      label: "Ready to connect",
      detail: recipe.runtime
        ? `Run it with ${recipe.tokenEnvVar ?? "DISCORD_TOKEN"} set to the bot token above and its API base pointed at this server, then approve the install link.`
        : "Approve the install link to add the bot once it is running.",
      ok: true,
    });

    await prisma.botInstallRequest.update({
      where: { id: request.id },
      data: {
        status: "READY",
        recipeId: recipe.id,
        applicationId: app.id,
        progress: PHASES.ready.pct,
        phase: PHASES.ready.label,
      },
    });
  } catch (err) {
    await fail("The worker hit an unexpected error", (err as Error)?.message?.slice(0, 300));
    throw err;
  }
}

function describeKind(kind: string): string {
  switch (kind) {
    case "github":
      return "a GitHub repository";
    case "npm":
      return "an npm package";
    case "discord-app":
      return "a Discord install link";
    case "lumina":
      return "a Lumina application";
    default:
      return "an unrecognised link";
  }
}
