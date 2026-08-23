import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export interface ServerEventDTO {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  channelId: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string | null;
  canceledAt: string | null;
  creator: { id: string; username: string; displayName: string | null } | null;
  goingCount: number;
  interestedCount: number;
  myRsvp: "GOING" | "INTERESTED" | null;
}

export function useServerEvents(serverId: string | undefined) {
  return useQuery({
    queryKey: ["events", serverId],
    queryFn: () => api.get<ServerEventDTO[]>(`/servers/${serverId}/events`),
    enabled: !!serverId,
  });
}

export function useCreateEvent(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string | null;
      channelId?: string | null;
      location?: string | null;
      startsAt: string;
      endsAt?: string | null;
    }) => api.post<{ id: string }>(`/servers/${serverId}/events`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["events", serverId] }),
  });
}

export function useCancelEvent(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) => api.delete(`/servers/${serverId}/events/${eventId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["events", serverId] }),
    onError: (e) => reportError(e, "Couldn't cancel that event"),
  });
}

export function useRsvp(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, status }: { eventId: string; status: "GOING" | "INTERESTED" | null }) =>
      status === null
        ? api.delete(`/servers/${serverId}/events/${eventId}/rsvp`)
        : api.put(`/servers/${serverId}/events/${eventId}/rsvp`, { status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["events", serverId] }),
    onError: (e) => reportError(e, "Couldn't update your RSVP"),
  });
}
