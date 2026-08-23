import { JSON_FETCH, safeFetch } from "../../lib/safeFetch.js";

/**
 * Turning a pasted link into something a worker can act on.
 *
 * Four shapes arrive in practice, and only three of them carry any code:
 *
 *  - a Discord install link (`discord.com/oauth2/authorize?client_id=...`) identifies a bot but
 *    contains nothing runnable. The bot itself is a process on somebody else's servers holding
 *    somebody else's Discord token; there is no mechanism by which that process could be pointed
 *    here. What the link IS good for is identity: once a human has said "app 1234 is this repo",
 *    that mapping is worth keeping forever, which is exactly what the recipe table is for.
 *  - a GitHub repo, or an npm package: runnable, and the metadata says how.
 *  - a Lumina install link: already one of ours, nothing to resolve.
 */

export type SourceKind = "discord-app" | "github" | "npm" | "lumina" | "unknown";

export interface ResolvedSource {
  kind: SourceKind;
  /** Stable identity used as BotRecipe.sourceKey — the thing that makes a repeat install instant. */
  sourceKey: string;
  displayName: string;
  repoUrl?: string;
  packageName?: string;
  /** Set when the link cannot lead to code on its own. */
  needsSource?: boolean;
}

const DISCORD_HOSTS = new Set(["discord.com", "www.discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

export function classify(raw: string): ResolvedSource {
  const trimmed = raw.trim();

  // A bare npm package name, which is how people usually refer to a bot they found.
  if (/^[@a-z0-9][\w./-]*$/i.test(trimmed) && !trimmed.includes("://") && !trimmed.includes(" ")) {
    return { kind: "npm", sourceKey: `npm:${trimmed.toLowerCase()}`, displayName: trimmed, packageName: trimmed };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: "unknown", sourceKey: `raw:${trimmed.toLowerCase()}`, displayName: trimmed, needsSource: true };
  }

  const host = url.hostname.toLowerCase();

  if (DISCORD_HOSTS.has(host)) {
    const clientId = url.searchParams.get("client_id") ?? url.searchParams.get("application_id");
    return {
      kind: "discord-app",
      sourceKey: clientId ? `discord-app:${clientId}` : `discord-link:${url.pathname}`,
      displayName: clientId ? `Discord application ${clientId}` : "Discord application",
      needsSource: true,
    };
  }

  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo] = url.pathname.replace(/^\/+/, "").split("/");
    if (owner && repo) {
      const clean = repo.replace(/\.git$/, "");
      return {
        kind: "github",
        sourceKey: `github:${owner.toLowerCase()}/${clean.toLowerCase()}`,
        displayName: `${owner}/${clean}`,
        repoUrl: `https://github.com/${owner}/${clean}`,
      };
    }
  }

  if (host === "npmjs.com" || host === "www.npmjs.com") {
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    const idx = parts.indexOf("package");
    const name = idx >= 0 ? parts.slice(idx + 1).join("/") : "";
    if (name) return { kind: "npm", sourceKey: `npm:${name.toLowerCase()}`, displayName: name, packageName: name };
  }

  // One of ours: /oauth2/authorize?client_id=...&scope=bot on a Lumina origin.
  if (url.pathname.startsWith("/oauth2/authorize") && url.searchParams.get("scope") === "bot") {
    const clientId = url.searchParams.get("client_id") ?? "";
    return { kind: "lumina", sourceKey: `lumina:${clientId}`, displayName: "Lumina application" };
  }

  return { kind: "unknown", sourceKey: `url:${url.origin}${url.pathname}`.toLowerCase(), displayName: url.hostname, needsSource: true };
}

export interface DiscordAppInfo {
  name: string;
  description?: string;
  verified?: boolean;
  /** Discord reports the application sells things. A monetized bot is a product running on its
   * author's infrastructure; there is no version of it to bring across. */
  monetized?: boolean;
  /** A source repository found in the application's own public metadata, if it published one. */
  repoUrl?: string;
}

/**
 * What Discord will tell anyone about an application, with no token and no authentication:
 * GET /api/v10/applications/:id/rpc is public.
 *
 * This does NOT make the bot portable — it is still a process on someone else's servers. What it
 * does is turn "paste its source instead" from a demand into something the worker can often answer
 * itself: a large share of bots put their repository in the terms-of-service or privacy-policy URL
 * (both are required fields for a verified bot), or link it in the description. When one is found,
 * the Discord link resolves to a real repo and the mapping is worth saving forever.
 */
