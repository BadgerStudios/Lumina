import { useState, type ReactNode } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { useAuthStore } from "../store/authStore";
import { isOwner } from "../lib/platformRole";
import { relativeTime } from "../lib/relativeTime";
import { useFlagProvenance, useUserProvenance } from "../queries/owner";

/**
 * Where an account or a refused sign-up came from: IP, device, user agent, the devices it has used
 * since. Owner-only, and every read writes a PROVENANCE_VIEW row to the staff audit log - so, like
 * video upload provenance, nothing is fetched until the owner presses the button.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-signal-faint">{label}</dt>
      <dd className="min-w-0 break-words text-signal-dim">{children}</dd>
    </>
  );
}

function Shell({ title, onOpen, open, children }: { title: string; onOpen: () => void; open: boolean; children: ReactNode }) {
  const role = useAuthStore((s) => s.user?.platformRole);
  if (!isOwner(role)) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-signal-faint ring-1 ring-hairline hover:text-signal"
      >
        <Fingerprint className="h-3.5 w-3.5" />
        {title}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-base-900 p-2 text-xs">
      <div className="flex items-center gap-1.5 text-signal-dim">
        <Fingerprint className="h-3.5 w-3.5" />
        {title.replace(/^Show /, "")}
        <span className="ml-auto text-signal-faint">this view is logged</span>
      </div>
      {children}
    </div>
  );
}

/** "AGE_25_34" -> "25-34", "AGE_65_PLUS" -> "65+", "UNDER_18" -> "Under 18". */
export function ageLabel(bracket: string | null | undefined): string {
  if (!bracket) return "—";
  if (bracket.startsWith("UNDER_")) return `Under ${bracket.slice(6)}`;
  return bracket.replace(/^AGE_/, "").replace(/_PLUS$/, "+").replace("_", "–");
}

function when(iso: string | null | undefined) {
  if (!iso) return "—";
  return `${new Date(iso).toLocaleString()} (${relativeTime(iso)})`;
}

export function UserProvenance({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useUserProvenance(open ? userId : null);
  return (
    <Shell title="Show sign-up & device provenance" open={open} onOpen={() => setOpen(true)}>
      {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-signal-faint" />}
      {error && <p className="text-flare">{(error as Error).message}</p>}
      {data && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <Row label="Signed up">{when(data.signup.at)}</Row>
            {data.signup.recorded ? (
              <>
                <Row label="Sign-up device">{data.signup.device ?? "—"}</Row>
                <Row label="Sign-up IP">{data.signup.ip ?? "—"}</Row>
                <Row label="Country">{data.signup.country ?? "—"}</Row>
                <Row label="App">{data.signup.client ?? "web"}</Row>
                <Row label="User agent">
                  <span className="font-mono">{data.signup.userAgent ?? "—"}</span>
                </Row>
              </>
            ) : (
              <Row label="Sign-up device">not recorded (account is older than sign-up provenance, 2026-10-01)</Row>
            )}
            <Row label="Email">
              {data.account.email} {data.account.emailVerified ? "· verified" : "· not verified"}
            </Row>
            <Row label="Age">
              {ageLabel(data.account.ageBracket)}
              {data.account.birthDate ? ` · born ${data.account.birthDate}` : ""}
              {data.account.isMinor ? " · minor account" : ""}
              {data.account.ageReview ? ` · review ${data.account.ageReview.toLowerCase()}` : ""}
            </Row>
          </dl>

          <div>
            <p className="mb-1 text-signal-faint">Devices signed in ({data.devices.length})</p>
            {data.devices.length === 0 ? (
              <p className="text-signal-faint">No sign-ins yet.</p>
            ) : (
              <ul className="space-y-1">
                {data.devices.map((d, i) => (
                  <li key={i} className="rounded border border-hairline p-1.5">
                    <p className="text-signal">{d.device}</p>
                    <p className="text-signal-faint">
                      {d.sessions} sign-in{d.sessions === 1 ? "" : "s"}
                      {d.active > 0 ? ` · ${d.active} active` : ""} · last {relativeTime(d.lastSeen)} · first{" "}
                      {new Date(d.firstSeen).toLocaleDateString()}
                    </p>
                    {d.ips.length > 0 && <p className="break-all font-mono text-signal-faint">{d.ips.join(", ")}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.apps.length > 0 && (
            <div>
              <p className="mb-1 text-signal-faint">Installed apps (push registered)</p>
              <ul className="space-y-0.5 text-signal-dim">
                {data.apps.map((a, i) => (
                  <li key={i}>
                    {a.app === "owner" ? "Owner console" : "Lumina"} · {a.platform}
                    {a.build != null ? ` build ${a.build}` : ""} · installed {new Date(a.installedAt).toLocaleDateString()} · seen{" "}
                    {relativeTime(a.lastSeen)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.otherAccountsOnTheseDevices.length > 0 && (
            <p className="text-signal-dim">
              <span className="text-signal-faint">Other accounts on these devices: </span>
              {data.otherAccountsOnTheseDevices.map((o) => `@${o.username}`).join(", ")}
            </p>
          )}

          {data.flags.length > 0 && (
            <div>
              <p className="mb-1 text-signal-faint">Flags</p>
              <ul className="space-y-0.5 text-signal-dim">
                {data.flags.map((f) => (
                  <li key={f.id}>
                    <span className="font-mono">{f.reasonCode}</span> · {new Date(f.createdAt).toLocaleDateString()}
                    {f.active ? "" : " · resolved"}
                    {f.detail ? ` — ${f.detail}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

export function FlagProvenance({ flagId }: { flagId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useFlagProvenance(open ? flagId : null);
  return (
    <Shell title="Show provenance" open={open} onOpen={() => setOpen(true)}>
      {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-signal-faint" />}
      {error && <p className="text-flare">{(error as Error).message}</p>}
      {data && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row label="When">{when(data.createdAt)}</Row>
          {data.purgedAt ? (
            <Row label="Details">cleared {new Date(data.purgedAt).toLocaleDateString()} (kept 90 days)</Row>
          ) : data.ip || data.userAgent ? (
            <>
              <Row label="Device">{data.device ?? "—"}</Row>
              <Row label="IP">{data.ip ?? "—"}</Row>
              <Row label="Country">{data.country ?? "—"}</Row>
              <Row label="App">{data.client ?? "web"}</Row>
              <Row label="User agent">
                <span className="font-mono">{data.userAgent ?? "—"}</span>
              </Row>
            </>
          ) : (
            <Row label="Details">not recorded (before 2026-10-01)</Row>
          )}
          <Row label="Same device">{data.otherFlagsFromThisDevice} other flag(s)</Row>
          <Row label="Same address">{data.otherFlagsFromThisAddress} other flag(s)</Row>
        </dl>
      )}
    </Shell>
  );
}
