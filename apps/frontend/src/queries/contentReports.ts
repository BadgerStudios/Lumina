import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

/** Report reasons — must match the backend ReportReason enum (apps/backend/prisma/schema.prisma). */
export const REPORT_REASONS = [
  { value: "HARASSMENT", label: "Harassment or bullying" },
  { value: "SPAM", label: "Spam or scam" },
  { value: "HATE_SPEECH", label: "Hate speech" },
  { value: "SEXUAL_CONTENT", label: "Unwanted sexual content" },
  { value: "VIOLENCE", label: "Violence or threats" },
  { value: "SELF_HARM", label: "Self-harm or suicide" },
  { value: "ILLEGAL", label: "Illegal activity" },
  { value: "OTHER", label: "Something else" },
] as const;

export type ReportReasonCode = (typeof REPORT_REASONS)[number]["value"];

/** Report a user or a message. Feed videos have their own path (useReportVideo). */
export function useReportContent() {
  return useMutation({
    mutationFn: (input: { targetType: "USER" | "MESSAGE"; targetId: string; reason: ReportReasonCode; details?: string }) =>
      api.post<{ id: string }>("/reports", input),
  });
}
