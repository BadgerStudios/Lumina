import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError, toast } from "../store/toastStore";

export interface AddonSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string;
  updatedAt: string;
}

export interface AddonManifest {
  slug: string;
  name: string;
  version: string;
  automations: Array<{
    name: string;
    on: string;
    when: Record<string, unknown>;
    then: Array<{ type: string; emoji?: string; text?: string }>;
  }>;
}

export interface AddonInstall {
  id: string;
  enabled: boolean;
  installedAt: string;
  installedBy: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  addon: AddonSummary & { manifest: AddonManifest };
  botUser: { id: string; username: string } | null;
  /** True when the manifest uses a `reply` action, which needs the publishing application's bot. */
  needsBot: boolean;
}

/** The public directory. Unauthenticated on the server too — a manifest is published documentation,
 * and someone deciding whether to install one should be able to read it first. */
export function useAddonDirectory(query: string) {
  return useQuery({
    queryKey: ["addons", "directory", query],
    queryFn: () => api.get<AddonSummary[]>(`/addons${query ? `?q=${encodeURIComponent(query)}` : ""}`),
    staleTime: 60_000,
  });
}

export function useServerAddons(serverId: string) {
  return useQuery({
    queryKey: ["addons", "server", serverId],
    queryFn: () => api.get<AddonInstall[]>(`/servers/${serverId}/addons`),
    enabled: Boolean(serverId),
  });
}

export function useInstallAddon(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.post(`/servers/${serverId}/addons`, { slug }),
    onSuccess: () => {
      toast.success("Addon installed");
      void queryClient.invalidateQueries({ queryKey: ["addons", "server", serverId] });
    },
    onError: (e) => reportError(e, "Couldn't install that addon"),
  });
}

export function useSetAddonEnabled(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ installId, enabled }: { installId: string; enabled: boolean }) =>
      api.patch(`/servers/${serverId}/addons/${installId}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["addons", "server", serverId] }),
    onError: (e) => reportError(e, "Couldn't change that addon"),
  });
}

export function useUninstallAddon(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (installId: string) => api.delete(`/servers/${serverId}/addons/${installId}`),
    onSuccess: () => {
      toast.success("Addon removed");
      void queryClient.invalidateQueries({ queryKey: ["addons", "server", serverId] });
    },
    onError: (e) => reportError(e, "Couldn't remove that addon"),
  });
}
