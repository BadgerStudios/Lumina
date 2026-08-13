import { Wallet, Clock, Lock, CheckCircle2, Circle, BadgeDollarSign, Landmark } from "lucide-react";
import { cn } from "../lib/cn";
import { useCreatorStatus, useCreatorWallet, useCreatorEarnings } from "../queries/economy";

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
              Nothing yet. Tips and gifts from your audience land here, itemised.
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
