import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import type { RemovalBan } from "../components/common/BanOptions";

export type ImageFilter = "reported" | "pending" | "all" | "removed";

export interface ImageReviewRow {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  reviewStatus: "PENDING" | "APPROVED" | "REMOVED";
  reviewedAt: string | null;
  removalReason: string | null;
  author: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  location: string;
  messageId: string;
  messageContent: string;
  messageDeleted: boolean;
  reports: Array<{ id: string; reason: string; details: string | null; createdAt: string }>;
}

export interface ImageReviewPage {
  images: ImageReviewRow[];
  nextCursor: string | null;
  counts: { pending: number; reported: number };
}

export function useReviewImages(filter: ImageFilter) {
  return useQuery({
    queryKey: ["owner", "images", filter],
    queryFn: () => api.get<ImageReviewPage>(`/owner/images?filter=${filter}`),
    // The queue is worked alongside reports arriving, so a stale count is a queue you think is
    // empty. Cheap: one indexed page plus two counts.
    refetchInterval: 60_000,
  });
}

function useImageAction<T>(fn: (vars: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["owner", "images"] });
      // The Needs-attention cards on Overview count this queue, so they go stale the moment
      // anything here is decided.
      void queryClient.invalidateQueries({ queryKey: ["owner", "attention"] });
    },
  });
}

export function useApproveImage() {
  return useImageAction(({ id }: { id: string }) => api.post(`/owner/images/${id}/approve`));
}

export function useRemoveImage() {
  return useImageAction(({ id, reason, ban }: { id: string; reason: string; ban?: RemovalBan }) =>
    api.post(`/owner/images/${id}/remove`, { reason, ...(ban ? { ban } : {}) }),
  );
}
