import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError, toast } from "../store/toastStore";

export interface AdCampaign {
  id: string;
  name: string;
  status: string;
  cpmCents: number;
  totalBudgetCents: number;
  spentCents: number;
  /** UNFUNDED | PENDING | FUNDED | REFUNDED — separate from `status`, which is the review decision. */
  fundingStatus: string;
  paidCents: number;
  paidAt: string | null;
  startsAt: string;
  endsAt: string;
  targetTags: string[];
  impressionCount: number;
  clickCount: number;
  rejectionReason: string | null;
  createdAt: string;
  video: { id: string; caption: string | null; thumbnailUrl: string | null } | null;
}

/**
 * Impression and click beacons.
 *
 * Deliberately plain fire-and-forget calls rather than mutations: nothing in the UI depends on the
 * result, a failure must never surface to the viewer, and an automatic retry would double-bill an
 * advertiser. The server's per-viewer dedupe is the real protection.
 */
export function recordAdImpression(campaignId: string): void {
  void api.post(`/ads/campaigns/${campaignId}/impression`, {}).catch(() => undefined);
}

export function recordAdClick(campaignId: string): void {
  void api.post(`/ads/campaigns/${campaignId}/click`, {}).catch(() => undefined);
}

export function useMyCampaigns() {
  return useQuery({
    queryKey: ["ads", "campaigns"],
    queryFn: () => api.get<AdCampaign[]>("/ads/campaigns"),
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      videoId: string;
      cpmCents: number;
      totalBudgetCents: number;
      startsAt: string;
      endsAt: string;
      targetTags?: string[];
    }) => api.post<AdCampaign>("/ads/campaigns", body),
    onSuccess: () => {
      toast.success("Campaign submitted for review");
      void queryClient.invalidateQueries({ queryKey: ["ads", "campaigns"] });
    },
    onError: (e) => reportError(e, "Couldn't create that campaign"),
  });
}

export function useSetCampaignPaused() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      api.patch<AdCampaign>(`/ads/campaigns/${id}`, { paused }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ads", "campaigns"] }),
    onError: (e) => reportError(e, "Couldn't change that campaign"),
  });
}

export function useAdReviewQueue() {
  return useQuery({
    queryKey: ["ads", "review"],
    queryFn: () =>
      api.get<Array<AdCampaign & { advertiser: { id: string; username: string } | null }>>("/ads/review"),
  });
}

export function useReviewCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approve, reason }: { id: string; approve: boolean; reason?: string }) =>
      api.post(`/ads/review/${id}`, { approve, reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ads", "review"] });
      void queryClient.invalidateQueries({ queryKey: ["ads", "revenue"] });
    },
    onError: (e) => reportError(e, "Couldn't record that decision"),
  });
}

export interface AdRevenue {
  accruedCents: number;
  impressions: number;
  clicks: number;
  /** True now that campaigns are prepaid through Stripe. */
  collected: boolean;
  /** Money actually taken, summed from what Stripe reported collecting. */
  collectedCents: number;
  /** Collected but not yet delivered against — inventory still owed to advertisers. */
  unearnedCents: number;
  fundedCampaigns: number;
  /** Approved but not paid for: demand that hasn't converted. */
  awaitingPaymentCampaigns: number;
  days: Array<{ day: string; impressions: number; clicks: number; accruedCents: number }>;
}

/**
 * Starts Stripe Checkout for an approved campaign and hands off to the hosted page.
 *
 * A full navigation rather than a new tab: Stripe redirects back to /settings/advertising when it
 * finishes, and a popup would leave the original tab showing stale campaign state with no signal
 * that anything happened.
 */
export function useFundCampaign() {
  return useMutation({
    mutationFn: (id: string) => api.post<{ url: string }>(`/ads/campaigns/${id}/checkout`),
    onSuccess: (r) => {
      if (r.url) window.location.href = r.url;
    },
    onError: (e) => reportError(e, "Couldn't start checkout"),
  });
}

export function useAdRevenue() {
  return useQuery({ queryKey: ["ads", "revenue"], queryFn: () => api.get<AdRevenue>("/ads/revenue") });
}
