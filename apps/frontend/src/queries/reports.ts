import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export type TicketStatus = "OPEN" | "IN_PROGRESS" | "INVESTIGATING" | "COMPLETED" | "DISMISSED";

interface Person {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Ticket {
  id: string;
  status: TicketStatus;
  reason: string;
  details: string | null;
  createdAt: string;
  assignedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  reporter: Person | null;
  assignedTo: Person | null;
  resolvedBy: Person | null;
  totalReportsOnVideo: number;
  video: {
    id: string;
    caption: string | null;
    status: string;
    thumbnailUrl: string | null;
    playbackUrl: string | null;
    author: Person | null;
  };
}

export interface LeaderboardEntry {
  user: Person;
  resolved: number;
  dismissed: number;
  points: number;
  averageRating: number | null;
  ratedCount: number;
  averageHandlingHours: number | null;
}

export function useTickets(status: TicketStatus | "ALL") {
  return useQuery({
    queryKey: ["tickets", status],
    queryFn: () =>
      api.get<{ counts: Record<string, number>; reports: Ticket[] }>(
        `/staff/reports${status === "ALL" ? "" : `?status=${status}`}`,
      ),
    // Tickets are worked by several people at once, so a stale queue means two moderators opening
    // the same report. Short interval rather than manual refresh.
    refetchInterval: 20_000,
  });
}

export function useLeaderboard(days = 30) {
  return useQuery({
    queryKey: ["leaderboard", days],
    queryFn: () =>
      api.get<{ days: number; leaderboard: LeaderboardEntry[] }>(
        `/staff/reports/leaderboard?days=${days}`,
      ),
  });
}

function useTicketAction<T>(fn: (args: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // An action moves a ticket between tabs, so refreshing only the current one leaves the others
    // showing a ticket that has already moved.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
    },
    onError: (e) => reportError(e, "That action didn't go through"),
  });
}

export function useClaimTicket() {
  return useTicketAction(({ id, status }: { id: string; status: "IN_PROGRESS" | "INVESTIGATING" }) =>
    api.post(`/staff/reports/${id}/claim`, { status }),
  );
}

export function useReleaseTicket() {
  return useTicketAction(({ id }: { id: string }) => api.post(`/staff/reports/${id}/release`, {}));
}

export function useCompleteTicket() {
  return useTicketAction(
    ({ id, outcome, note }: { id: string; outcome: "COMPLETED" | "DISMISSED"; note: string }) =>
      api.post(`/staff/reports/${id}/complete`, { outcome, note }),
  );
}

export interface MyReport {
  id: string;
  status: TicketStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  rating: number | null;
  videoId: string;
}

export function useMyReports() {
  return useQuery({
    queryKey: ["myReports"],
    queryFn: () => api.get<{ reports: MyReport[] }>("/staff/reports/mine"),
  });
}

export function useRateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rating }: { id: string; rating: number }) =>
      api.post(`/staff/reports/${id}/rate`, { rating }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["myReports"] }),
    onError: (e) => reportError(e, "Couldn't save that rating"),
  });
}
