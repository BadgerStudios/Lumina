import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError, toast } from "../store/toastStore";

export interface OpsContainer {
  name: string;
  service: string;
  state: string;
  /** "" when the service declares no healthcheck — which is NOT unhealthy. */
  health: string;
  status: string;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
  startedAt: string | null;
}

export interface OpsStatus {
  agentOnline: boolean;
  lastSeenAt: string | null;
  snapshot: {
    agentId: string;
    agentVersion: string;
    reportedAt: string;
    host: {
      hostname: string;
      uptimeSeconds: number;
      loadAverage: number[];
      cpuCount: number;
      memTotalBytes: number;
      memAvailableBytes: number;
      diskTotalBytes: number | null;
      diskFreeBytes: number | null;
    };
    containers: OpsContainer[];
    dockerError?: string | null;
  } | null;
  commands: Array<{
    id: string;
    action: string;
    target: string;
    status: string;
    result: string | null;
    createdAt: string;
    finishedAt: string | null;
    requestedBy: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  }>;
}

/** Polled at half the agent's own 30s cycle, so a change is on screen within about fifteen seconds
 * of the agent noticing it without the page ever waiting a full cycle to catch up. */
export function useOpsStatus() {
  return useQuery({
    queryKey: ["ops", "status"],
    queryFn: () => api.get<OpsStatus>("/ops/status"),
    refetchInterval: 15_000,
  });
}

export interface OpsHistoryPoint {
  at: string;
  load1: number;
  memPercent: number;
  diskPercent: number | null;
  unhealthy: number;
}

export function useOpsHistory(hours = 6) {
  return useQuery({
    queryKey: ["ops", "history", hours],
    queryFn: () => api.get<{ windowHours: number; points: OpsHistoryPoint[] }>(`/ops/history?hours=${hours}`),
    refetchInterval: 60_000,
  });
}

/**
 * Asks the agent to do something.
 *
 * 202, not 200 — the command has been queued, not performed. The UI reflects that: the button
 * settles into "queued" and the real outcome arrives on the next status poll, because pretending a
 * restart is instant is how you get someone clicking it four times.
 */
export function useOpsCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "restart" | "start" | "stop"; target: string }) =>
      api.post<{ id: string; status: string }>("/ops/commands", body),
    onSuccess: (_r, body) => {
      toast.success(`Queued: ${body.action} ${body.target}`);
      void queryClient.invalidateQueries({ queryKey: ["ops", "status"] });
    },
    onError: (e) => reportError(e, "Couldn't queue that action"),
  });
}
