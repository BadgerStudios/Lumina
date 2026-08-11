import { useQuery } from "@tanstack/react-query";
import type { MessageDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";

export function useSearch(serverId: string | undefined, q: string) {
  return useQuery({
    queryKey: queryKeys.search(serverId ?? "", q),
    queryFn: () => api.get<MessageDTO[]>(`/servers/${serverId}/search?q=${encodeURIComponent(q)}`),
    enabled: !!serverId && q.trim().length > 0,
  });
}
