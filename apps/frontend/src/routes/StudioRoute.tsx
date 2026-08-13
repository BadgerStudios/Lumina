import { useEffect, useState } from "react";
import { Wallet, Clock, Lock, CheckCircle2, Circle, BadgeDollarSign, Landmark, Users } from "lucide-react";
import { cn } from "../lib/cn";
import { UserAvatar } from "../components/common/UserAvatar";
import { useCreatorStatus, useCreatorWallet, useCreatorEarnings, useMyTier, useSaveTier, useSupporters } from "../queries/economy";

/** The supporter-tier editor + supporter roll. Form state resyncs when the server answer
 * arrives — same stale-form lesson every entity-editing modal in this app has learned. */
function MembershipSection() {
  const { data: myTier } = useMyTier();
  const { data: supporters } = useSupporters();
  const saveTier = useSaveTier();
  const [name, setName] = useState("Supporter");
  const [priceDollars, setPriceDollars] = useState("5");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (myTier?.tier) {
      setName(myTier.tier.name);
      setPriceDollars((myTier.tier.priceMinor / 100).toFixed(2).replace(/\.00$/, ""));
      setDescription(myTier.tier.description ?? "");
      setActive(myTier.tier.active ?? false);
    }
  }, [myTier]);

  const priceMinor = Math.round(Number(priceDollars) * 100);
  const priceValid = Number.isFinite(priceMinor) && priceMinor >= 100 && priceMinor <= 5000;

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase text-signal-dim">
        <Users size={13} /> Membership
      </h2>
      <div className="flex flex-col gap-3 rounded-xl bg-base-800 p-4 ring-1 ring-base-600">
        <p className="text-xs text-signal-faint">
          A monthly supporter tier your audience can join from your videos. You keep 90% of every
          payment; existing supporters keep the price they joined at.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Tier name"
            className="w-40 rounded bg-base-900 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
          />
          <div className="flex items-center gap-1 text-sm text-signal">
            $
            <input
              value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} inputMode="decimal"
              aria-label="Monthly price in dollars"
              className="w-16 rounded bg-base-900 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
            />
            /mo
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-signal">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Open to new supporters
          </label>
        </div>
        <input
          value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300}
          placeholder="What supporters make possible (optional)"
          className="rounded bg-base-900 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              await saveTier.mutateAsync({ name, description: description || null, priceMinor, active });
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            }}
            disabled={!priceValid || !name.trim() || saveTier.isPending}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saved ? "Saved ✓" : "Save tier"}
          </button>
          {!priceValid && <span className="text-xs text-dnd">Price must be $1–$50</span>}
          <span className="ml-auto text-xs text-signal-faint">
            {myTier?.supporters ?? 0} active supporter{(myTier?.supporters ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        {(supporters ?? []).length > 0 && (
          <div className="flex flex-col gap-1 border-t border-base-600 pt-2">
            {(supporters ?? []).map((s) => (
              <div key={s.member.id} className="flex items-center gap-2 text-sm text-signal">
                <UserAvatar avatarUrl={s.member.avatarUrl} name={s.member.displayName ?? s.member.username} size={22} />
                <span className="min-w-0 flex-1 truncate">{s.member.displayName ?? s.member.username}</span>
                <span className="shrink-0 text-xs text-signal-faint">${(s.priceMinor / 100).toFixed(2)}/mo</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Creator Studio — every number on this page is ledger-backed, read straight off the wallet read
 * model that reconciliation re-proves against entries every few minutes. Estimated (pending) and
 * available are visually separate and NAMED for what they are: the master spec's rule that
 * estimated money must never read as withdrawable is a labeling rule before it is anything else.
 */
export function StudioRoute() {
  const { data: status } = useCreatorStatus();
  const { data: wallet } = useCreatorWallet();
  const { data: earnings } = useCreatorEarnings();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4 md:p-8">
        <header className="flex items-center gap-3">
          <BadgeDollarSign className="text-accent" size={26} />
          <div>
            <h1 className="text-xl font-bold text-signal">Creator Studio</h1>
            <p className="text-xs text-signal-faint">
              Program status: <span className="font-semibold text-signal">{status?.state ?? "…"}</span>
            </p>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Pending", hint: "In the hold window — becomes available automatically", value: wallet?.pending.display, icon: Clock },
            { label: "Available", hint: "Withdrawable once payouts are set up", value: wallet?.available.display, icon: Wallet },
            { label: "Reserved", hint: "Held against refunds per policy", value: wallet?.reserved.display, icon: Lock },
            { label: "Paid lifetime", hint: "Everything ever paid out", value: wallet?.paidLifetime.display, icon: Landmark },
          ].map((c) => (
            <div key={c.label} className="rounded-xl bg-base-800 p-4 ring-1 ring-base-600">
              <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-signal-dim">
                <c.icon size={12} /> {c.label}
              </p>
              <p className="mt-1 text-xl font-bold text-signal">{c.value ?? "$0.00"}</p>
              <p className="mt-0.5 text-[11px] leading-tight text-signal-faint">{c.hint}</p>
            </div>
          ))}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold uppercase text-signal-dim">Payouts</h2>
          <div className="rounded-xl bg-base-800 p-4 ring-1 ring-base-600">
            {status?.payouts.configured ? (
              <p className="text-sm text-signal-dim">
                {status.payouts.enabled
                  ? "Payouts are active. Available funds pay out weekly."
                  : "Finish payout onboarding to withdraw your available balance."}
              </p>
            ) : (
              <p className="text-sm text-signal-dim">
                Withdrawals aren't switched on for this instance yet — your earnings accrue and are
                safe in the meantime, and every cent stays visible above. The operator has a one-time
                setup to complete before real payouts open.
              </p>
            )}
          </div>
        </section>

        <MembershipSection />

        <section>
          <h2 className="mb-2 text-sm font-bold uppercase text-signal-dim">Eligibility</h2>
          <div className="flex flex-col gap-1.5">
            {Object.entries(status?.requirements ?? {}).map(([key, req]) => (
              <div key={key} className="flex items-center gap-2.5 rounded-lg bg-base-800 px-3 py-2 ring-1 ring-base-600">
                {req.met ? (
                  <CheckCircle2 size={16} className="shrink-0 text-online" />
                ) : (
                  <Circle size={16} className="shrink-0 text-signal-faint" />
                )}
                <span className="min-w-0 flex-1 text-sm text-signal">{req.label}</span>
                {typeof req.value === "number" && typeof req.needed === "number" && !req.met && (
                  <span className="shrink-0 text-xs text-signal-faint">{req.value}/{req.needed}</span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold uppercase text-signal-dim">Earnings</h2>
          {!earnings?.length ? (
            <p className="rounded-xl bg-base-800 p-4 text-sm text-signal-faint ring-1 ring-base-600">
              Nothing yet. Tips, gifts, memberships and your share of the daily ad pool land here, itemised.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {earnings.map((e) => (
                <div key={e.id} className="flex items-center gap-3 rounded-lg bg-base-800 px-3 py-2 ring-1 ring-base-600">
                  <span className="min-w-0 flex-1 text-sm capitalize text-signal">{e.product}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                      e.status === "AVAILABLE" && "bg-online/20 text-online",
                      e.status === "PENDING" && "bg-accent/15 text-accent",
                      e.status === "REVERSED" && "bg-dnd/20 text-dnd",
                      e.status === "PAID" && "bg-base-600 text-signal-dim",
                    )}
                  >
                    {e.status}
                  </span>
                  <span className="w-20 shrink-0 text-right text-sm font-semibold text-signal">{e.amount.display}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
