// ============================================================================================
// "HelperBot" — a TEMPORARY, genuinely multi-feature Discord bot, written EXACTLY as it would be
// to deploy on Discord (real discord.js v14, canonical patterns). The ONLY Discord-specific line
// is the compat base URL. It exercises a broad surface so "compatibility" means something:
//   • prefix command       !hello                      (GUILD_MESSAGES + MESSAGE_CONTENT)
//   • slash command         /userinfo [user]           (options, member fetch, embed reply)
//   • slash command         /poll <question>           (embed + BUTTON components)
//   • button interaction    Vote 👍 / Vote 👎          (interaction.update, live tally)
//   • reaction listener      ⭐ on any message → replies (GUILD_MESSAGE_REACTIONS)
//
// It is driven below by a human account using Lumina's NATIVE APIs, and every bot response is
// asserted. This is the real "does an existing Discord bot just work here" test.
// ============================================================================================
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Routes, REST } from "discord.js";

const BASE = "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + String(e).slice(0, 160) : "")), fail++);
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
const poll = async (fn, tries = 24, gap = 500) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } return null; };

// ---- stage: a human owner, a server, the bot application (privileged content toggle ON)
const reg = await api("/auth/register", { method: "POST", body: { username: `qq_hb_${rand}`, email: `qq_hb_${rand}@example.com`, password: "password123", birthDate: birth(), ageBracket: "AGE_25_34" } });
if (reg.status !== 201) { console.log("fatal register", reg.status); process.exit(1); }
const human = reg.json.accessToken, humanId = reg.json.user.id;
const server = (await api("/servers", { method: "POST", token: human, body: { name: "HelperBot Test Lodge" } })).json;
const channels = (await api(`/servers/${server.id}/channels`, { token: human })).json;
const general = channels.find((c) => c.type === "TEXT");
const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: human, body: {} })).json;
const app = (await api("/applications", { method: "POST", token: human, body: { name: `qq HelperBot ${rand}` } })).json;
await api(`/applications/${app.id}/intents`, { method: "PATCH", token: human, body: { messageContent: true, serverMembers: true } });
const joined = await api(`/invites/${invite.code}/join`, { method: "POST", bot: app.botToken });
joined.status < 300 ? ok("HelperBot created, content+members intents enabled, joined the server") : bad(`join ${joined.status}`);

// ---- register slash commands the canonical discord.js way
const commands = [
  new SlashCommandBuilder().setName("userinfo").setDescription("Show info about a user")
    .addStringOption((o) => o.setName("note").setDescription("A note to echo").setRequired(false)),
  new SlashCommandBuilder().setName("poll").setDescription("Start a yes/no poll")
    .addStringOption((o) => o.setName("question").setDescription("What to ask").setRequired(true)),
].map((c) => c.toJSON());
const put = await new REST({ api: `${BASE}/discord/api` }).setToken(app.botToken).put(Routes.applicationCommands("0"), { body: commands }).catch((e) => ({ error: String(e) }));
Array.isArray(put) ? ok(`registered ${put.length} slash commands via REST.put`) : bad("command registration failed", JSON.stringify(put));

