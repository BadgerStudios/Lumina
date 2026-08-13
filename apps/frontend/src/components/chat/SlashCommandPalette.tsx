import { useEffect, useMemo, useState } from "react";
import type { SlashCommandDTO } from "@lumina/shared";
import { cn } from "../../lib/cn";

/**
 * The `/` palette.
 *
 * Shown while the composer's text starts with a `/` and has not yet been sent. It is a suggestion
 * list, not a modal: typing continues normally, arrow keys move the highlight, Enter and Tab pick.
 * That matters because most of the time a message starting with a slash is just a message starting
 * with a slash, and the palette must never be in the way of sending one.
 */
export function SlashCommandPalette({
  commands,
  query,
  onPick,
  activeIndex,
}: {
  commands: SlashCommandDTO[];
  query: string;
  onPick: (command: SlashCommandDTO) => void;
  activeIndex: number;
}) {
  const matches = useMemo(() => {
    const term = query.toLowerCase();
    return commands.filter((c) => c.name.startsWith(term)).slice(0, 8);
  }, [commands, query]);

  if (matches.length === 0) return null;

  return (
    <div className="mb-1 overflow-hidden rounded-t-lg border border-base-500 bg-base-700">
      <p className="border-b border-base-600 px-3 py-1.5 text-[10px] uppercase tracking-wide text-signal-faint">
        Commands
      </p>
      <ul role="listbox" aria-label="Slash commands" className="max-h-56 overflow-y-auto">
        {matches.map((command, i) => (
          <li key={command.id}>
            <button
              type="button"
              role="option"
              aria-selected={i === activeIndex % matches.length}
              onMouseDown={(e) => {
                // mousedown, not click: the composer's textarea would blur first on a click, and
                // the blur handler stops the typing indicator and can close this list before the
                // click ever lands.
                e.preventDefault();
                onPick(command);
              }}
              className={cn(
                "flex w-full items-baseline gap-2 px-3 py-1.5 text-left",
                i === activeIndex % matches.length ? "bg-base-600" : "hover:bg-base-600/60",
              )}
            >
              <span className="font-mono text-sm text-accent">/{command.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-signal-dim">{command.description}</span>
              {command.options.length > 0 ? (
                <span className="shrink-0 font-mono text-[10px] text-signal-faint">
                  {command.options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(" ")}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Parses `/name arg1 "arg two" key:value` into a command name and an option map.
 *
 * Positional by default, matching the option order the bot declared, with `key:value` overriding
 * position so someone can skip an optional argument without counting spaces. Quoted runs stay
 * together — an option whose value is a sentence is the common case, not the exception.
 */
export function parseInvocation(
  raw: string,
  commands: SlashCommandDTO[],
): { command: SlashCommandDTO; options: Record<string, string> } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens: string[] = trimmed.slice(1).match(/"[^"]*"|\S+/g) ?? [];
  const first = tokens[0];
  if (first === undefined) return null;

  const name = first.toLowerCase();
  const command = commands.find((c) => c.name === name);
  if (!command) return null;

  const options: Record<string, string> = {};
  const positional: string[] = [];
  const declared = new Set(command.options.map((o) => o.name));

  for (const token of tokens.slice(1)) {
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

  for (const option of command.options) {
    if (options[option.name] !== undefined) continue;
    const next = positional.shift();
    if (next !== undefined) options[option.name] = next;
  }

  // Anything left over joins the last option rather than being dropped, so a trailing sentence
  // typed without quotes still reaches the bot instead of vanishing.
  if (positional.length > 0 && command.options.length > 0) {
    const last = command.options[command.options.length - 1].name;
    options[last] = [options[last], ...positional].filter(Boolean).join(" ");
  }

  return { command, options };
}
