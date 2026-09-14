import { ShieldCheck } from "lucide-react";

/**
 * Marks a real member of Lumina staff.
 *
 * Rendered from `UserDTO.isStaff`, which the server sets from the account's platform role — never
 * from the bio, the display name or the avatar, all of which anyone can copy. On a platform where
 * staff message people about moderation decisions, "says they're staff" and "is staff" have to be
 * different things, and this is the difference.
 *
 * Deliberately says only that they ARE staff, not which rank. The rank is internal: publishing it
 * would tell anyone choosing a target exactly who outranks whom, and it is not what someone
 * checking a suspicious DM needs to know.
 *
 * Distinct from OfficialBadge, which marks a first-party ACCOUNT (the @lumina account itself)
 * rather than a person who works here. An account that is both shows only the official mark — it is
 * the stronger claim, and two ticks side by side read as decoration rather than as a signal.
 */
export function StaffBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Official Lumina Staff Member"
      aria-label="Official Lumina Staff Member"
      className="inline-flex shrink-0 items-center gap-0.5 align-middle text-aurora"
    >
      <ShieldCheck className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
      {!compact && <span className="font-mono text-[0.6rem] font-bold uppercase leading-none">Staff</span>}
    </span>
  );
}

/**
 * The same claim, spelled out.
 *
 * A tick next to a name is enough once you know what it means; on a profile, where someone has gone
 * specifically to decide whether to trust an account, the sentence is the point. This is the line
 * that makes the compact badge elsewhere interpretable.
 */
export function StaffNotice() {
  return (
    <p className="flex items-center gap-1.5 rounded-lg border border-aurora/30 bg-aurora/10 px-2.5 py-1.5 text-xs text-aurora">
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-semibold">Official Lumina Staff Member</span> — this account is verified
        as part of the Lumina team.
      </span>
    </p>
  );
}
