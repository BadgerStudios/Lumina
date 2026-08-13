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
