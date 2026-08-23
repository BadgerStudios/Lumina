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

/**
 * Marks THE first-party Lumina community.
 *
 * Same argument as the account badge, one level up: anyone can name a server "Lumina Official",
 * upload the logo as its icon and claim a vanity code that reads official, and a community that
 * looks first-party is a good place to run a scam from. Rendered from `ServerDTO.isOfficial`,
 * which only MASTER can set — never from the name, the icon or the vanity code.
 *
 * Renders in Discover (where an imitation would most want to be seen) and in the room header
 * (where a member checks what they are actually in). NOT on the invite preview: that screen does
 * not show a server name at all today, so there is nothing there yet to qualify — worth fixing,
 * since an invite link is exactly where someone decides whether to trust a community.
 */
export function OfficialServerBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Official Lumina community"
      aria-label="Official Lumina community"
      className="inline-flex shrink-0 items-center gap-0.5 align-middle text-accent"
    >
      <BadgeCheck className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
      {!compact && <span className="font-mono text-[0.6rem] font-bold uppercase leading-none">Official</span>}
    </span>
  );
}
