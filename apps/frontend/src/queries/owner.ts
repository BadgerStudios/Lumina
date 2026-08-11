import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlatformRole, UserDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";

export interface DaySeries {
  date: string;
  count: number;
}

export interface PlatformStats {
  users: { total: number; newToday: number; newThisWeek: number; series: DaySeries[] };
  servers: { total: number };
  messages: { total: number; today: number; series: DaySeries[] };
  videos: { total: number; pendingReview: number; storedBytes: number; series: DaySeries[] };
  moderation: { openReports: number; pendingAppeals: number; activeBans: number; ageBlocks: number };
}

export interface AttentionItem {
  kind: string;
  label: string;
  count: number;
  href: string;
  severity: string;
}

export interface PlatformHealth {
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number; systemTotalBytes: number; systemFreeBytes: number };
  loadAverage: number[];
  database: { ok: boolean; latencyMs: number };
  redis: { ok: boolean; latencyMs: number };
  transcodeQueue: { waiting: number; active: number; failed: number; available: boolean };
  disk: { totalBytes: number; freeBytes: number } | null;
}

export interface OwnerUserRow extends UserDTO {
  email: string;
  platformRole: PlatformRole;
  createdAt: string;
  counts: { messages: number; videos: number; ownedServers: number };
  activeBan: { id: string; groupId: string; reason: string; expiresAt: string | null; appealStatus: string } | null;
}

export interface OwnerBanRow {
  id: string;
  groupId: string;
  reason: string;
  expiresAt: string | null;
  liftedAt: string | null;
  appealStatus: string;
  appealText: string | null;
  appealedAt: string | null;
  appealResponse: string | null;
  createdAt: string;
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null; email: string } | null;
  bannedBy: { id: string; username: string; displayName: string | null } | null;
  identifierCount: number;
}

export function usePlatformStats() {
  return useQuery({
    queryKey: ["owner", "stats"],
    queryFn: () => api.get<PlatformStats>("/owner/stats"),
    refetchInterval: 60_000,
  });
}

export function useAttentionItems() {
  return useQuery({
    queryKey: ["owner", "attention"],
    queryFn: () => api.get<{ items: AttentionItem[] }>("/owner/attention"),
    refetchInterval: 30_000,
  });
}

export function usePlatformHealth() {
  return useQuery({
    queryKey: ["owner", "health"],
    queryFn: () => api.get<PlatformHealth>("/owner/health"),
    // Health is the one panel where staleness is actively misleading — a green tick from two
    // minutes ago says nothing about now.
    refetchInterval: 15_000,
  });
}

export function useOwnerUsers(search: string, page: number) {
  return useQuery({
    queryKey: ["owner", "users", search, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "25" });
      if (search) params.set("q", search);
      return api.get<{
        total: number;
        page: number;
        limit: number;
        assignableRoles: PlatformRole[];
        users: OwnerUserRow[];
      }>(`/owner/users?${params.toString()}`);
    },
  });
}

/** The full picture of one account, as returned by GET /owner/users/:id.
 *
 * Typed properly rather than left as Record<string, unknown> — the route has returned all of this
 * from the day it was written, and the untyped signature is a large part of why nothing ever
 * rendered it: there was nothing to discover from the call site. */
export interface OwnerUserDetail {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string;
  platformRole: PlatformRole;
  createdAt: string;
  counts: { messages: number; videos: number; ownedServers: number; servers: number };
  servers: Array<{ id: string; name: string }>;
  /** IPs are unhashed here by design — the owner needs them to make an informed ban decision. */
  sessions: Array<{
    id: string;
    userAgent: string | null;
    ipAddress: string | null;
    createdAt: string;
    expiresAt: string;
  }>;
  bans: Array<{
    id: string;
    groupId: string;
    scope: string;
    reason: string;
    expiresAt: string | null;
    liftedAt: string | null;
    appealStatus: string | null;
    appealText: string | null;
    createdAt: string;
    bannedBy: { id: string; username: string; displayName: string | null } | null;
  }>;
}

export function useOwnerUserDetail(userId: string | null) {
  return useQuery({
    queryKey: ["owner", "user", userId],
    queryFn: () => api.get<OwnerUserDetail>(`/owner/users/${userId}`),
    enabled: Boolean(userId),
  });
}

export function useOwnerBans(onlyAppeals: boolean) {
  return useQuery({
    queryKey: ["owner", "bans", onlyAppeals],
    queryFn: () => api.get<OwnerBanRow[]>(`/owner/bans${onlyAppeals ? "?appeals=true" : ""}`),
  });
}

function useOwnerMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // Any owner action can move counts across several panels at once (banning changes stats, the
    // user list and the ban list), so the whole owner namespace is refreshed rather than guessing.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["owner"] }),
  });
}

export function useBanUser() {
  return useOwnerMutation(
    ({
      userId,
      ...body
    }: {
      userId: string;
      reason: string;
      durationDays: number | null;
      banEmail: boolean;
      banIp: boolean;
      banDevice: boolean;
    }) => api.post(`/owner/users/${userId}/ban`, body),
  );
}

export function useLiftBan() {
  return useOwnerMutation(({ groupId }: { groupId: string }) =>
    api.post(`/owner/bans/${groupId}/lift`, {}),
  );
}

export function useResolveAppeal() {
  return useOwnerMutation(
    ({ groupId, approve, response }: { groupId: string; approve: boolean; response: string }) =>
      api.post(`/owner/bans/${groupId}/appeal`, { approve, response }),
  );
}

export function useSetPlatformRole() {
  return useOwnerMutation(({ userId, platformRole }: { userId: string; platformRole: PlatformRole }) =>
    api.patch(`/owner/users/${userId}/role`, { platformRole }),
  );
}

export interface RevenueStats {
  /** Distinguishes "no billing connected" from "connected and genuinely zero" — the dashboard must
   * never present the first as though it were the second. */
  configured: boolean;
  currency: string;
  grossCents: number;
  refundedCents: number;
  netCents: number;
  last30DaysCents: number;
  activeSubscriptions: number;
  series: Array<{ date: string; cents: number }>;
}

export interface DownloadStats {
  total: number;
  last7Days: number;
  byPlatform: Array<{ platform: string; count: number }>;
  series: Array<{ date: string; count: number }>;
}

export interface BandwidthDay {
  date: string;
  video: number;
  attachment: number;
  download: number;
  total: number;
}

export function useBusinessMetrics() {
  return useQuery({
    queryKey: ["owner", "business"],
    queryFn: () =>
      api.get<{ revenue: RevenueStats; downloads: DownloadStats; bandwidth: BandwidthDay[] }>(
        "/owner/business",
      ),
    refetchInterval: 60_000,
  });
}