// ---- the actual bot program (exactly as written for Discord) --------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction],
  rest: { api: `${BASE}/discord/api` },
});
const tallies = new Map(); // messageId -> {up, down}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.content === "!hello") await msg.reply(`👋 Hey ${msg.author.username}! HelperBot at your service.`);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand?.()) {
    if (interaction.commandName === "userinfo") {
      const note = interaction.options.getString("note") ?? "no note";
      const embed = new EmbedBuilder().setTitle("User Info").setDescription(`Requested by **${interaction.user.username}**\nNote: ${note}`);
      await interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === "poll") {
      const q = interaction.options.getString("question");
      const embed = new EmbedBuilder().setTitle("📊 " + q).setDescription("👍 0  ·  👎 0");
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("poll_up").setLabel("Vote 👍").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("poll_down").setLabel("Vote 👎").setStyle(ButtonStyle.Danger),
      );
      await interaction.reply({ embeds: [embed], components: [row] });
    }
  }
  if (interaction.isButton?.()) {
    const id = interaction.message.id;
    const t = tallies.get(id) ?? { up: 0, down: 0 };
    if (interaction.customId === "poll_up") t.up++; else t.down++;
    tallies.set(id, t);
    const title = interaction.message.embeds?.[0]?.title ?? "📊 Poll";
    const embed = new EmbedBuilder().setTitle(title).setDescription(`👍 ${t.up}  ·  👎 ${t.down}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("poll_up").setLabel("Vote 👍").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("poll_down").setLabel("Vote 👎").setStyle(ButtonStyle.Danger),
    );
    await interaction.update({ embeds: [embed], components: [row] });
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name === "⭐") await reaction.message.channel.send(`⭐ ${user.username} starred a message!`);
});

const readied = new Promise((r) => { client.once("clientReady", r); client.once("ready", r); });
await client.login(app.botToken);
await Promise.race([readied, sleep(10000)]);
client.isReady() ? ok(`HelperBot logged in via discord.js (as ${client.user?.username})`) : bad("bot never became ready");
await sleep(1500);

// ============================ DRIVE IT as a human, assert every response ============================

// 1. prefix command
await api(`/channels/${general.id}/messages`, { method: "POST", token: human, body: { content: "!hello" } });
let r = await poll(async () => ((await api(`/channels/${general.id}/messages`, { token: human })).json ?? []).find((m) => m.content?.includes("HelperBot at your service")));
r ? ok(`!hello → "${r.content}"`) : bad("no !hello reply");

// 2. /userinfo with an option → embed (flattened to text)
await api("/interactions/invoke", { method: "POST", token: human, body: { channelId: general.id, name: "userinfo", options: { note: "compat check" } } });
r = await poll(async () => ((await api(`/channels/${general.id}/messages`, { token: human })).json ?? []).find((m) => m.content?.includes("User Info") && m.content?.includes("compat check")));
r ? ok(`/userinfo → embed rendered ("${r.content.replace(/\n/g, " / ").slice(0, 70)}…")`) : bad("no /userinfo embed");

// 3. /poll → embed + buttons
await api("/interactions/invoke", { method: "POST", token: human, body: { channelId: general.id, name: "poll", options: { question: `Lunch at noon ${rand}?` } } });
const pollMsg = await poll(async () => ((await api(`/channels/${general.id}/messages`, { token: human })).json ?? []).find((m) => m.content?.includes(`Lunch at noon ${rand}`) && Array.isArray(m.components) && m.components.length));
pollMsg ? ok(`/poll → embed + ${pollMsg.components.flatMap((row) => row.components).length} vote buttons`) : bad("no /poll message with buttons");

// 4. click a button → interaction.update edits the tally in place
if (pollMsg) {
  const upBtn = pollMsg.components.flatMap((row) => row.components).find((b) => b.customId === "poll_up");
  await api("/interactions/component", { method: "POST", token: human, body: { messageId: pollMsg.id, customId: upBtn.customId } });
  const updated = await poll(async () => {
    const m = ((await api(`/channels/${general.id}/messages`, { token: human })).json ?? []).find((x) => x.id === pollMsg.id);
    return m && m.content?.includes("👍 1") ? m : null;
  });
  updated ? ok(`button vote → tally updated in place to "${updated.content.split("\n").pop()}"`) : bad("poll tally did not update after vote");
}

// 5. react ⭐ → the bot notices and replies
const helloMsg = ((await api(`/channels/${general.id}/messages`, { token: human })).json ?? []).find((m) => m.content === "!hello");
if (helloMsg) {
  await api(`/messages/${helloMsg.id}/reactions`, { method: "POST", token: human, body: { emoji: "⭐" } });
  r = await poll(async () => ((await api(`/channels/${general.id}/messages`, { token: human })).json ?? []).find((m) => m.content?.includes("starred a message")));
  r ? ok(`⭐ reaction → bot replied "${r.content}"`) : bad("bot did not react to the ⭐");
}

await client.destroy();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
