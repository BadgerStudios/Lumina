/**
 * Developer portal documentation — structured content, rendered by DevPortalRoute.
 *
 * Everything documented here is the REAL, live API: every path, header, and payload shape was
 * written against the current backend modules, not aspirationally. The generated Swagger UI at
 * /api/docs remains the exhaustive per-route reference; these pages are the curated guides that
 * explain how the pieces fit.
 */

export interface DocBlock {
  kind: "p" | "code" | "h2" | "note" | "table";
  text?: string;
  lang?: string;
  rows?: string[][];
  header?: string[];
}

export interface DocPage {
  id: string;
  title: string;
  nav: string;
  blocks: DocBlock[];
}

const p = (text: string): DocBlock => ({ kind: "p", text });
const h2 = (text: string): DocBlock => ({ kind: "h2", text });
const note = (text: string): DocBlock => ({ kind: "note", text });
const code = (text: string, lang = "bash"): DocBlock => ({ kind: "code", text, lang });
const table = (header: string[], rows: string[][]): DocBlock => ({ kind: "table", header, rows });

export const DOC_PAGES: DocPage[] = [
  {
    id: "getting-started",
    title: "Getting started",
    nav: "Getting started",
    blocks: [
      p("Lumina's platform lets you build bots, OAuth2 integrations, embedded Activities, server add-ons, and game integrations against the same API the official clients use. There is no separate 'partner API' — what the app can do, you can do."),
      h2("1. Create an application"),
      p("Head to Your Applications (left sidebar) and create one. Every application gets a bot account — a real user that servers can invite, give roles to, and moderate exactly like a person — plus OAuth2 credentials for sign-in-with-Lumina integrations."),
      note("Your bot token is shown exactly once at creation (and once on each regeneration). Only its hash is stored server-side. Treat it like a password: anyone holding it IS your bot."),
      h2("2. Invite your bot to a server"),
      p("A bot joins through a normal server invite, used while authenticated as the bot. Server owners can also use your application's client id with the OAuth2 bot flow. Once in, the bot's abilities are governed by the same role/permission system as everyone else — there is no bot-specific power."),
      h2("3. Say something"),
      code(`curl -X POST https://lumina.badgerstudios.net/api/channels/CHANNEL_ID/messages \\
  -H "Authorization: Bot YOUR_BOT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Hello from my first bot!"}'`),
      p("That's the whole loop: the REST API for actions, and the realtime socket (or polling) for hearing things. The rest of these pages cover each surface in depth."),
    ],
  },
  {
    id: "authentication",
    title: "Authentication & OAuth2",
    nav: "Authentication",
    blocks: [
      h2("Bot tokens"),
      p("Bots authenticate every REST call with the Authorization header, using the Bot prefix. Plain 'Bearer' also works for bot tokens; the prefix exists so code reads unambiguously."),
      code(`Authorization: Bot YOUR_BOT_TOKEN`),
      h2("OAuth2 (Sign in with Lumina)"),
      p("Standard authorization-code flow. Configure redirect URIs on your application, then send users to the authorize page:"),
      code(`https://lumina.badgerstudios.net/oauth2/authorize?client_id=CLIENT_ID&redirect_uri=https://yourapp.example/callback&response_type=code&scope=identify`),
      p("Exchange the code server-side (never in a browser — your client secret must not ship to one):"),
      code(`curl -X POST https://lumina.badgerstudios.net/api/oauth2/token \\
  -d grant_type=authorization_code -d code=CODE \\
  -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \\
  -d redirect_uri=https://yourapp.example/callback`),
      table(["Scope", "Grants"], [
        ["identify", "The user's id, username, display name, and avatar"],
        ["email", "The user's email address"],
        ["servers", "The list of servers the user is in"],
      ]),
      note("Access tokens are short-lived. Refresh with grant_type=refresh_token at the same endpoint. Redirect URIs are exact-match — a mismatch is rejected, not partially matched."),
    ],
  },
  {
    id: "rest",
    title: "REST API",
    nav: "REST API",
    blocks: [
      p("Base URL: https://lumina.badgerstudios.net/api — JSON in, JSON out. IDs are opaque strings (message and video ids are numeric strings; treat all ids as opaque). Errors return { error, code? } with a meaningful HTTP status."),
      note("The complete, always-current route reference lives in the generated Swagger UI at /api/docs. This page covers the conventions and the resources bots touch most."),
      h2("Conventions"),
      table(["Convention", "Detail"], [
        ["Pagination", "Cursor-based: pass ?before=<id> on list endpoints; results are newest-first"],
        ["Rate limits", "Per-route budgets; 429 responses carry a retry hint. Respect them — they exist for everyone's latency"],
        ["Idempotency", "Mutating money/registration endpoints accept natural idempotency (session/invoice ids); ordinary posts are not deduplicated"],
        ["Permissions", "Server actions are checked against the bot's roles + channel overwrites, identically to human members"],
      ]),
      h2("The resources you'll use most"),
      table(["Resource", "Endpoints"], [
        ["Messages", "GET/POST /channels/:id/messages · PATCH/DELETE /messages/:id · POST /messages/:id/reactions"],
        ["Channels", "GET /servers/:id/channels · POST /servers/:id/channels · PATCH /channels/:id"],
        ["Members & roles", "GET /servers/:id/members · PUT /servers/:id/members/:userId/roles/:roleId"],
        ["Threads", "POST /channels/:id/threads · everything else is just a channel"],
        ["Events", "GET/POST /servers/:id/events · PUT /servers/:id/events/:eventId/rsvp"],
        ["Webhooks", "POST /channels/:id/webhooks · POST /webhooks/:id/:token (execute, no auth header needed)"],
        ["Interactions", "PUT /interactions/commands · GET /interactions/pending · POST /interactions/:token/respond"],
      ]),
    ],
  },
  {
    id: "realtime",
    title: "Realtime events",
    nav: "Realtime",
    blocks: [
      p("Lumina's realtime layer is Socket.IO at the API origin (path /socket.io). Bots connect with their bot token in the auth payload and receive the same events human clients do, for the servers the bot is in."),
      code(`import { io } from "socket.io-client";
const socket = io("https://lumina.badgerstudios.net", {
  path: "/socket.io",
  auth: (cb) => cb({ accessToken: process.env.BOT_TOKEN }),
});
socket.on("message:new", (message) => {
  if (message.content === "!ping") {
    // reply over REST
  }
});`, "js"),
      h2("Events worth knowing"),
      table(["Event", "Fires when"], [
        ["message:new / message:update / message:delete", "A message is posted, edited, or removed in a channel the bot can see"],
        ["reaction:add / reaction:remove", "Reactions change"],
        ["member:join / member:leave", "Server membership changes"],
        ["interaction:create", "Someone uses one of your slash commands or components — respond within the window or it fails visibly"],
        ["voice:roster-update", "Voice channel occupancy or Go Live state changes"],
        ["server:update / channel:*, role:*", "Structure changes"],
      ]),
      note("Prefer the socket for anything interactive. If your bot can't hold a connection, GET /interactions/pending polls the same interaction queue."),
    ],
  },
  {
    id: "slash-commands",
    title: "Slash commands & components",
    nav: "Slash commands",
    blocks: [
      p("Commands are registered BY the bot, authenticated as itself — a bulk overwrite of the full set, so what you register is exactly what exists (no drift):"),
      code(`curl -X PUT https://lumina.badgerstudios.net/api/interactions/commands \\
  -H "Authorization: Bot YOUR_BOT_TOKEN" -H "Content-Type: application/json" \\
  -d '[{"name": "roll", "description": "Roll a die", "options": [{"name": "sides", "type": "integer", "required": false}]}]'`),
      p("When someone runs /roll, the bot's socket receives interaction:create (or it appears in GET /interactions/pending). Respond with the interaction token:"),
      code(`curl -X POST https://lumina.badgerstudios.net/api/interactions/INTERACTION_TOKEN/respond \\
  -H "Content-Type: application/json" \\
  -d '{"content": "You rolled a 17!"}'`),
      h2("Message components"),
      p("Messages you post can carry a components tree (buttons, selects). Component clicks arrive as interactions with your customId, and are answered through the same respond endpoint."),
      note("Respond fast. Interactions time out after a short window and the user sees the failure — better an instant acknowledgement you edit later than a perfect answer that arrives too late."),
      p("Migrating from Discord? You don't need to rewrite registration: discord.js's REST.put(Routes.applicationCommands(...)) works unchanged through the compat layer, numeric option types included — see the Discord compat page."),
    ],
  },
  {
    id: "webhooks",
    title: "Webhooks",
    nav: "Webhooks",
    blocks: [
      p("Webhooks post into one channel without a bot account. Create one (needs Manage Webhooks in that server), then execute it from anywhere — CI, a cron job, a game server — with no auth header, because the token in the URL is the secret:"),
      code(`curl -X POST https://lumina.badgerstudios.net/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Build #412 passed ✅", "username": "CI"}'`),
      note("A webhook URL is a capability: anyone holding it can post as that webhook. Rotate it from channel settings if it leaks."),
    ],
  },
  {
    id: "activities",
    title: "Activities (embedded apps)",
    nav: "Activities",
    blocks: [
      p("Activities are your web apps embedded inside Lumina channels — the equivalent of Discord Activities. Register an https URL on your application (Your Applications → Activities), and members can launch it in a sandboxed iframe."),
      h2("The embed contract"),
      p("Your page runs sandboxed with no Lumina credentials. Communication is postMessage, always targeted at your activity's own origin — Lumina sends a context message on load with the channel and launching user's public identity, and your page can request layout changes."),
      code(`window.addEventListener("message", (e) => {
  // e.origin is the Lumina origin; e.data.type === "lumina:context"
  const { channelId, user } = e.data;
});`, "js"),
      note("https only, no token in the handshake by design: an Activity is untrusted content. Anything privileged must round-trip through YOUR backend using OAuth2."),
    ],
  },
  {
    id: "addons",
    title: "Server add-ons",
    nav: "Add-ons",
    blocks: [
      p("Add-ons are server-side extensions server owners install from the add-on directory: reactive automations that subscribe to server events (message:new, reaction:add, member:join…) and act through a scoped API."),
      p("They're published with the Lumina CLI from a manifest + handler bundle. The full add-on development guide, manifest schema, and publishing flow:"),
      code(`npm i -g @lumina/cli
lumina addon init my-addon
lumina addon publish   # publishes to the directory, pending review`),
      note("Add-ons run with the permissions the installing server grants them — never more. The manifest declares every event subscribed and every capability used, and that declaration is what the server owner approves."),
    ],
  },
  {
    id: "game-api",
    title: "Game integrations",
    nav: "Game API",
    blocks: [
      p("Lumina ships first-class Minecraft integration your tooling can build on: identity linking (claimed and plugin-verified), live server status on server cards, and a plugin API for presence."),
      h2("Verify a player from your plugin"),
      code(`POST /api/game/minecraft/verify
Authorization: Bot YOUR_BOT_TOKEN
{ "code": "CODE_THE_PLAYER_TYPED", "uuid": "player-uuid-your-server-witnessed" }`),
      p("The code comes from the player's Lumina profile; your server witnessing the UUID is what upgrades a claimed link to a verified one."),
      h2("Server status"),
      p("Set a Minecraft host on your Lumina server (Settings → Community) and the server card shows live player counts — Lumina pings the host directly via Server List Ping; no plugin needed for that part."),
    ],
  },
  {
    id: "discord-compat",
    title: "Discord bot compatibility",
    nav: "Discord compat",
    blocks: [
      p("Lumina speaks enough of the Discord bot protocol that many existing Discord bots run against it with a one-line change: point the library at Lumina's compat endpoint and use your Lumina bot token."),
      code(`// discord.js v14 — the complete diff from a Discord deployment is the token and this line:
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { api: "https://lumina.badgerstudios.net/discord/api" },
});
client.login(process.env.LUMINA_BOT_TOKEN);
// No ws override needed: the library discovers the gateway from GET /gateway/bot, same as on Discord.`, "js"),
      note("Tested against real, unmodified discord.js v14.27 — not just our own protocol suite. Message bots (messageCreate → channel.send / msg.reply, with author.bot flagged correctly for the classic self-ignore guard) and a canonical slash-command bot (SlashCommandBuilder → REST.put(Routes.applicationCommands) → interactionCreate → interaction.reply, with typed options arriving through getString()) both run unchanged."),
      h2("What's implemented"),
      table(["Surface", "Coverage"], [
        ["Gateway", "hello, identify, heartbeat/ack, resume-as-reconnect; dispatches READY, GUILD_CREATE, MESSAGE_CREATE, MESSAGE_UPDATE, MESSAGE_DELETE, INTERACTION_CREATE (with the entitlements/context fields discord.js ≥14.2x requires)"],
        ["REST", "messages (create/edit/delete/reactions, reply via message_reference), channels (list/fetch), guilds (fetch, members, roles), users (@me, fetch), applications/@me"],
        ["Slash commands", "PUT/GET /applications/:id/commands — Discord's numeric option types translate onto Lumina's command registry; interaction callbacks (type 4 respond, 5/6 acknowledged) via /interactions/:id/:token/callback"],
        ["Objects", "Discord-shaped guild/channel/message/user/interaction JSON. Ids are numeric snowflake-style strings minted stably per entity (BigInt-safe — libraries do id arithmetic), message ids are Lumina's own"],
      ]),
      h2("Behavioral notes"),
      table(["Topic", "Detail"], [
        ["Command scope", "Commands are global per application, visible in servers the bot has joined. Guild-scoped registration (Routes.applicationGuildCommands) is not implemented and 404s"],
        ["Interaction window", "Respond promptly — Lumina's interaction timeout is a few seconds, like Discord's. Deferred callbacks (type 5) are acknowledged with a placeholder"],
        ["Own messages", "Your bot's sends echo back as MESSAGE_CREATE dispatches, matching Discord — keep the standard author.bot guard"],
        ["Permissions", "The bot sees and does exactly what its Lumina roles allow. There is no separate intent gatekeeping; intents are accepted and ignored"],
      ]),
      h2("What's deliberately not"),
      p("Voice (Discord's UDP voice protocol is not implemented — use Lumina's own voice), sharding (shard 0 of 1 is always accepted; self-hosted scale doesn't need more), embeds-only messages (content is required), and guild-scoped commands (above)."),
      note("This layer is a bridge, not an emulator: complex bots exercising exotic endpoints will hit gaps. The gateway rejects what it doesn't support with a clear close code, and unknown REST snowflakes answer 404 — never a silent hang."),
    ],
  },
];

export const NAV_SECTIONS: { label: string; ids: string[] }[] = [
  { label: "Guides", ids: ["getting-started", "authentication", "rest", "realtime"] },
  { label: "Surfaces", ids: ["slash-commands", "webhooks", "activities", "addons", "game-api"] },
  { label: "Migration", ids: ["discord-compat"] },
];
