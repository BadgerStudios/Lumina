import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChannelDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { upsertChannel } from "../socket/cachePatches";

export function useChannels(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channels(serverId ?? ""),
    queryFn: () => api.get<ChannelDTO[]>(`/servers/${serverId}/channels`),
    enabled: !!serverId,
  });
}

export function useCreateChannel(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; type?: "TEXT" | "CATEGORY" | "VOICE"; topic?: string | null; parentId?: string | null }) =>
      api.post<ChannelDTO>(`/servers/${serverId}/channels`, body),
    onSuccess: (channel) => {
      // upsertChannel (not a raw append) — the creator's own socket now also receives the
      // realtime CHANNEL_CREATE broadcast for a server it just joined/created (see
      // socket/socketClient.ts's reconnectSocket fix), so this and useSocketEvents.ts's
      // onChannelCreate handler can both fire for the SAME creation. A raw append would
      // double-add the channel if the broadcast happens to arrive first; upsertChannel dedupes
      // by id regardless of which one runs first.
      queryClient.setQueryData<ChannelDTO[]>(queryKeys.channels(serverId), (old) => upsertChannel(old, channel));
    },
  });
}

export function useUpdateChannel(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      ...body
    }: {
      channelId: string;
      name?: string;
      topic?: string | null;
      parentId?: string | null;
      position?: number;
      slowmodeSeconds?: number;
      nsfw?: boolean;
    }) => api.patch<ChannelDTO>(`/channels/${channelId}`, body),
    onSuccess: (channel) => {
      queryClient.setQueryData<ChannelDTO[]>(queryKeys.channels(serverId), (old) =>
        old ? old.map((c) => (c.id === channel.id ? channel : c)) : old,
      );
    },
  });
}

export function useDeleteChannel(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.delete<void>(`/channels/${channelId}`),
    onSuccess: (_data, channelId) => {
      queryClient.setQueryData<ChannelDTO[]>(queryKeys.channels(serverId), (old) => old?.filter((c) => c.id !== channelId));
    },
  });
}

export function useReorderChannels(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (order: Array<{ id: string; position: number }>) =>
      api.patch<ChannelDTO[]>(`/servers/${serverId}/channels/reorder`, { order }),
    onSuccess: (channels) => {
      queryClient.setQueryData(queryKeys.channels(serverId), channels);
    },
  });
}

// ---------------------------------------------------------------- permission overwrites

/** Bitfields are decimal strings on the wire — see the backend's serializeOverwrite for why. */
export interface ChannelOverwriteDTO {
  channelId: string;
  targetType: "ROLE" | "USER";
  targetId: string;
  allow: string;
  deny: string;
}

export function useChannelOverwrites(channelId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channelOverwrites(channelId ?? ""),
    queryFn: () => api.get<ChannelOverwriteDTO[]>(`/channels/${channelId}/overwrites`),
    enabled: !!channelId,
  });
}

export function useSetChannelOverwrite(serverId: string, channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targetId, targetType, allow, deny }: { targetId: string; targetType: "ROLE" | "USER"; allow: bigint; deny: bigint }) =>
      api.put<ChannelOverwriteDTO>(`/channels/${channelId}/overwrites/${targetId}`, {
        targetType,
        allow: allow.toString(),
        deny: deny.toString(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelOverwrites(channelId) });
      // The acting user's own view of the channel list can change as a result of this — denying
      // @everyone VIEW_CHANNELS on a channel you can no longer see should remove it from your
      // own sidebar too, not just everyone else's.
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels(serverId) });
    },
  });
}

export function useClearChannelOverwrite(serverId: string, channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetId: string) => api.delete<void>(`/channels/${channelId}/overwrites/${targetId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelOverwrites(channelId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels(serverId) });
    },
  });
}
