import { Sparkles } from "lucide-react";

/**
 * The Lumina Premium badge.
 *
 * One of the three things the plan is actually sold on — "Higher upload limits, larger video
 * uploads, and a profile badge" — and the only one a subscriber can see at a glance, which is
 * why it renders everywhere a name does rather than only on the profile card.
 *
 * Driven by `UserDTO.isPremium`, which the server derives from a stored entitlement date and
 * sends only when it is currently true. Nothing about it is client-inferred.
 */
export function PremiumBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Lumina Premium"
      aria-label="Lumina Premium subscriber"
      className="inline-flex shrink-0 items-center gap-0.5 align-middle text-amber-400"
    >
      <Sparkles className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" />
      {!compact && <span className="font-mono text-[0.6rem] font-bold uppercase leading-none">Premium</span>}
    </span>
  );
}
