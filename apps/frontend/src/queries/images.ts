import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";
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
  return useInfiniteQuery({
    queryKey: ["owner", "images", filter],
    // The server pages at 24 and hands back a cursor; this ignored it, so a queue of 80 reported
    // images could only ever be worked 24 at a time with no way to see the rest.
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<ImageReviewPage>(`/owner/images?filter=${filter}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
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
    // Approve had no error surface at all: a failed approve looked like nothing happened.
    onError: (e) => reportError(e, "That image action didn't go through"),
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
