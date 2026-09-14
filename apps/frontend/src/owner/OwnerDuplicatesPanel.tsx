import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Smartphone, Wifi } from "lucide-react";
import { api } from "../lib/apiClient";
import { UserAvatar } from "../components/common/UserAvatar";
import { relativeTime, shortDate } from "../lib/relativeTime";
import { cn } from "../lib/cn";

interface LinkedAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  platformRole: string;
  isBot: boolean;
  isMinor: boolean;
  ageRecordedAt: string | null;
  ageBracket: string | null;
  openFlags: number;
  lastSeenAt: string | null;
}

interface LinkedGroup {
  kind: "device" | "ip";
  key: string;
  accounts: LinkedAccount[];
  crowded: boolean;
}

/**
 * Accounts that share a device or an address, side by side.
 *
 * The flags raised at signup can only say "this one is linked to others". The decision needs both
 * sides at once — when each was made, whether they are in use, what else is flagged against them —
 * which is what this is for.
 *
 * Device groups come first and are labelled as the stronger signal, because the difference between
 * the two is the whole judgement. A shared fingerprint means the same machine. A shared address
 * means a household, an office, a school, or a mobile carrier putting thousands of strangers behind
 * one IP — on its own it is not evidence of anything, and a page that presented the two identically
 * would invite exactly the wrong conclusion.
 */
export function OwnerDuplicatesPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["owner", "duplicates"],
    queryFn: () => api.get<{ groups: LinkedGroup[] }>("/owner/duplicates"),
    refetchInterval: 5 * 60 * 1000,
  });

  if (isLoading) return <p className="text-sm text-signal-faint">Looking for linked accounts…</p>;
  if (error) return <p className="text-sm text-signal-dim">Couldn&apos;t load linked accounts right now.</p>;

  const groups = data?.groups ?? [];
  const device = groups.filter((g) => g.kind === "device");
  const ip = groups.filter((g) => g.kind === "ip");

  if (groups.length === 0) {
    return (
      <p className="rounded-xl bg-[var(--oc-panel)] p-6 text-center text-sm text-signal-faint ring-1 ring-[var(--oc-line)]">
        No accounts share a device or an address.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <Section
        title="Same device"
        icon={<Smartphone size={13} />}
        blurb="The same machine, matched on its browser fingerprint. The stronger of the two signals — two accounts here were almost certainly used by the same person, though a shared family computer looks identical."
        groups={device}
      />
      <Section
        title="Same address"
        icon={<Wifi size={13} />}
        blurb="Only a shared IP. Home broadband, offices, schools and especially mobile networks put unrelated people behind one address — a carrier can front thousands. On its own this means very little; it is worth something alongside a shared device."
        groups={ip}
      />
    </div>
  );
}

function Section({
  title,
  icon,
  blurb,
  groups,
}: {
  title: string;
  icon: React.ReactNode;
  blurb: string;
  groups: LinkedGroup[];
}) {
  if (groups.length === 0) return null;
  return (
    <section>
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-bold uppercase text-signal-dim">
        {icon} {title} · {groups.length}
      </h2>
      <p className="mb-3 max-w-2xl text-xs leading-relaxed text-signal-faint">{blurb}</p>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.key} className="rounded-xl bg-[var(--oc-panel)] p-3 ring-1 ring-[var(--oc-line)]">
            <div className="mb-2 flex items-center gap-2 text-xs text-signal-faint">
              <span>{group.accounts.length} accounts</span>
              {group.crowded && (
                <span className="flex items-center gap-1 rounded-full bg-amber/15 px-2 py-0.5 font-medium text-amber">
                  <AlertTriangle size={11} />
                  too many for a household — likely a shared network
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              {group.accounts.map((a) => (
                <AccountRow key={a.id} account={a} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AccountRow({ account }: { account: LinkedAccount }) {
  const name = account.displayName ?? account.username;
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--oc-bg)] px-3 py-2">
      <UserAvatar avatarUrl={account.avatarUrl} name={name} size={32} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-signal">
          <span className="truncate font-medium">{name}</span>
          <span className="shrink-0 text-xs text-signal-faint">@{account.username}</span>
          {account.isBot && <Tag>bot</Tag>}
          {account.platformRole !== "USER" && <Tag>{account.platformRole.toLowerCase()}</Tag>}
          {/* Only worth showing when it is actually known — "not a minor" and "we never asked"
              are different things and the page should not blur them. */}
          {account.ageRecordedAt && account.isMinor && <Tag tone="warn">under 18</Tag>}
          {!account.ageRecordedAt && <Tag>age not recorded</Tag>}
        </p>
        <p className="truncate text-xs text-signal-faint">
          {account.email}
          {account.emailVerified ? "" : " · unverified"}
          {" · joined "}
          {shortDate(account.createdAt)}
          {account.lastSeenAt ? ` · last seen ${relativeTime(account.lastSeenAt)}` : " · never signed in"}
        </p>
      </div>
      {account.openFlags > 0 && (
        <span
          className="shrink-0 rounded-full bg-dnd/15 px-2 py-0.5 text-xs font-medium text-dnd"
          title="Unresolved flags on this account"
        >
          {account.openFlags} flag{account.openFlags === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-px text-micro font-medium uppercase",
        tone === "warn" ? "bg-amber/15 text-amber" : "bg-base-700 text-signal-faint",
      )}
    >
      {children}
    </span>
  );
}
