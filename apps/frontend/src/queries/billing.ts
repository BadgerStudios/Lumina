import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export interface BillingPlan {
  key: string;
  name: string;
  description: string;
  /** False when the server has no price id configured for this plan — the plan is real but cannot
   * be bought yet. Distinguished from `configured` so the UI can say which of the two is missing. */
  available: boolean;
}

export interface BillingConfig {
  configured: boolean;
  publishableKey: string | null;
  plans: BillingPlan[];
}

export interface SubscriptionState {
  active: boolean;
  subscription: {
    planKey: string;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

/** Public and unauthenticated on the server, so the pricing surface works before someone signs in. */
export function useBillingConfig() {
  return useQuery({
    queryKey: ["billing", "config"],
    queryFn: () => api.get<BillingConfig>("/billing/config"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSubscription() {
  return useQuery({
    queryKey: ["billing", "subscription"],
    queryFn: () => api.get<SubscriptionState>("/billing/subscription"),
    // A subscription changes via a Stripe redirect, so the answer on returning to the tab is the
    // one that matters — hence a refetch on focus rather than a long stale time.
    refetchOnWindowFocus: true,
  });
}

/**
 * Starts Stripe Checkout.
 *
 * Card details never touch this app or this server: the response is a URL to Stripe's own hosted
 * page and the browser is sent there. That is what keeps Lumina entirely out of PCI scope, and it
 * is why there is no card form anywhere in this codebase.
 */
export function useStartCheckout() {
  return useMutation({
    mutationFn: (planKey: string) => api.post<{ url: string }>("/billing/checkout", { planKey }),
    onSuccess: ({ url }) => {
      if (url) window.location.href = url;
    },
    onError: (e) => reportError(e, "Couldn't start checkout"),
  });
}

/** Stripe's own billing portal — cancelling, changing card, invoices. Deliberately not rebuilt
 * here: Stripe already has to be the source of truth for all of it. */
export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: () => api.post<{ url: string }>("/billing/portal", {}),
    onSuccess: ({ url }) => {
      if (url) window.location.href = url;
    },
    onError: (e) => reportError(e, "Couldn't open the billing portal"),
  });
}
