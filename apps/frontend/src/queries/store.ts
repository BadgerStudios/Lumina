import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export type StoreItemKind = "THEME" | "ACCENT" | "BADGE" | "PROFILE_EFFECT";

export interface StoreItem {
  id: string;
  sku: string;
  kind: StoreItemKind;
  name: string;
  description: string;
  payload: Record<string, unknown>;
  priceCoins: number;
  owned: boolean;
}

export interface CoinBundle {
  key: string;
  coins: number;
  label: string;
}

export interface StoreCatalogue {
  items: StoreItem[];
  balance: number;
  bundles: CoinBundle[];
  /** False when the server has no Stripe keys. The shelf still renders — the UI says why buying is
   * unavailable rather than showing an empty page that looks broken. */
  topUpAvailable: boolean;
}

export function useStoreCatalogue() {
  return useQuery<StoreCatalogue>({
    queryKey: ["store", "catalogue"],
    queryFn: () => api.get("/store/catalogue"),
  });
}

// There is no `useInventory` here on purpose. One was written alongside the store and never called
// from anything — this repo's recurring "backend built, no UI calls it" bug, this time mine. It was
// also redundant: `/store/catalogue` already returns an `owned` flag per item, which is what the UI
// actually renders, so a second request for the same knowledge would only have made the two able to
// disagree. `GET /store/inventory` still exists server-side for anything that needs the acquisition
// dates; when a "My items" view is built, add the hook back with the component that uses it.

export function usePurchaseItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.post<{ purchased: boolean; sku: string; balance: number }>("/store/purchase", { itemId }),
    // Deliberately NOT optimistic. An optimistic balance that gets rolled back looks to the user
    // like sparks were taken and refunded, which is far more alarming than a half-second wait.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["store"] });
    },
    onError: reportError,
  });
}

export function useTopUp() {
  return useMutation({
    mutationFn: (bundleKey: string) => api.post<{ url: string }>("/store/top-up", { bundleKey }),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: reportError,
  });
}
