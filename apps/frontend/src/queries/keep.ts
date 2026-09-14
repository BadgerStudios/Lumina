import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";
import type { UserDTO } from "@lumina/shared";

export interface SavedMessage {
  id: string;
  note: string | null;
  remindAt: string | null;
  createdAt: string;
  message: {
    id: string;
    content: string;
    deleted: boolean;
    createdAt: string;
    author: UserDTO | null;
    channelId: string | null;
    dmConversationId: string | null;
    /** Where it was said, in words — a channel id tells you nothing when you come back to it. */
    location: string;
    serverId: string | null;
  };
}

export function useSavedMessages() {
  return useQuery({
    queryKey: ["saved"],
    queryFn: () => api.get<{ saved: SavedMessage[]; nextCursor: string | null }>("/keep/saved"),
  });
}

function useSavedAction<T>(fn: (args: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["saved"] }),
    onError: (e) => reportError(e, "Couldn't save that"),
  });
}

export function useSaveMessage() {
  return useSavedAction(
    ({ messageId, note, remindAt }: { messageId: string; note?: string; remindAt?: string }) =>
      api.post("/keep/saved", { messageId, ...(note ? { note } : {}), ...(remindAt ? { remindAt } : {}) }),
  );
}

export function useUnsaveMessage() {
  return useSavedAction(({ messageId }: { messageId: string }) =>
    api.delete(`/keep/saved/${messageId}`),
  );
}

export interface PrivateNote {
  body: string;
  updatedAt: string;
}

export function useUserNote(userId: string | null) {
  return useQuery({
    queryKey: ["note", userId],
    queryFn: () => api.get<{ note: PrivateNote | null }>(`/keep/notes/${userId!}`),
    enabled: Boolean(userId),
  });
}

export function useSetUserNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: string }) =>
      api.patch<{ note: PrivateNote | null }>(`/keep/notes/${userId}`, { body }),
    onSuccess: (_d, vars) => void queryClient.invalidateQueries({ queryKey: ["note", vars.userId] }),
    onError: (e) => reportError(e, "Couldn't save that note"),
  });
}

export interface Streak {
  days: number;
  best: number;
  /** True only on the visit that extended it, so this celebrates once rather than every render. */
  extendedToday: boolean;
}

/**
 * Records today's visit once per session.
 *
 * A mutation fired at app start rather than a query, because it writes — and deliberately not
 * wired into the API client, since a streak means "you came back", not "a background poll fired
 * from a tab nobody has looked at in a week".
 */
export function useTouchStreak() {
  return useMutation({
    mutationFn: () => api.post<Streak>("/keep/streak"),
  });
}
