import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

interface Money { minor: string; display: string }

export interface CreatorWalletDTO {
  pending: Money; available: Money; reserved: Money; paidLifetime: Money; currency: string;
}
export interface CreatorStatusDTO {
  state: "NOT_ELIGIBLE" | "LIMITED" | "CREATOR" | "SUSPENDED" | "PAYOUT_RESTRICTED";
  requirements: Record<string, { met: boolean; label: string; value?: number; needed?: number; gate?: string }>;
  payouts: { configured: boolean; onboarded: boolean; enabled: boolean };
}
export interface EarningItemDTO {
  id: string; product: string; amount: Money; status: "PENDING" | "AVAILABLE" | "REVERSED" | "PAID";
  availableAt: string; createdAt: string;
}
export interface GiftDTO { key: string; name: string; emoji: string; priceCoins: number }

export function useCreatorStatus(enabled = true) {
  return useQuery({ queryKey: ["creator", "status"], queryFn: () => api.get<CreatorStatusDTO>("/economy/creator/status"), enabled });
}
export function useCreatorWallet(enabled = true) {
  return useQuery({ queryKey: ["creator", "wallet"], queryFn: () => api.get<CreatorWalletDTO>("/economy/creator/wallet"), enabled });
}
export function useCreatorEarnings(enabled = true) {
  return useQuery({ queryKey: ["creator", "earnings"], queryFn: () => api.get<EarningItemDTO[]>("/economy/creator/earnings"), enabled });
}
export function useGiftCatalog() {
  return useQuery({ queryKey: ["gifts"], queryFn: () => api.get<GiftDTO[]>("/economy/gifts/catalog"), staleTime: 300_000 });
}
export function useSendGift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { giftKey: string; creatorId: string; contentRef?: string }) =>
      api.post<{ sent: boolean; gift: { emoji: string; name: string } }>("/economy/gifts/send", body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["coins"] }),
  });
}
export function useSendTip() {
  return useMutation({
    mutationFn: (body: { creatorId: string; amountMinor: number; contentRef?: string }) =>
      api.post<{ checkoutUrl: string }>("/economy/tips", body),
  });
}

// ---------------------------------------------------------------- memberships

export interface TierDTO { name: string; description: string | null; priceMinor: number; active?: boolean }
export interface CreatorTierViewDTO {
  tier: TierDTO | null;
  myMembership: { status: "INCOMPLETE" | "ACTIVE" | "PAST_DUE"; currentPeriodEnd: string | null } | null;
}

export function useMyTier(enabled = true) {
  return useQuery({
    queryKey: ["membership", "myTier"],
    queryFn: () => api.get<{ tier: TierDTO | null; supporters: number }>("/economy/creator/tier"),
    enabled,
  });
}

export function useSaveTier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string | null; priceMinor: number; active: boolean }) =>
      api.put("/economy/creator/tier", body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["membership", "myTier"] }),
  });
}

export function useCreatorTier(creatorId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["membership", "tier", creatorId],
    queryFn: () => api.get<CreatorTierViewDTO>(`/economy/creators/${creatorId}/tier`),
    enabled: enabled && !!creatorId,
  });
}

export function useSubscribeMembership() {
  return useMutation({
    mutationFn: (body: { creatorId: string }) =>
      api.post<{ checkoutUrl: string }>("/economy/memberships/subscribe", body),
  });
}

export function useCancelMembership() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (creatorId: string) =>
      api.post<{ ok: boolean; endsAt: string | null }>(`/economy/memberships/${creatorId}/cancel`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["membership"] }),
  });
}

export function useSupporters(enabled = true) {
  return useQuery({
    queryKey: ["membership", "supporters"],
    queryFn: () =>
      api.get<{ member: { id: string; username: string; displayName: string | null; avatarUrl: string | null }; priceMinor: number; since: string }[]>(
        "/economy/creator/supporters",
      ),
    enabled,
  });
}
