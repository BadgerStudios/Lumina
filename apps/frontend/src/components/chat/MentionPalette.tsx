import { useMemo } from "react";
import type { MemberDTO } from "@lumina/shared";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";

/**
 * The `@`-mention suggestion list.
 *
 * Mirrors SlashCommandPalette: shown while the word at the caret is a `@…` token that hasn't been
 * completed yet. It's a suggestion list, not a modal — typing continues, arrow keys move the
 * highlight, Enter and Tab pick. Members are matched by username, display name and nickname so the
 * name you see is the name you can find.
 */
export function MentionPalette({
  matches,
  activeIndex,
  onPick,
}: {
  matches: MemberDTO[];
  activeIndex: number;
  onPick: (member: MemberDTO) => void;
}) {
  if (matches.length === 0) return null;

  return (
    <div className="mb-1 overflow-hidden rounded-t-lg border border-base-500 bg-base-700">
      <p className="border-b border-base-600 px-3 py-1.5 text-micro uppercase tracking-wide text-signal-faint">
        Members
      </p>
      <ul role="listbox" aria-label="Mention a member" className="max-h-56 overflow-y-auto">
        {matches.map((member, i) => {
          const name = member.nickname ?? member.user.displayName ?? member.user.username;
          return (
            <li key={member.userId}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex % matches.length}
                onMouseDown={(e) => {
                  // mousedown, not click: the textarea blurs first on a click, and the blur handler
                  // can close this list before the click lands (same reason as SlashCommandPalette).
                  e.preventDefault();
                  onPick(member);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  i === activeIndex % matches.length ? "bg-base-600" : "hover:bg-base-600/60",
                )}
              >
                <UserAvatar avatarUrl={member.user.avatarUrl} name={name} size={20} />
                <span className="min-w-0 truncate text-sm text-signal">{name}</span>
                <span className="ml-auto shrink-0 font-mono text-meta text-signal-faint">@{member.user.username}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Finds the active `@…` mention query at the caret, if any. Returns the query text (without the `@`)
 * and the index of the `@` in the value. The token is only recognised at a word boundary, so an
 * email address or a `foo@bar` handle doesn't spuriously trigger the picker.
 */
export function findMentionQuery(value: string, caret: number): { query: string; start: number } | null {
  const upto = value.slice(0, caret);
  const m = /(?:^|\s)@([a-zA-Z0-9_]{0,32})$/.exec(upto);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}
