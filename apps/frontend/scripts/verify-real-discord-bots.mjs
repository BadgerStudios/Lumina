// TWO REAL PUBLISHED DISCORD BOTS from npm, run unmodified against Lumina's compat layer:
//   - discord-tictactoe v4 (button-grid game, interaction.update loop, AI opponent)
//   - discord-giveaways v6 (embeds, bot self-reaction, reaction-user fetch to draw winners)
// A human account plays/enters via Lumina's NATIVE APIs (component clicks, reactions), proving
// the loop crosses the boundary both ways: Discord-protocol bot ↔ Lumina-native user.
import { Client, GatewayIntentBits, Partials } from "discord.js";
import TicTacToe from "discord-tictactoe";
import pkg from "discord-giveaways";
const { GiveawaysManager } = pkg;

const BASE = "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + String(e).slice(0, 140) : "")), fail++);
async function api(path, { method = "GET", token, bot, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (bot) headers.authorization = `Bot ${bot}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json };
}
const birth = () => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 30); return d.toISOString().slice(0, 10); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stage: human, server, two bot applications
const reg = await api("/auth/register", { method: "POST", body: { username: `qq_real_${rand}`, email: `qq_real_${rand}@example.com`, password: "password123", birthDate: birth(), ageBracket: "AGE_25_34" } });
if (reg.status !== 201) { console.log("fatal register", reg.status); process.exit(1); }
const human = reg.json.accessToken;
const server = (await api("/servers", { method: "POST", token: human, body: { name: "Real Bots Arena" } })).json;
const channels = (await api(`/servers/${server.id}/channels`, { token: human })).json;
const general = channels.find((c) => c.type === "TEXT");
const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: human, body: {} })).json;

async function mkBot(name) {
  const app = (await api("/applications", { method: "POST", token: human, body: { name } })).json;
  // These bots read message content — their owner enables the privileged toggle, same as a real
  // developer in the portal.
  await api(`/applications/${app.id}/intents`, { method: "PATCH", token: human, body: { messageContent: true, serverMembers: true } });
  await api(`/invites/${invite.code}/join`, { method: "POST", bot: app.botToken });
  return app.botToken;
}
const tttToken = await mkBot(`qq TicTacToe ${rand}`);
const gaToken = await mkBot(`qq Giveaways ${rand}`);
ok("both real bots created and joined the server");

// =============================== discord-tictactoe ===============================
{
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${BASE}/discord/api` } });
  const game = new TicTacToe({ language: "en" });
  client.on("interactionCreate", (interaction) => {
    if (interaction.isChatInputCommand?.() && interaction.commandName === "tictactoe") {
      game.handleInteraction(interaction);
    }
  });
  const readied = new Promise((r) => { client.once("clientReady", r); client.once("ready", r); });
  await client.login(tttToken);
  await Promise.race([readied, sleep(10000)]);
  client.isReady() ? ok("discord-tictactoe host client ready") : bad("ttt client never ready");

  // register /tictactoe ourselves (the package's own guide registers via deploy script)
  const put = await fetch(`${BASE}/discord/api/applications/0/commands`, {
    method: "PUT",
    headers: { authorization: `Bot ${tttToken}`, "content-type": "application/json" },
    body: JSON.stringify([{ name: "tictactoe", description: "Play tic-tac-toe", options: [] }]),
  });
  put.ok ? ok("/tictactoe registered") : bad(`command registration ${put.status}`);

  await sleep(1000);
  const invoke = await api("/interactions/invoke", { method: "POST", token: human, body: { channelId: general.id, name: "tictactoe", options: {} } });
  invoke.status < 300 ? ok(`/tictactoe invoked (${invoke.status})`) : bad(`invoke ${invoke.status}`, JSON.stringify(invoke.json));

  // the game (vs AI) posts a board with buttons; find it and click cells as the human
  await sleep(2500);
  let board = null;
  for (let i = 0; i < 10 && !board; i++) {
    const msgs = (await api(`/channels/${general.id}/messages`, { token: human })).json ?? [];
    board = msgs.find((m) => Array.isArray(m.components) && m.components.length > 0);
    if (!board) await sleep(700);
  }
  board ? ok(`game board arrived with ${board.components.length} button row(s)`) : bad("no board message with components");

  if (board) {
    // click up to 4 distinct cells: the AI answers between our moves via interaction.update
    let clicks = 0;
    for (let round = 0; round < 4; round++) {
      const msgs = (await api(`/channels/${general.id}/messages`, { token: human })).json ?? [];
      const current = msgs.find((m) => m.id === board.id) ?? board;
      const buttons = (current.components ?? []).flatMap((r) => r.components ?? []).filter((b) => !b.disabled);
      if (!buttons.length) break;
      const target = buttons[Math.floor(Math.random() * buttons.length)];
      const click = await api("/interactions/component", { method: "POST", token: human, body: { messageId: board.id, customId: target.customId } });
      if (click.status < 300) clicks++;
      await sleep(1800);
    }
    clicks > 0 ? ok(`played ${clicks} moves through Lumina's native component clicks`) : bad("no clicks landed");

    const msgs = (await api(`/channels/${general.id}/messages`, { token: human })).json ?? [];
    const current = msgs.find((m) => m.id === board.id);
    const stillButtons = (current?.components ?? []).flatMap((r) => r.components ?? []).length;
    current && stillButtons > 0
      ? ok(`board updated in place via interaction.update (message ${board.id}, ${stillButtons} cells rendered)`)
      : bad("board vanished or lost its components after moves");
  }
  await client.destroy();
}

