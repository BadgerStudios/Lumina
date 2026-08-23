import { useState } from "react";
import {
  useStoreCatalogue,
  usePurchaseItem,
  useTopUp,
  type StoreItem,
  type StoreItemKind,
} from "../queries/store";

/**
 * The store.
 *
 * Everything sold here is first-party cosmetic. Nothing that was free has been moved behind the
 * till: the existing seven themes and five accents stay free, and these are new items alongside
 * them. Taking a free feature away to sell it back is the fastest way to make a small community
 * resent a store.
 */

const KIND_LABEL: Record<StoreItemKind, string> = {
  THEME: "Themes",
  ACCENT: "Accents",
  BADGE: "Badges",
  PROFILE_EFFECT: "Profile effects",
};

const KIND_ORDER: StoreItemKind[] = ["THEME", "ACCENT", "BADGE", "PROFILE_EFFECT"];

export default function StoreRoute() {
  const { data, isLoading, error } = useStoreCatalogue();
  const purchase = usePurchaseItem();
  const topUp = useTopUp();
  const [confirming, setConfirming] = useState<StoreItem | null>(null);

  if (isLoading) {
    return <div className="p-8 text-signal-dim">Loading the store…</div>;
  }
  if (error || !data) {
    return <div className="p-8 text-signal-dim">The store couldn&apos;t be loaded right now.</div>;
  }

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: data.items.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    // Every sibling route owns a scrolling pane; this one had neither, so a long store simply
    // ran off the bottom of the shell with no way to reach it.
    <div className="lx-pane flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-6">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-signal">Store</h1>
          <p className="mt-1 text-sm text-signal-dim">
            Cosmetics for your account. Everything already free stays free.
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-base-800/60 px-4 py-2.5">
          <div className="text-xs uppercase tracking-wide text-signal-faint">Balance</div>
          <div className="text-lg font-semibold text-signal">
            {data.balance.toLocaleString()} <span className="text-accent">sparks</span>
          </div>
        </div>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-signal-faint">
          Top up
        </h2>
        {!data.topUpAvailable && (
          <p className="mb-3 rounded-lg border border-hairline bg-base-800/40 px-4 py-3 text-sm text-signal-dim">
            Payments aren&apos;t set up on this server yet, so sparks can&apos;t be bought. Everything
            else in the store works — an operator can still grant sparks.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {data.bundles.map((b) => (
            <button
              key={b.key}
              type="button"
              disabled={!data.topUpAvailable || topUp.isPending}
              onClick={() => topUp.mutate(b.key)}
              className="rounded-xl border border-hairline bg-base-800/60 px-4 py-4 text-left transition-colors hover:bg-base-700/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="text-base font-semibold text-signal">{b.label}</div>
              <div className="mt-0.5 text-xs text-signal-faint">
                {data.topUpAvailable ? "Buy with card" : "Unavailable"}
              </div>
            </button>
          ))}
        </div>
      </section>

      {grouped.map((group) => (
        <section key={group.kind} className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-signal-faint">
            {KIND_LABEL[group.kind]}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.items.map((item) => {
              const affordable = data.balance >= item.priceCoins;
              return (
                <div
                  key={item.id}
                  className="flex flex-col justify-between rounded-xl border border-hairline bg-base-800/60 p-4"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold text-signal">{item.name}</h3>
                      {item.owned && (
                        <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                          Owned
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-signal-dim">{item.description}</p>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-signal">
                      {item.priceCoins.toLocaleString()} sparks
                    </span>
                    <button
                      type="button"
                      disabled={item.owned || !affordable || purchase.isPending}
                      onClick={() => setConfirming(item)}
                      // Not `disabled:opacity-40`: fading white-on-accent to 40% measured 2.13:1,
                      // which is a label you cannot read telling you why you cannot buy. A disabled
                      // control gets its own flat, legible treatment instead.
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-hairline disabled:bg-transparent disabled:text-signal-dim"
                    >
                      {item.owned ? "Owned" : affordable ? "Buy" : "Not enough"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Confirmation step, because a spend is not undoable and a mis-tap on a phone should not
          cost someone their balance. */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-hairline bg-base-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-signal">Buy {confirming.name}?</h3>
            <p className="mt-2 text-sm text-signal-dim">
              This costs {confirming.priceCoins.toLocaleString()} sparks. You&apos;ll have{" "}
              {(data.balance - confirming.priceCoins).toLocaleString()} left.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded-lg px-3 py-2 text-sm font-medium text-signal-dim hover:text-signal"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={purchase.isPending}
                onClick={() => {
                  const id = confirming.id;
                  setConfirming(null);
                  purchase.mutate(id);
                }}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {purchase.isPending ? "Buying…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
