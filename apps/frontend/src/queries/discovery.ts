import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserDTO, VideoDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reconnectSocket } from "../socket/socketClient";

export interface DiscoverServerDTO {
  id: string;
  name: string;
  iconUrl: string | null;
  description: string | null;
  memberCount: number;
  createdAt: string;
}

export interface DiscoveryDTO {
  newVideos: VideoDTO[];
  popularVideos: VideoDTO[];
  newServers: DiscoverServerDTO[];
  popularServers: DiscoverServerDTO[];
  people: UserDTO[];
  rotatesAt: string;
}

export function useDiscovery() {
  return useQuery({
    queryKey: ["discovery"],
    queryFn: () => api.get<DiscoveryDTO>("/discovery"),
    // The selection only changes on the server's rotation window, so aggressive refetching buys
    // nothing — it would return byte-identical data for hours.
    staleTime: 5 * 60_000,
  });
}

export function useJoinDiscoverableServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) => api.post(`/discovery/servers/${serverId}/join`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      // Same reason useJoinInvite does this: the already-connected socket never re-syncs its
      // server rooms on its own, so without a reconnect the new server is silent until a reload.
      reconnectSocket();
    },
  });
}
