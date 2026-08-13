import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

export interface GameLinkDTO {
  provider: "MINECRAFT";
  externalId: string;
  externalName: string;
  skinUrl: string | null;
  verified: boolean;
  verifyCode?: string;
  createdAt: string;
}

export function useGameLinks() {
  return useQuery({ queryKey: ["gameLinks"], queryFn: () => api.get<GameLinkDTO[]>("/game/links") });
}

export function useLinkMinecraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.post<GameLinkDTO>("/game/minecraft/link", { username }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["gameLinks"] }),
  });
}

export function useUnlinkMinecraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/game/minecraft/link"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["gameLinks"] }),
  });
}

export interface MinecraftStatusDTO {
  configured: boolean;
  host?: string;
  online?: boolean;
  playersOnline?: number;
  playersMax?: number;
  version?: string;
  motd?: string;
}

export function useMinecraftStatus(serverId: string | undefined, configured: boolean) {
  return useQuery({
    queryKey: ["mcStatus", serverId],
    queryFn: () => api.get<MinecraftStatusDTO>(`/game/minecraft/status/${serverId}`),
    // Only polls when the server actually configured an address — 27 communities with no
    // Minecraft server should generate zero pings.
    enabled: !!serverId && configured,
    refetchInterval: 60_000,
  });
}

export interface ActivityDTO {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  url: string;
  iconUrl: string | null;
  appName?: string;
  createdAt: string;
}

export function useActivities(enabled = true) {
  return useQuery({ queryKey: ["activities"], queryFn: () => api.get<ActivityDTO[]>("/activities"), enabled });
}

export function useCreateActivity(applicationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; url: string; description?: string | null }) =>
      api.post<ActivityDTO>(`/applications/${applicationId}/activities`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["activities"] }),
  });
}

export function useDeleteActivity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/activities/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["activities"] }),
  });
}
