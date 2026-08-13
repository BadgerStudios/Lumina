import { useMutation, useQuery } from "@tanstack/react-query";
import type { SlashCommandDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

interface InvokeResult {
  interactionId: string;
  /** Null when the bot answered; a human-readable reason when it did not. */
  timedOut: string | null;
}

/** The commands a `/` palette can offer in this server — only from bots actually present here. */
export function useServerCommands(serverId: string | undefined) {
  return useQuery<SlashCommandDTO[]>({
    queryKey: ["slash-commands", serverId],
    queryFn: () => api.get(`/interactions/commands/server/${serverId}`),
    enabled: !!serverId,
    staleTime: 60 * 1000,
  });
}

export function useInvokeCommand() {
  return useMutation({
    mutationFn: (input: {
      channelId?: string;
      dmConversationId?: string;
      name: string;
      options: Record<string, string | number | boolean>;
    }) => api.post<InvokeResult>("/interactions/invoke", input),
    // Deliberately no onError toast: the caller renders the failure inline next to the composer,
    // where the command was typed, which is where the person is looking.
  });
}

export function useClickComponent() {
  return useMutation({
    mutationFn: (input: { messageId: string; customId: string; values?: string[] }) =>
      api.post<InvokeResult>("/interactions/component", input),
    onError: (e) => reportError(e, "That control didn't work"),
  });
}
