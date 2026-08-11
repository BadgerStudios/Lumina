import { BadgeCheck } from "lucide-react";

/**
 * Marks a first-party Lumina account.
 *
 * Rendered from `UserDTO.isOfficial`, which only MASTER can set — never from the bio or the avatar,
 * both of which anyone can copy. That distinction is the entire reason this component exists: on a
 * platform where staff message people about moderation decisions, "looks official" and "is
 * official" have to be different things.
 */
export function OfficialBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      // A real title/aria-label rather than an unexplained tick — a badge nobody can interpret is
      // decoration, and decoration doesn't help anyone spot an impersonator.
      title="Official Lumina account"
      aria-label="Official Lumina account"
      className="inline-flex shrink-0 items-center gap-0.5 align-middle text-accent"
    >
      <BadgeCheck className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
      {!compact && <span className="font-mono text-[0.6rem] font-bold uppercase leading-none">Official</span>}
    </span>
  );
}
