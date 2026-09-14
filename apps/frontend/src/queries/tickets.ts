import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export type TicketCategory = "USER_REPORT" | "SYSTEM_FLAGGED" | "CUSTOMER_SUPPORT";
export type TicketKind = "message" | "video" | "image" | "user" | "support";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "INVESTIGATING" | "COMPLETED" | "RESOLVED" | "DISMISSED";

export interface TicketPerson {
  id: string;
  username: string;
  displayName: string | null;
  /** Read from the User row on every request, so a card always shows the current picture. */
  avatarUrl: string | null;
}

export interface TicketCard {
  ref: string;
  category: TicketCategory;
  kind: TicketKind;
  status: TicketStatus;
  subject: string;
  detail: string | null;
  createdAt: string;
  person: TicketPerson | null;
  about: TicketPerson | null;
  assignedTo: TicketPerson | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  replyCount: number;
  lastReplyAt: string | null;
}

export interface TicketMessage {
  id: string;
  body: string;
  fromStaff: boolean;
  internal: boolean;
  createdAt: string;
  author: TicketPerson | null;
}

export interface TicketDetail extends TicketCard {
  messages: TicketMessage[];
}

export interface TicketQueue {
  tickets: TicketCard[];
  counts: { open: number; mine: number; byCategory: Record<string, number> };
}

export type QueueStatus = "OPEN" | "ACTIVE" | "CLOSED" | "ALL";

export function useTicketQueue(params: { status: QueueStatus; category?: TicketCategory; mine?: boolean }) {
  const search = new URLSearchParams({ status: params.status });
  if (params.category) search.set("category", params.category);
  if (params.mine) search.set("mine", "true");
  return useQuery({
    queryKey: ["ticketQueue", params.status, params.category ?? "all", params.mine ?? false],
    queryFn: () => api.get<TicketQueue>(`/tickets?${search.toString()}`),
    // Several people work this queue at once, so a stale list means two moderators opening the same
    // ticket. Short interval rather than a manual refresh nobody remembers to press.
    refetchInterval: 20_000,
  });
}

export function useTicket(ref: string | null) {
  return useQuery({
    queryKey: ["ticket", ref],
    queryFn: () => api.get<TicketDetail>(`/tickets/detail/${encodeURIComponent(ref!)}`),
    enabled: Boolean(ref),
  });
}

function useTicketAction<T>(fn: (args: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      // An action moves a ticket between tabs, so refreshing only the open one leaves the others
      // showing something that has already moved.
      void queryClient.invalidateQueries({ queryKey: ["ticketQueue"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket"] });
      void queryClient.invalidateQueries({ queryKey: ["owner", "attention"] });
    },
    onError: (e) => reportError(e, "That action didn't go through"),
  });
}

export function useClaimTicket() {
  return useTicketAction(({ ref, status = "IN_PROGRESS" }: { ref: string; status?: "IN_PROGRESS" | "INVESTIGATING" }) =>
    api.post(`/tickets/detail/${encodeURIComponent(ref)}/claim`, { status }),
  );
}

export function useReleaseTicket() {
  return useTicketAction(({ ref }: { ref: string }) =>
    api.post(`/tickets/detail/${encodeURIComponent(ref)}/release`, {}),
  );
}

export function useReplyToTicket() {
  return useTicketAction(({ ref, body, internal }: { ref: string; body: string; internal: boolean }) =>
    api.post(`/tickets/detail/${encodeURIComponent(ref)}/reply`, { body, internal }),
  );
}

export function useCompleteTicket() {
  return useTicketAction(
    ({ ref, outcome, note }: { ref: string; outcome: "COMPLETED" | "DISMISSED"; note: string }) =>
      api.post(`/tickets/detail/${encodeURIComponent(ref)}/complete`, { outcome, note }),
  );
}

// ── a person's own tickets ───────────────────────────────────────────────────

export function useMyTickets() {
  return useQuery({
    queryKey: ["myTickets"],
    queryFn: () => api.get<{ tickets: TicketCard[] }>("/tickets/mine"),
  });
}

export function useMyTicket(ref: string | null) {
  return useQuery({
    queryKey: ["myTicket", ref],
    queryFn: () => api.get<TicketDetail>(`/tickets/mine/${encodeURIComponent(ref!)}`),
    enabled: Boolean(ref),
  });
}

export function useOpenSupportTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ subject, body }: { subject: string; body: string }) =>
      api.post<{ ref: string }>("/tickets/support", { subject, body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["myTickets"] }),
    onError: (e) => reportError(e, "Couldn't open that support ticket"),
  });
}

export function useReplyToMyTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, body }: { ref: string; body: string }) =>
      api.post(`/tickets/mine/${encodeURIComponent(ref)}/reply`, { body, internal: false }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["myTicket"] });
      void queryClient.invalidateQueries({ queryKey: ["myTickets"] });
    },
    onError: (e) => reportError(e, "Couldn't send that reply"),
  });
}
