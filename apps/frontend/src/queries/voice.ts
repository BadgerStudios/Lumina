import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { VoiceParticipantDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { useVoiceStore } from "../store/voiceStore";

/** One-time snapshot of "who's in which voice channel" for a server, fetched on load and
 * merged into voiceStore's `roster` (see that store's seedRoster) — live changes after that
 * come from ServerEvents.VOICE_ROSTER_UPDATE (see socket/useSocketEvents.ts), not from this
 * query re-running, so no polling here.
 */
export function useVoiceRoster(serverId: string | undefined): void {
  const seedRoster = useVoiceStore((s) => s.seedRoster);
  const { data } = useQuery({
    queryKey: queryKeys.voiceState(serverId ?? ""),
    queryFn: () => api.get<Record<string, VoiceParticipantDTO[]>>(`/servers/${serverId}/voice-state`),
    enabled: !!serverId,
  });

  useEffect(() => {
    if (data) seedRoster(data);
  }, [data, seedRoster]);
}
