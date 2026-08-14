import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

export interface ServerSandboxDTO {
  id: string;
  name: string;
  kind: string;
  status: "OFFLINE" | "STARTING" | "ONLINE" | "STOPPING" | "ERROR";
  online: boolean;
  connectAddress: string | null;
  playerCount: number;
  maxPlayers: number;
  consoleTail: string | null;
  isOwner: boolean;
}

/** The game sandboxes attached to a server — backs the in-server Game Activity panel. Polls so
 * the container's live state (status, players, console) streams in without a page refresh. */
export function useServerSandboxes(serverId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["sandbox", "server", serverId],
    queryFn: () => api.get<ServerSandboxDTO[]>(`/sandbox/server/${serverId}`),
    enabled: enabled && !!serverId,
    refetchInterval: 5000,
  });
}

export function useSandboxCommand(serverId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, command }: { id: string; command: "start" | "stop" | "restart" }) =>
      api.post(`/sandbox/${id}/command`, { command }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sandbox", "server", serverId] }),
  });
}
