import { describe, expect, it, vi } from "vitest";

// toSnowflake is database-backed; the shapes under test only need it to be deterministic.
vi.mock("./ids.js", () => ({
  toSnowflake: async (kind: string, id: string) => `${kind.length}${id.length}0000000000000000`.slice(0, 18),
  fromSnowflake: async () => null,
}));

import { compatContentType, mapApplication, mapChannel, isVocal, MEMBER_DEFAULTS } from "./shapes.js";

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