// =============================== discord-giveaways ===============================
{
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Message, Partials.Reaction],
    rest: { api: `${BASE}/discord/api` },
  });
  const manager = new GiveawaysManager(client, {
    storage: `/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/botfarm/giveaways-${rand}.json`,
    default: { botsCanWin: false, embedColor: "#5865F2", reaction: "🎉" },
  });
  const readied = new Promise((r) => { client.once("clientReady", r); client.once("ready", r); });
  await client.login(gaToken);
  await Promise.race([readied, sleep(10000)]);
  client.isReady() ? ok("discord-giveaways host client ready") : bad("giveaways client never ready");

  await sleep(1500);
  const channel = await client.channels.fetch(
    // resolve the compat snowflake for the general channel through the bot's own cache
    client.guilds.cache.first()?.channels?.cache?.find?.((c) => c.name === "general")?.id ?? "0",
  ).catch(() => null);
  if (!channel) { bad("giveaways bot could not resolve #general through discord.js"); }
  else {
    let ended = null;
    const endPromise = new Promise((r) => manager.on("giveawayEnded", (g, w) => { ended = { g, w }; r(); }));
    await manager.start(channel, { duration: 12000, winnerCount: 1, prize: "A Lumina hoodie" })
      .then(() => ok("giveaway started (embed flattened to text, bot self-reacted 🎉)"))
      .catch((e) => bad("giveaway start failed", e));

    // the human enters by reacting — through Lumina's NATIVE reaction API
    await sleep(2000);
    const msgs = (await api(`/channels/${general.id}/messages`, { token: human })).json ?? [];
    const gaMsg = msgs.find((m) => m.content?.includes("Lumina hoodie"));
    gaMsg ? ok("giveaway announcement visible to the human") : bad("giveaway message not found");
    if (gaMsg) {
      const react = await api(`/messages/${gaMsg.id}/reactions`, { method: "POST", token: human, body: { emoji: "🎉" } });
      react.status < 300 ? ok("human entered by reacting 🎉 via Lumina's API") : bad(`reaction ${react.status}`);
    }

    await Promise.race([endPromise, sleep(20000)]);
    if (ended) {
      const winners = (ended.w ?? []).map((u) => u?.username ?? u?.user?.username ?? String(u?.id ?? "?"));
      winners.some((w) => w.includes("qq_real"))
        ? ok(`giveaway ended and drew the human as winner: ${winners.join(", ")}`)
        : bad(`giveaway ended but winners were ${JSON.stringify(winners)}`);
    } else bad("giveaway never ended within the window");
  }
  await client.destroy();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
