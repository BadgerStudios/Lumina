import type { SlashCommandOptionDTO } from "@lumina/shared";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

/**
 * The shape of a slash command as a bot registers it — validated here, stored as JSON, and later
 * handed to every client in the space to draw a command palette from. Pure: no database, so the
 * rules are unit-tested directly.
 *
 * Strict on purpose. A malformed option list would render as a broken form for real users, and
 * "the bot sent nonsense" is much easier to act on at registration time than at render time.
 *
 * Nesting follows Discord's model exactly, because that is what the bots were written against:
 *   command → subcommand_group → subcommand → leaf options
 *   command → subcommand → leaf options
 *   command → leaf options
 * A level holds either subcommands/groups or leaf options, never both.
 */

// Discord's own global-command ceiling. Real bots sit well above 50: Ree6 registers ~90.
export const MAX_COMMANDS_PER_APPLICATION = 100;
export const MAX_OPTIONS_PER_LEVEL = 25;
export const MAX_DESCRIPTION_LENGTH = 200;

// Discord's rule (lowercase letters, digits, _ and -; a digit may lead: /8ball is a classic).
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const NAME_RULE = "must be 1-32 lowercase characters (a-z, 0-9, _, -) starting with a letter or digit";

export const LEAF_OPTION_TYPES = new Set<SlashCommandOptionDTO["type"]>(["string", "integer", "boolean", "user", "channel"]);
export const NESTED_OPTION_TYPES = new Set<SlashCommandOptionDTO["type"]>(["subcommand", "subcommand_group"]);

type Level = "root" | "group" | "sub";

function validateOptions(rawOptions: unknown[], where: string, level: Level): SlashCommandOptionDTO[] {
  if (rawOptions.length > MAX_OPTIONS_PER_LEVEL) throw new BadRequestError(`Command "${where}": at most ${MAX_OPTIONS_PER_LEVEL} options`);
  const seen = new Set<string>();
  let seenOptional = false;
  let levelKind: "leaf" | "nested" | null = null;

  return rawOptions.map((o, i) => {
    if (!o || typeof o !== "object") throw new BadRequestError(`Command "${where}": option ${i} is not an object`);
    const opt = o as Record<string, unknown>;
    const optName = typeof opt.name === "string" ? opt.name.trim().toLowerCase() : "";
    if (!NAME_RE.test(optName)) throw new BadRequestError(`Command "${where}": option ${i} (${JSON.stringify(String(opt.name ?? ""))}) ${NAME_RULE}`);
    if (seen.has(optName)) throw new BadRequestError(`Command "${where}": duplicate option "${optName}"`);
    seen.add(optName);
    const type = (typeof opt.type === "string" ? opt.type : "string") as SlashCommandOptionDTO["type"];
    if (!LEAF_OPTION_TYPES.has(type) && !NESTED_OPTION_TYPES.has(type)) {
      throw new BadRequestError(`Command "${where}": option "${optName}" has unknown type "${type}"`);
    }
    const description = typeof opt.description === "string" ? opt.description.slice(0, MAX_DESCRIPTION_LENGTH) : "";

    const nested = NESTED_OPTION_TYPES.has(type);
    const kind = nested ? "nested" : "leaf";
    if (levelKind && levelKind !== kind) {
      throw new BadRequestError(`Command "${where}": subcommands and plain options cannot share a level`);
    }
    levelKind = kind;

    if (nested) {
      if (level === "sub") throw new BadRequestError(`Command "${where}": "${optName}" cannot nest below a subcommand`);
      if (type === "subcommand_group" && level !== "root") {
        throw new BadRequestError(`Command "${where}": a subcommand group may only sit directly under the command`);
      }
      const children = validateOptions(Array.isArray(opt.options) ? opt.options : [], `${where} ${optName}`, type === "subcommand_group" ? "group" : "sub");
      if (type === "subcommand_group" && !children.every((c) => c.type === "subcommand")) {
        throw new BadRequestError(`Command "${where}": group "${optName}" may only contain subcommands`);
      }
      return { name: optName, description, type, options: children };
    }

    const required = opt.required === true;
    // Required-after-optional is unfillable in a positional `/cmd a b c` palette: the client cannot
    // tell which argument the user meant to skip. Rejected here rather than silently reordered.
    if (required && seenOptional) {
      throw new BadRequestError(`Command "${where}": required option "${optName}" cannot come after an optional one`);
    }
    if (!required) seenOptional = true;
    return {
      name: optName,
      description,
      type,
      required,
      choices: Array.isArray(opt.choices)
        ? opt.choices
            .filter(
              (c): c is { name: string; value: string | number } =>
                !!c &&
                typeof c === "object" &&
                typeof (c as { name?: unknown }).name === "string" &&
                ["string", "number"].includes(typeof (c as { value?: unknown }).value),
            )
            .slice(0, MAX_OPTIONS_PER_LEVEL)
        : undefined,
    };
  });
}

/** Validates one command definition as sent by a bot. */
export function validateCommand(raw: unknown, index: number): { name: string; description: string; options: SlashCommandOptionDTO[] } {
  if (!raw || typeof raw !== "object") throw new BadRequestError(`Command ${index} is not an object`);
  const cmd = raw as Record<string, unknown>;
  const name = typeof cmd.name === "string" ? cmd.name.trim().toLowerCase() : "";
  if (!NAME_RE.test(name)) {
    // Quote what was sent: a bot author reading "Command 62" in a log has to count; "Command 62
    // ("Report Message")" tells them which one.
    const shown = JSON.stringify(String(cmd.name ?? "")).slice(0, 40);
    throw new BadRequestError(`Command ${index} (${shown}): name ${NAME_RULE}`);
  }
  const description = typeof cmd.description === "string" ? cmd.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new BadRequestError(`Command "${name}": description is required and must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
  }
  const options = validateOptions(Array.isArray(cmd.options) ? cmd.options : [], name, "root");
  return { name, description, options };
}

/**
 * Walks a command's tree along `path` (subcommand-group and/or subcommand names) and returns the
 * leaf options that invocation fills in. An empty path on a command that only has subcommands is
 * an error, as on Discord: `/level` alone means nothing when the bot defined `/level rank`.
 */
export function resolveLeafOptions(command: { name: string; options: SlashCommandOptionDTO[] }, path: string[]): SlashCommandOptionDTO[] {
  let options = command.options;
  let where = `/${command.name}`;
  for (const segment of path) {
    const next = options.find((o) => NESTED_OPTION_TYPES.has(o.type) && o.name === segment.toLowerCase());
    if (!next) throw new NotFoundError(`${where} has no subcommand "${segment}"`);
    where += ` ${next.name}`;
    options = next.options ?? [];
  }
  if (options.some((o) => NESTED_OPTION_TYPES.has(o.type))) {
    const names = options.map((o) => o.name).join(", ");
    throw new BadRequestError(`${where} needs a subcommand: ${names}`);
  }
  return options;
}

/** Every invocable leaf, flattened: ["level rank", "level set"] for a nested command, ["ping"] for a plain one. */
export function leafPaths(command: { name: string; options: SlashCommandOptionDTO[] }): string[][] {
  const out: string[][] = [];
  const walk = (options: SlashCommandOptionDTO[], prefix: string[]) => {
    const nested = options.filter((o) => NESTED_OPTION_TYPES.has(o.type));
    if (nested.length === 0) {
      out.push(prefix);
      return;
    }
    for (const n of nested) walk(n.options ?? [], [...prefix, n.name]);
  };
  walk(command.options, []);
  return out;
}
