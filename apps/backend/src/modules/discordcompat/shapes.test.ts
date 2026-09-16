import { describe, expect, it, vi } from "vitest";

// toSnowflake is database-backed; the shapes under test only need it to be deterministic.
vi.mock("./ids.js", () => ({
  toSnowflake: async (kind: string, id: string) => `${kind.length}${id.length}0000000000000000`.slice(0, 18),
  fromSnowflake: async () => null,
}));

import { compatContentType, mapApplication, mapChannel, isVocal, MEMBER_DEFAULTS, gatewayUrlFor, toDiscordError, optionTypeToLumina, chatInputOnly, compatReplyShape, rateLimitHeaders, discordCommandToLumina, nestInteractionOptions, mapMessage, flattenEmbeds } from "./shapes.js";

describe("content type on compat replies", () => {
  // discord.py's json_or_text compares the header with `== 'application/json'`; the charset
  // suffix Fastify adds turned every body into a string and crashed Red-DiscordBot at login.
  it("strips the charset from JSON", () => {
    expect(compatContentType("application/json; charset=utf-8")).toBe("application/json");
    expect(compatContentType("application/json")).toBe("application/json");
    expect(compatContentType("Application/JSON;charset=UTF-8")).toBe("application/json");
  });
  it("leaves everything else alone", () => {
    expect(compatContentType("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
    expect(compatContentType("application/jsonl")).toBe("application/jsonl");
    expect(compatContentType(undefined)).toBeUndefined();
  });
});

describe("current application", () => {
  const app = { id: "app1", name: "Red", description: null, owner: { id: "owner1", username: "lucid", displayName: "Lucid" } };

  // Every key discord.py 2.7's AppInfo.__init__ indexes without .get(). Missing any one of them
  // is a KeyError inside Client.login, i.e. the bot never reaches the gateway.
  it("carries every field discord.py hard-indexes", async () => {
    const shaped = await mapApplication(app, "bot1");
    for (const key of ["id", "name", "description", "icon", "bot_public", "bot_require_code_grant", "owner", "verify_key"]) {
      expect(shaped, key).toHaveProperty(key);
    }
    expect(shaped.description).toBe("");
    expect(shaped.team).toBeNull();
  });

  // Red-DiscordBot: no team -> owner_ids = {application.owner.id}. The owner must be a full
  // user object (discord.py builds a User from it), and it must be the account that created
  // the application, not the bot itself.
  it("names the creating account as owner, as a user object", async () => {
    const shaped = await mapApplication(app, "bot1");
    expect(shaped.owner.username).toBe("lucid");
    expect(shaped.owner.id).not.toBe(shaped.id);
    for (const key of ["id", "username", "discriminator", "avatar"]) expect(shaped.owner).toHaveProperty(key);
  });

  it("gives each application a stable verify key", async () => {
    const a = await mapApplication(app, "bot1");
    const b = await mapApplication(app, "bot1");
    const c = await mapApplication({ ...app, id: "app2" }, "bot1");
    expect(a.verify_key).toBe(b.verify_key);
    expect(a.verify_key).not.toBe(c.verify_key);
    expect(a.verify_key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("channels in GUILD_CREATE", () => {
  const base = { id: "c1", name: "general", serverId: "s1" };

  // discord.py's VocalGuildChannel._update does data['bitrate'] and data['user_limit'] with no
  // default; a voice channel without them is a KeyError that takes the whole guild down.
  it("gives voice and stage channels the fields discord.py hard-indexes", async () => {
    for (const type of ["VOICE", "STAGE"]) {
      const shaped = await mapChannel({ ...base, type });
      expect(isVocal(shaped.type), type).toBe(true);
      expect(shaped).toHaveProperty("bitrate");
      expect(shaped).toHaveProperty("user_limit");
    }
  });

  it("keeps text channels free of voice fields but with the shared ones", async () => {
    const shaped = await mapChannel({ ...base, type: "TEXT" });
    expect(isVocal(shaped.type)).toBe(false);
    expect(shaped).not.toHaveProperty("bitrate");
    for (const key of ["name", "position", "permission_overwrites", "nsfw"]) expect(shaped).toHaveProperty(key);
  });
});

describe("guild members", () => {
  // discord.py Member.__init__: self._flags = data['flags'] — no default.
  it("always carry flags", () => {
    expect(MEMBER_DEFAULTS).toHaveProperty("flags", 0);
    expect(MEMBER_DEFAULTS).toHaveProperty("deaf", false);
    expect(MEMBER_DEFAULTS).toHaveProperty("mute", false);
  });
});

describe("gateway url", () => {
  // READY's resume_gateway_url is what libraries reconnect to after a drop. Built from the raw
  // multi-origin PUBLIC_APP_URL it contained a comma, Discord.Net could not parse the host, and
  // NadekoBot never came back after a backend restart until it was restarted by hand.
  it("uses only the first public origin, as a websocket URL", () => {
    expect(gatewayUrlFor("https://lumina.example, https://lumina.other")).toBe("wss://lumina.example/discord/gateway");
    expect(gatewayUrlFor("https://lumina.example/")).toBe("wss://lumina.example/discord/gateway");
    expect(gatewayUrlFor("http://localhost:4000")).toBe("ws://localhost:4000/discord/gateway");
  });
});

describe("error bodies", () => {
  // JDA does Integer.parseInt(body.code); a string code is a NumberFormatException, not an error
  // the bot can read.
  it("always carries a numeric code and the message", () => {
    const e = toDiscordError(400, { error: "At most 100 commands per application", code: "BAD_REQUEST" });
    expect(typeof e.code).toBe("number");
    expect(e).toEqual({ code: 50035, message: "At most 100 commands per application" });
    expect(toDiscordError(401, { error: "Unauthorized", code: "UNAUTHORIZED" }).code).toBe(40001);
    // a compat route that already picked Discord's specific code keeps it
    expect(toDiscordError(400, { code: 50016, message: "Provided too few or too many messages to delete." }).code).toBe(50016);
    expect(toDiscordError(403, { error: "Missing permission", code: "FORBIDDEN" }).code).toBe(50013);
  });
  it("picks the specific Unknown-X code for 404s", () => {
    expect(toDiscordError(404, { error: "Unknown Guild", code: "NOT_FOUND" }).code).toBe(10004);
    expect(toDiscordError(404, { error: "Unknown channel", code: "NOT_FOUND" }).code).toBe(10003);
    expect(toDiscordError(404, { error: "Nothing here", code: "NOT_FOUND" }).code).toBe(0);
  });
  it("survives bodies that are not Lumina errors", () => {
    expect(toDiscordError(500, "boom")).toEqual({ code: 0, message: "HTTP 500" });
    expect(toDiscordError(400, { error: "Validation failed", issues: [{ path: ["name"] }] }).errors).toEqual([{ path: ["name"] }]);
  });
});

describe("command option types", () => {
  // The set interactions/service.ts validateCommand accepts. Anything outside it fails the whole
  // PUT /applications/:id/commands, i.e. the bot registers nothing.
  const LUMINA_TYPES = ["string", "integer", "boolean", "user", "channel"];
  it("maps every Discord option type onto one Lumina knows", () => {
    for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, undefined, 99]) {
      expect(LUMINA_TYPES, `type ${t}`).toContain(optionTypeToLumina(t));
    }
  });
  it("keeps the exact kinds where they exist", () => {
    expect(optionTypeToLumina(4)).toBe("integer");
    expect(optionTypeToLumina(5)).toBe("boolean");
    expect(optionTypeToLumina(6)).toBe("user");
    expect(optionTypeToLumina(7)).toBe("channel");
    expect(optionTypeToLumina(10)).toBe("string");
  });
});

describe("command kinds", () => {
  it("registers chat-input commands and drops context menus rather than failing the set", () => {
    const sent = [{ name: "ping" }, { name: "level", type: 1 }, { name: "Report Message", type: 3 }, { name: "Avatar", type: 2 }];
    expect(chatInputOnly(sent).map((c) => c.name)).toEqual(["ping", "level"]);
  });
});

describe("the compat reply hook", () => {
  it("leaves a no-content reply alone (no header to set)", () => {
    const r = compatReplyShape(204, undefined, undefined);
    expect(r).not.toHaveProperty("contentType");
    expect(r.payload).toBeUndefined();
  });
  it("bares the JSON content-type and reshapes error bodies", () => {
    expect(compatReplyShape(200, "application/json; charset=utf-8", "{}")).toEqual({ contentType: "application/json", payload: "{}" });
    const err = compatReplyShape(404, "application/json; charset=utf-8", JSON.stringify({ error: "Unknown Guild", code: "NOT_FOUND" }));
    expect(JSON.parse(err.payload as string)).toEqual({ code: 10004, message: "Unknown Guild" });
  });
  it("does not touch an already-bare header or a non-JSON body", () => {
    expect(compatReplyShape(200, "application/json", "{}")).toEqual({ payload: "{}" });
    expect(compatReplyShape(500, "text/plain", "boom")).toEqual({ payload: "boom" });
  });
});

describe("rate-limit headers", () => {
  it("carry Discord's five headers with a stable per-route bucket", () => {
    const a = rateLimitHeaders("/channels/:id/messages", 1_800_000_000_000);
    expect(Object.keys(a).sort()).toEqual(["x-ratelimit-bucket", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-reset-after"]);
    expect(Number(a["x-ratelimit-remaining"])).toBeLessThan(Number(a["x-ratelimit-limit"]));
    expect(a["x-ratelimit-reset"]).toBe(String(1_800_000_000 + 1));
    expect(rateLimitHeaders("/channels/:id/messages")["x-ratelimit-bucket"]).toBe(a["x-ratelimit-bucket"]);
    expect(rateLimitHeaders("/guilds/:id")["x-ratelimit-bucket"]).not.toBe(a["x-ratelimit-bucket"]);
  });
});

describe("command trees", () => {
  it("keeps Discord's subcommand nesting on registration", () => {
    const lumina = discordCommandToLumina({
      name: "settings",
      description: "d",
      options: [{ name: "welcome", type: 2, description: "g", options: [{ name: "set", type: 1, description: "s", options: [{ name: "channel", type: 7, description: "c", required: true }] }] }],
    }) as { options: Array<{ type: string; options: Array<{ type: string; options: Array<{ type: string; required: boolean }> }> }> };
    expect(lumina.options[0].type).toBe("subcommand_group");
    expect(lumina.options[0].options[0].type).toBe("subcommand");
    expect(lumina.options[0].options[0].options[0]).toMatchObject({ type: "channel", required: true });
  });
  it("nests interaction options back the way Discord sends them", () => {
    expect(nestInteractionOptions([], { n: 2 })).toEqual([{ name: "n", type: 4, value: 2 }]);
    expect(nestInteractionOptions(["rank"], { user: "1" })).toEqual([{ name: "rank", type: 1, options: [{ name: "user", type: 3, value: "1" }] }]);
    expect(nestInteractionOptions(["welcome", "set"], { on: true })).toEqual([
      { name: "welcome", type: 2, options: [{ name: "set", type: 1, options: [{ name: "on", type: 5, value: true }] }] },
    ]);
  });
});

describe("message kinds", () => {
  it("marks a join announcement as Discord type 7", async () => {
    const base = { id: "1", channelId: "c", authorId: "u", author: { id: "u", username: "x" }, content: "", editedAt: null, pinned: false, replyToId: null, createdAt: new Date().toISOString() };
    expect((await mapMessage({ ...base, type: "MEMBER_JOIN" })).type).toBe(7);
    expect((await mapMessage({ ...base, type: "DEFAULT" })).type).toBe(0);
  });
});

describe("embeds as text", () => {
  it("keeps every readable part of an embed", () => {
    const text = flattenEmbeds([{ author: { name: "Ree6" }, title: "Level roles", url: "https://x", description: "d", fields: [{ name: "Level 5", value: "@Regular" }], footer: { text: "f" }, thumbnail: { url: "https://img" } }]);
    expect(text).toBe("Ree6\n**Level roles** https://x\nd\n**Level 5**\n@Regular\nhttps://img\n_f_");
  });
  // Ree6's /levelrole list answered with an embed that had no text; flattening it to "" made the
  // compat layer refuse the bot's own follow-up with 400 "content or embeds required".
  it("never turns a present embed into nothing", () => {
    expect(flattenEmbeds([{ color: 0x5b7cfa }])).toBe("[embed]");
    expect(flattenEmbeds([])).toBe("");
    expect(flattenEmbeds(undefined)).toBe("");
  });
});
