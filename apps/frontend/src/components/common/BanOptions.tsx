import { ShieldOff } from "lucide-react";

/**
 * Whether taking something down also means acting on whoever posted it.
 *
 * Shared by the image queue and the video queue because it is one decision with one shape, and two
 * copies would drift — which matters more than usual here, since the difference between the options
 * is the difference between a ban that holds and one that is undone by a new signup.
 *
 * Off by default, and deliberately so: most removals are somebody's first mistake, and a dialog that
 * arrives with "ban this person" pre-selected makes the severe outcome the accidental one. `device`
 * is pre-ticked only once the ban itself has been turned on, because an account-only ban against
 * someone who will simply sign up again is the common mistake in the other direction.
 */
export interface RemovalBan {
  email: boolean;
  ip: boolean;
  device: boolean;
  reason?: string;
  days?: number | null;
}

export const DEFAULT_REMOVAL_BAN: RemovalBan = { email: false, ip: false, device: true, days: null };

const IDENTIFIERS = [
  ["device", "This device", "Stops the same phone or computer making a new account."],
  ["ip", "This address", "Shared addresses catch other people too — use with care."],
  ["email", "This email", "Only stops reuse of the same address."],
] as const;

export function BanOptions({
  name,
  banning,
  onBanningChange,
  ban,
  onBanChange,
}: {
  /** Who is being banned, so the checkbox names a person rather than "the user". */
  name: string;
  banning: boolean;
  onBanningChange: (next: boolean) => void;
  ban: RemovalBan;
  onBanChange: (next: RemovalBan) => void;
}) {
  return (
    <div className="rounded-lg border border-hairline p-3">
      <label className="flex items-center gap-2 text-sm text-signal">
        <input
          type="checkbox"
          checked={banning}
          onChange={(e) => onBanningChange(e.target.checked)}
          className="h-4 w-4 accent-flare"
        />
        <ShieldOff className="h-4 w-4 text-flare" aria-hidden="true" />
        Also ban {name}
      </label>

      {banning && (
        <div className="mt-3 space-y-2 border-t border-hairline pt-3">
          <p className="text-xs text-signal-faint">
            The account is always banned. These decide whether they can simply sign up again:
          </p>
          {IDENTIFIERS.map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-2 text-xs text-signal-dim">
              <input
                type="checkbox"
                checked={ban[key]}
                onChange={(e) => onBanChange({ ...ban, [key]: e.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 accent-flare"
              />
              <span>
                <span className="text-signal">{label}</span> — {hint}
              </span>
            </label>
          ))}

          <label className="block pt-1 text-xs text-signal-dim">
            For how long?
            <select
              value={ban.days ?? ""}
              onChange={(e) => onBanChange({ ...ban, days: e.target.value ? Number(e.target.value) : null })}
              className="mt-1 w-full rounded-lg border border-hairline bg-base-700 px-2 py-1.5 text-sm text-signal focus:border-accent focus:outline-none"
            >
              <option value="">Permanent</option>
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="365">1 year</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
