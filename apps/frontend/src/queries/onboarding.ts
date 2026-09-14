import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export interface OnboardingOption {
  id: string;
  label: string;
  description: string | null;
  emoji: string | null;
  roleIds: string[];
}

export interface OnboardingPrompt {
  id: string;
  title: string;
  multiple: boolean;
  options: OnboardingOption[];
}

export interface OnboardingConfig {
  enabled: boolean;
  welcomeTitle: string | null;
  welcomeBody: string | null;
  rules: string | null;
  requireRules: boolean;
  prompts: OnboardingPrompt[];
}

export interface MemberOnboardingState {
  config: OnboardingConfig;
  onboardedAt: string | null;
  rulesAcceptedAt: string | null;
  /** The server's answer to "should this person see the welcome screen right now". */
  due: boolean;
}

export function useOnboardingState(serverId: string | null) {
  return useQuery({
    queryKey: ["onboarding", serverId],
    queryFn: () => api.get<MemberOnboardingState>(`/servers/${serverId!}/onboarding`),
    enabled: Boolean(serverId),
    // Read once per server visit. Whether onboarding is due changes only when this person
    // completes it or a manager edits it, and both invalidate this key directly.
    staleTime: 5 * 60_000,
  });
}

export function useCompleteOnboarding(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ optionIds, acceptedRules }: { optionIds: string[]; acceptedRules: boolean }) =>
      api.post<MemberOnboardingState>(`/servers/${serverId}/onboarding/complete`, {
        optionIds,
        acceptedRules,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding", serverId] });
      // Onboarding grants roles, and roles decide which channels are visible — so the channel list
      // and the member's own roles are both stale the instant this returns.
      void queryClient.invalidateQueries({ queryKey: ["channels", serverId] });
      void queryClient.invalidateQueries({ queryKey: ["members", serverId] });
    },
    onError: (e) => reportError(e, "Couldn't finish setting you up"),
  });
}

export function useOnboardingConfig(serverId: string | null) {
  return useQuery({
    queryKey: ["onboardingConfig", serverId],
    queryFn: () => api.get<OnboardingConfig>(`/servers/${serverId!}/onboarding/config`),
    enabled: Boolean(serverId),
  });
}

export interface SaveOnboardingInput {
  enabled: boolean;
  welcomeTitle?: string | null;
  welcomeBody?: string | null;
  rules?: string | null;
  requireRules: boolean;
  prompts: Array<{
    title: string;
    multiple: boolean;
    options: Array<{ label: string; description?: string | null; emoji?: string | null; roleIds: string[] }>;
  }>;
}

export function useSaveOnboarding(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveOnboardingInput) =>
      api.patch<OnboardingConfig>(`/servers/${serverId}/onboarding/config`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["onboardingConfig", serverId] });
      void queryClient.invalidateQueries({ queryKey: ["onboarding", serverId] });
    },
    onError: (e) => reportError(e, "Couldn't save that"),
  });
}
