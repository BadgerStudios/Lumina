import { describe, expect, it } from "vitest";
import { leafPaths, resolveLeafOptions, validateCommand } from "./commandSchema.js";

const ree6Level = {
  name: "level",
  description: "Levels",
  options: [
    { name: "rank", description: "Show a rank", type: "subcommand", options: [{ name: "user", description: "Whose", type: "user" }] },
    { name: "set", description: "Set XP", type: "subcommand", options: [{ name: "user", description: "Whose", type: "user", required: true }, { name: "xp", description: "How much", type: "integer", required: true }] },
  ],
};

describe("registering a command", () => {
  it("accepts subcommands and keeps their leaf options", () => {
    const v = validateCommand(ree6Level, 0);
    expect(v.options.map((o) => o.type)).toEqual(["subcommand", "subcommand"]);
    expect(v.options[1].options?.map((o) => o.name)).toEqual(["user", "xp"]);
  });
  it("accepts a group → subcommand → leaf tree, and nothing deeper", () => {
    const grouped = { name: "settings", description: "d", options: [{ name: "welcome", description: "d", type: "subcommand_group", options: [{ name: "set", description: "d", type: "subcommand", options: [{ name: "channel", description: "d", type: "channel" }] }] }] };
    expect(leafPaths(validateCommand(grouped, 0))).toEqual([["welcome", "set"]]);
    const tooDeep = { name: "x", description: "d", options: [{ name: "a", description: "d", type: "subcommand", options: [{ name: "b", description: "d", type: "subcommand" }] }] };
    expect(() => validateCommand(tooDeep, 0)).toThrow(/cannot nest/);
    const groupInGroup = { name: "x", description: "d", options: [{ name: "a", description: "d", type: "subcommand_group", options: [{ name: "b", description: "d", type: "subcommand_group" }] }] };
    expect(() => validateCommand(groupInGroup, 0)).toThrow(/directly under the command|only contain subcommands/);
  });
  it("refuses a level that mixes subcommands with plain options", () => {
    const mixed = { name: "x", description: "d", options: [{ name: "a", description: "d", type: "subcommand" }, { name: "b", description: "d", type: "string" }] };
    expect(() => validateCommand(mixed, 0)).toThrow(/cannot share a level/);
  });
  it("names the offending command and lets a digit lead", () => {
    expect(() => validateCommand({ name: "Report Message", description: "d" }, 62)).toThrow(/Command 62 \("Report Message"\)/);
    expect(validateCommand({ name: "8ball", description: "d" }, 0).name).toBe("8ball");
  });
  it("keeps required-before-optional and choices", () => {
    expect(() => validateCommand({ name: "x", description: "d", options: [{ name: "a", description: "d", type: "string" }, { name: "b", description: "d", type: "string", required: true }] }, 0)).toThrow(/cannot come after/);
    const v = validateCommand({ name: "x", description: "d", options: [{ name: "a", description: "d", type: "string", choices: [{ name: "One", value: 1 }, { bad: true }] }] }, 0);
    expect(v.options[0].choices).toEqual([{ name: "One", value: 1 }]);
  });
});

describe("invoking a command", () => {
  const level = validateCommand(ree6Level, 0);
  it("resolves the leaf options for a subcommand path", () => {
    expect(resolveLeafOptions(level, ["set"]).map((o) => o.name)).toEqual(["user", "xp"]);
    expect(resolveLeafOptions(level, ["RANK"]).map((o) => o.name)).toEqual(["user"]);
  });
  it("refuses a bare command that needs a subcommand, and an unknown subcommand", () => {
    expect(() => resolveLeafOptions(level, [])).toThrow(/needs a subcommand: rank, set/);
    expect(() => resolveLeafOptions(level, ["nope"])).toThrow(/has no subcommand "nope"/);
  });
  it("is a no-op path for a plain command", () => {
    const ping = validateCommand({ name: "ping", description: "d" }, 0);
    expect(resolveLeafOptions(ping, [])).toEqual([]);
    expect(leafPaths(ping)).toEqual([[]]);
    expect(leafPaths(level)).toEqual([["rank"], ["set"]]);
  });
});
