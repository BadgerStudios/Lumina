import { useState } from "react";
import { X, Coins, Loader2, HandCoins } from "lucide-react";
import { cn } from "../../lib/cn";
import { useGiftCatalog, useSendGift, useSendTip } from "../../queries/economy";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/apiClient";

/**
 * The support sheet on a video: gifts (coins, instant, animated) and tips (card, via Stripe
 * checkout). Both routes say what the creator relationship is — a platform purchase that produces
 * creator earnings under platform terms, not a cash transfer — because pretending otherwise is
 * how tip UIs get people surprised at refund time.
 */
export function GiftSheet({ creatorId, creatorName, contentRef, onClose }: {
  creatorId: string;
  creatorName: string;
  contentRef: string;
  onClose: () => void;
}) {
  const { data: gifts } = useGiftCatalog();
  const { data: coins } = useQuery({
    queryKey: ["coins", "balance"],
    queryFn: () => api.get<{ balance: number }>("/store/inventory"),
  });
  const sendGift = useSendGift();
  const sendTip = useSendTip();
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tipBusy, setTipBusy] = useState(false);

  const balance = coins?.balance ?? 0;

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-base-500 bg-base-800/95 p-4 backdrop-blur">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-signal">Support {creatorName}</p>
        <button onClick={onClose} aria-label="Close" className="text-signal-dim hover:text-signal">
          <X size={18} />
        </button>
      </div>

      {flash ? (
        <p className="py-6 text-center text-2xl">{flash}</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            {(gifts ?? []).map((g) => (
              <button
                key={g.key}
                onClick={async () => {
                  setError(null);
                  try {
                    const res = await sendGift.mutateAsync({ giftKey: g.key, creatorId, contentRef });
                    setFlash(`${res.gift.emoji} sent!`);
                    setTimeout(onClose, 1200);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not send that gift.");
                  }
                }}
                disabled={sendGift.isPending || balance < g.priceCoins}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl bg-base-900 p-3 ring-1 ring-base-600",
                  balance < g.priceCoins ? "opacity-40" : "hover:ring-accent",
                )}
              >
                <span className="text-2xl">{g.emoji}</span>
                <span className="text-[11px] font-medium text-signal">{g.name}</span>
                <span className="flex items-center gap-0.5 text-[10px] text-signal-faint">
                  <Coins size={9} /> {g.priceCoins}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-center text-[11px] text-signal-faint">
            You have {balance} sparks · top up in Settings → Billing
          </p>

          <button
            onClick={async () => {
              setError(null);
              setTipBusy(true);
              try {
                const { checkoutUrl } = await sendTip.mutateAsync({ creatorId, amountMinor: 500, contentRef });
                window.location.href = checkoutUrl;
              } catch (e) {
                setError(e instanceof Error ? e.message : "Tipping isn't available right now.");
                setTipBusy(false);
              }
            }}
            disabled={tipBusy}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {tipBusy ? <Loader2 size={15} className="animate-spin" /> : <HandCoins size={15} />}
            Tip $5 by card
          </button>
          {error && <p className="mt-2 text-center text-xs text-dnd">{error}</p>}
        </>
      )}
    </div>
  );
}
