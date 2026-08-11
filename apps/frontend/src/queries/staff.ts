import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VideoDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";

export type StaffQueueStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "REMOVED" | "FAILED";

export interface StaffAuditEntry {
  id: string;
  actionType: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  createdAt: string;
  actor: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
}

export function useStaffVideos(status: StaffQueueStatus) {
  return useQuery({
    queryKey: queryKeys.staffVideos(status),
    queryFn: () => api.get<VideoDTO[]>(`/staff/videos?status=${status}`),
  });
}

export function useStaffVideoCounts() {
  return useQuery({
    queryKey: queryKeys.staffVideoCounts(),
    queryFn: () => api.get<Record<string, number>>("/staff/videos/counts"),
    // Cheap aggregate that drives the "there is work waiting" badge, so it's worth keeping fresh
    // without the reviewer having to reload.
    refetchInterval: 30_000,
  });
}

export function useStaffAudit() {
  return useQuery({
    queryKey: queryKeys.staffAudit(),
    queryFn: () => api.get<StaffAuditEntry[]>("/staff/audit?limit=100"),
  });
}

/** Every moderation action invalidates all queue tabs plus the counts: a decision moves a video
 * from one tab to another, so refreshing only the current tab would leave the others stale. */
function useStaffAction<TArgs>(fn: (args: TArgs) => Promise<VideoDTO>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["staffVideos"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.staffVideoCounts() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.staffAudit() });
    },
  });
}

export function useApproveVideo() {
  return useStaffAction(({ videoId }: { videoId: string }) =>
    api.post<VideoDTO>(`/staff/videos/${videoId}/approve`, {}),
  );
}

export function useRejectVideo() {
  return useStaffAction(({ videoId, reason }: { videoId: string; reason: string }) =>
    api.post<VideoDTO>(`/staff/videos/${videoId}/reject`, { reason }),
  );
}

export function useRemoveVideo() {
  return useStaffAction(({ videoId, reason }: { videoId: string; reason: string }) =>
    api.post<VideoDTO>(`/staff/videos/${videoId}/remove`, { reason }),
  );
}

export function usePurgeVideoMedia() {
  return useStaffAction(({ videoId }: { videoId: string }) =>
    api.post<VideoDTO>(`/staff/videos/${videoId}/purge-media`, {}),
  );
}
