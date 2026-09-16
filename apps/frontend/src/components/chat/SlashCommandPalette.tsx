import { useMemo } from "react";
import type { SlashCommandDTO, SlashCommandOptionDTO } from "@lumina/shared";
import { cn } from "../../lib/cn";

/**
 * The `/` palette.
 *
 * Shown while the composer's text starts with a `/` and has not yet been sent. It is a suggestion
 * list, not a modal: typing continues normally, arrow keys move the highlight, Enter and Tab pick.
 * That matters because most of the time a message starting with a slash is just a message starting
 * with a slash, and the palette must never be in the way of sending one.
 *
 * Commands can nest the way Discord's do — `/level rank`, `/settings welcome set` — so the palette
 * lists LEAVES (things a person can actually run), never a bare `/level` that the bot would refuse.
 */

/** One runnable thing: a plain command, or a command plus the subcommand path below it. */
export interface CommandLeaf {
  command: SlashCommandDTO;
  /** ["rank"] for /level rank, ["welcome", "set"] for a grouped one, [] for a plain command. */
  path: string[];
  /** The leaf's own options — what the palette shows as <required> [optional]. */
  options: SlashCommandOptionDTO[];
  /** "level rank" — the words typed after the slash. */
  label: string;
  description: string;
}

const NESTED = new Set<SlashCommandOptionDTO["type"]>(["subcommand", "subcommand_group"]);

export function commandLeaves(commands: SlashCommandDTO[]): CommandLeaf[] {
  const out: CommandLeaf[] = [];
  const walk = (command: SlashCommandDTO, options: SlashCommandOptionDTO[], path: string[], description: string) => {
    const nested = options.filter((o) => NESTED.has(o.type));
    if (nested.length === 0) {
      out.push({ command, path, options, label: [command.name, ...path].join(" "), description });
      return;
    }
    for (const n of nested) walk(command, n.options ?? [], [...path, n.name], n.description || description);
  };
  for (const c of commands) walk(c, c.options, [], c.description);
  return out;
}

export function matchLeaves(leaves: CommandLeaf[], query: string): CommandLeaf[] {
  const term = query.trim().toLowerCase();
  return leaves.filter((l) => l.label.startsWith(term)).slice(0, 8);
}

export function SlashCommandPalette({
  commands,
  query,
  onPick,
  activeIndex,
}: {
  commands: SlashCommandDTO[];
  query: string;
  onPick: (leaf: CommandLeaf) => void;
  activeIndex: number;
}) {
  const matches = useMemo(() => matchLeaves(commandLeaves(commands), query), [commands, query]);
  if (matches.length === 0) return null;
  return (
    <div className="mb-1 overflow-hidden rounded-t-lg border border-base-500 bg-base-700">
      <p className="border-b border-base-600 px-3 py-1.5 text-[10px] uppercase tracking-wide text-signal-faint">
        Commands
      </p>
      <ul role="listbox" aria-label="Slash commands" className="max-h-56 overflow-y-auto">
        {matches.map((leaf, i) => (
          <li key={leaf.label}>
            <button
              type="button"
              role="option"
              aria-selected={i === activeIndex % matches.length}
              onMouseDown={(e) => {
                // mousedown, not click: the composer's textarea would blur first on a click, and
                // the blur handler stops the typing indicator and can close this list before the
                // click ever lands.
                e.preventDefault();
                onPick(leaf);
              }}
              className={cn(
                "flex w-full items-baseline gap-2 px-3 py-1.5 text-left",
                i === activeIndex % matches.length ? "bg-base-600" : "hover:bg-base-600/60",
              )}
            >
              <span className="font-mono text-sm text-accent">/{leaf.label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-signal-dim">{leaf.description}</span>
              {leaf.options.length > 0 ? (
                <span className="shrink-0 font-mono text-[10px] text-signal-faint">
                  {leaf.options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(" ")}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ParsedInvocation {
  command: SlashCommandDTO;
  path: string[];
  options: Record<string, string>;
  /** Set when the text stopped at a level that still needs a subcommand: the choices to offer. */
  missingSubcommand: string[] | null;
}

/**
 * Parses `/name [sub [sub]] arg1 "arg two" key:value` into a command, its subcommand path and an
 * option map.
 *
 * Subcommands are consumed first, word by word, as long as the next word names one at the current
 * level. Then options: positional by default, matching the order the bot declared, with `key:value`
 * overriding position so someone can skip an optional argument without counting spaces. Quoted runs
 * stay together — an option whose value is a sentence is the common case, not the exception.
 */
export function parseInvocation(raw: string, commands: SlashCommandDTO[]): ParsedInvocation | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens: string[] = trimmed.slice(1).match(/"[^"]*"|\S+/g) ?? [];
  const first = tokens[0];
  if (first === undefined) return null;

  const name = first.toLowerCase();
  const command = commands.find((c) => c.name === name);
  if (!command) return null;

  const path: string[] = [];
  let level = command.options;
  let cursor = 1;
  for (;;) {
    const next = tokens[cursor]?.toLowerCase();
    const nested = next !== undefined ? level.find((o) => NESTED.has(o.type) && o.name === next) : undefined;
    if (!nested) break;
    path.push(nested.name);
    level = nested.options ?? [];
    cursor += 1;
  }
  const stillNested = level.filter((o) => NESTED.has(o.type));
  if (stillNested.length > 0) {
    return { command, path, options: {}, missingSubcommand: stillNested.map((o) => o.name) };
  }

  const options: Record<string, string> = {};
  const positional: string[] = [];
  const declared = new Set(level.map((o) => o.name));

  for (const token of tokens.slice(cursor)) {
    const unquoted = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
    const named = /^([a-z][a-z0-9_-]*):(.*)$/i.exec(unquoted);
    // `key:` only counts when the key is one this command actually declares — otherwise a message
    // containing a URL or a time ("15:30") would be silently read as a named argument.
    if (named && declared.has(named[1].toLowerCase())) {
      options[named[1].toLowerCase()] = named[2];
    } else {
      positional.push(unquoted);
    }
  }

  for (const option of level) {
    if (options[option.name] !== undefined) continue;
    const next = positional.shift();
    if (next !== undefined) options[option.name] = next;
  }

  // Anything left over joins the last option rather than being dropped, so a trailing sentence
  // typed without quotes still reaches the bot instead of vanishing.
  if (positional.length > 0 && level.length > 0) {
    const last = level[level.length - 1].name;
    options[last] = [options[last], ...positional].filter(Boolean).join(" ");
  }

  return { command, path, options, missingSubcommand: null };
}