export async function lookupDiscordApp(clientId: string): Promise<DiscordAppInfo | null> {
  const res = await safeFetch(`https://discord.com/api/v10/applications/${encodeURIComponent(clientId)}/rpc`, BOT_UA, JSON_FETCH);
  if (res.status !== 200 || res.body.length === 0) return null;
  let app: Record<string, unknown>;
  try {
    app = JSON.parse(res.body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof app.name !== "string") return null;

  // Scan the whole document rather than named fields only: authors put the repo in whichever of
  // description / tos / privacy / install URL suits them, and a new field costs nothing here.
  const matches = JSON.stringify(app).match(/https?:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g) ?? [];
  const repo = matches
    .map((m) => m.replace(/\.git$/, ""))
    // Not every github.com link is the bot: skip the ones that are obviously not a repo root.
    .find((m) => !/\/(sponsors|orgs|topics|features|about)\//.test(m));

  return {
    name: app.name,
    description: typeof app.description === "string" ? app.description : undefined,
    verified: app.is_verified === true,
    monetized: app.is_monetized === true,
    repoUrl: repo,
  };
}

export interface SourceFacts {
  /** false when the repository/package could not be found at all — a typo, a private repo, or a
   * deleted package. Distinct from "found it but could not work out how it starts", which is a
   * usable outcome; this one is not. */
  found?: boolean;
  /** True when an actual dependency manifest was read. A repo can exist and still contain no code
   * — plenty of closed-source bots publish a docs-only repo purely to host their terms of service,
   * and that link must not be mistaken for the bot's source. */
  hasManifest?: boolean;
  displayName?: string;
  description?: string;
  runtime?: string;
  installCmd?: string;
  startCmd?: string;
  tokenEnvVar?: string;
  apiBaseEnvVar?: string;
  notes?: string;
}

/** Env var names bots conventionally read their token from, most specific first. */
const BOT_UA = "LuminaBot/1.0 (+bot onboarding)";

const TOKEN_ENV_CANDIDATES = ["DISCORD_TOKEN", "BOT_TOKEN", "TOKEN", "DISCORD_BOT_TOKEN", "CLIENT_TOKEN"];

/**
 * Reads whatever the public metadata will tell us about how the thing runs. Deliberately
 * best-effort: a partial recipe that names the runtime and start command still saves the next
 * person most of the work, and a wrong guess is visible in the step log rather than silent.
 *
 * Every fetch goes through safeFetch — these are user-supplied URLs, and the worker sits on the
 * same network as Postgres and Redis.
 */
export async function gatherFacts(source: ResolvedSource): Promise<SourceFacts> {
  if (source.kind === "npm" && source.packageName) {
    // `/latest`, not the package root: the full registry document lists every version ever
    // published and routinely exceeds safeFetch's 256KB cap, which returns an EMPTY body with
    // truncated:true — a 200 that then fails to parse. This one is a few KB.
    const res = await safeFetch(`https://registry.npmjs.org/${encodeURIComponent(source.packageName)}/latest`, BOT_UA, JSON_FETCH);
    if (res.status !== 200 || res.truncated || res.body.length === 0) return { found: false };
    let pkg: { description?: string; scripts?: Record<string, string>; bin?: unknown; main?: string };
    try {
      pkg = JSON.parse(res.body.toString("utf8"));
    } catch {
      return { found: false };
    }
    return {
      found: true,
      hasManifest: true,
      description: pkg.description,
      runtime: "node",
      installCmd: `npm install ${source.packageName}`,
      startCmd: pkg.scripts?.start ?? (pkg.bin ? source.packageName : `node ${pkg.main ?? "index.js"}`),
      tokenEnvVar: TOKEN_ENV_CANDIDATES[0],
      notes: "Runtime and start command inferred from the npm manifest; confirm before trusting.",
    };
  }

  if (source.kind === "github" && source.repoUrl) {
    // found stays false until something actually answers — otherwise a typo'd repo sails through
    // to READY with an empty recipe and an application minted for a bot that does not exist.
    const facts: SourceFacts = { found: false };
    let raw = source.repoUrl.replace("github.com", "raw.githubusercontent.com");

    const meta = await safeFetch(source.repoUrl.replace("https://github.com/", "https://api.github.com/repos/"), BOT_UA, JSON_FETCH);
    let branches = ["main", "master"];
    if (meta.status === 200 && meta.body.length > 0) {
      try {
        const repo = JSON.parse(meta.body.toString("utf8")) as {
          description?: string;
          language?: string;
          default_branch?: string;
          full_name?: string;
        };
        facts.found = true;
        facts.description = repo.description;
        if (repo.language) facts.runtime = repo.language.toLowerCase() === "python" ? "python" : "node";
        if (repo.default_branch) branches = [repo.default_branch, ...branches.filter((b) => b !== repo.default_branch)];
        // A renamed repo answers the old path with a 301 to the new one. Raw does NOT follow that,
        // so rebuild the raw base from the canonical name or every manifest fetch 404s.
        if (repo.full_name) raw = `https://raw.githubusercontent.com/${repo.full_name}`;
      } catch {
        /* unparseable metadata — fall through to the raw probes, which also prove existence */
      }
    }

    // Tried independently of the API call above: GitHub's API is rate-limited per IP without a
    // token, and losing the manifest to that would turn a perfectly resolvable repo into an empty
    // recipe. A raw file that answers is also proof the repo exists.
    const PYTHON_MANIFESTS: [string, string][] = [
      ["requirements.txt", "pip install -r requirements.txt"],
      ["pyproject.toml", "pip install ."],
      ["Pipfile", "pipenv install"],
    ];

    outer: for (const branch of branches) {
      const pkgRes = await safeFetch(`${raw}/${branch}/package.json`, BOT_UA, JSON_FETCH);
      if (pkgRes.status === 200 && pkgRes.body.length > 0) {
        facts.found = true;
        try {
          const pkg = JSON.parse(pkgRes.body.toString("utf8")) as { scripts?: Record<string, string>; main?: string; name?: string };
          facts.hasManifest = true;
          facts.runtime = "node";
          facts.installCmd = "npm install";
          facts.startCmd = pkg.scripts?.start ?? `node ${pkg.main ?? "index.js"}`;
          facts.displayName = pkg.name;
        } catch {
          /* not JSON — do not invent a start command from it */
        }
        break;
      }
      for (const [file, install] of PYTHON_MANIFESTS) {
        const res = await safeFetch(`${raw}/${branch}/${file}`, BOT_UA, JSON_FETCH);
        if (res.status === 200) {
          facts.found = true;
          facts.hasManifest = true;
          facts.runtime = "python";
          facts.installCmd = install;
          facts.startCmd = "python bot.py";
          break outer;
        }
      }
    }

    facts.tokenEnvVar = TOKEN_ENV_CANDIDATES[0];
    facts.notes = "Derived from public repository metadata; the start command is a convention, not a promise.";
    return facts;
  }

  return {};
}
