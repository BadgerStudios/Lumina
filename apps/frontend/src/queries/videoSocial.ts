import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";

export interface VideoCommentDTO {
  id: string;
  videoId: string;
  content: string;
  createdAt: string;
  author: UserDTO | null;
}

export type ReportReason =
  | "SPAM"
  | "HARASSMENT"
  | "VIOLENCE"
  | "SEXUAL_CONTENT"
  | "HATE_SPEECH"
  | "SELF_HARM"
  | "ILLEGAL"
  | "OTHER";

/**
 * Lives beside the type rather than in the report modal, because the reporter now sees their reason
 * again later in "My reports" — two copies of these strings would drift and show one wording when
 * filing and another when reading back.
 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SPAM: "Spam or misleading",
  HARASSMENT: "Harassment or bullying",
  HATE_SPEECH: "Hate speech",
  VIOLENCE: "Violence or dangerous acts",
  SEXUAL_CONTENT: "Sexual content",
  SELF_HARM: "Self-harm or suicide",
  ILLEGAL: "Illegal activity",
  OTHER: "Something else",
};

export function useVideoComments(videoId: string | null) {
  return useQuery({
    queryKey: ["videoComments", videoId],
    queryFn: () => api.get<VideoCommentDTO[]>(`/videos/${videoId}/comments`),
    enabled: Boolean(videoId),
  });
}

export function useCreateComment(videoId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.post<VideoCommentDTO>(`/videos/${videoId}/comments`, { content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["videoComments", videoId] });
      // commentCount lives on the video, which the feed caches separately.
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
  });
}

export function useDeleteComment(videoId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.delete(`/videos/comments/${commentId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["videoComments", videoId] });
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
  });
}

export function useReportVideo() {
  return useMutation({
    mutationFn: ({
      videoId,
      reason,
      details,
    }: {
      videoId: string;
      reason: ReportReason;
      details?: string;
    }) => api.post(`/videos/${videoId}/report`, { reason, details }),
  });
}
