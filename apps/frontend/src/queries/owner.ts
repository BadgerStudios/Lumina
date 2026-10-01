import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlatformRole, UserDTO, VideoDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export interface DaySeries {
  date: string;
  count: number;
}

export interface PlatformStats {
  users: { total: number; online: number; onlineBots: number; newToday: number; newThisWeek: number; series: DaySeries[] };
  servers: { total: number };
  messages: { total: number; today: number; series: DaySeries[] };
  videos: { total: number; pendingReview: number; storedBytes: number; series: DaySeries[] };
  moderation: { openReports: number; pendingAppeals: number; activeBans: number; ageBlocks: number };
}

export interface AttentionItem {
  kind: string;
  label: string;
  count: number;
  /** Where this opens in the web app. */
  href: string;
  /** Where it opens in the owner console, which navigates by internal state and has no URLs. */
  section: string;
  /** "urgent" | "action" | "warn" | "info", decided by the server alongside the count. */
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
  /** "PENDING" while the sign-up waits for the owner's age decision. */
  ageReview?: string | null;
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

export interface EngagementDTO {
  daily: { day: string; users: number }[];
  weekly: { week: string; users: number }[];
  cohorts: { cohort: string; size: number; weeks: number[] }[];
}

export function useEngagement() {
  return useQuery({
    queryKey: ["owner", "engagement"],
    queryFn: () => api.get<EngagementDTO>("/owner/engagement"),
    refetchInterval: 300_000, // derived live from activity tables; five minutes is plenty
  });
}

export interface GrowthFunnel {
  signedUp: number;
  confirmedEmail: number;
  inAServer: number;
  sentAMessage: number;
  cameBack: number;
}

export interface GrowthDTO {
  funnel: { last30Days: GrowthFunnel; allTime: GrowthFunnel };
  reach: { humans: number; reachable: number; phones: number; browsers: number };
  pushes7d: { delivered: number; failed: number; nowhere: number; skipped: number };
  /** Absent from a backend older than build 129. */
  lost?: { installs30d: number; users30d: number; tracking: boolean };
}

export function useGrowth() {
  return useQuery({
    queryKey: ["owner", "growth"],
    queryFn: () => api.get<GrowthDTO>("/owner/growth"),
    refetchInterval: 300_000,
  });
}

export function usePlatformStats() {
  return useQuery({
    queryKey: ["owner", "stats"],
    queryFn: () => api.get<PlatformStats>("/owner/stats"),
    // 15s, not 60s: "online now" is the one figure here that is meaningless if it is a minute old.
    refetchInterval: 15_000,
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
  /** Newest first, at most six; the same shape the staff queue renders. */
  recentVideos: VideoDTO[];
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
    // Provenance is left alone: each read of it writes a staff audit row, so it is fetched only when
    // the owner opens it, never as a side effect of some other action.
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["owner"], predicate: (q) => q.queryKey[1] !== "provenance" }),
    // A failed ban, unban, role change, or appeal decision previously failed completely silently
    // — the dialog closed as if it had worked, same root cause as staff.ts/reports.ts before they
    // were fixed earlier this session.
    onError: (e) => reportError(e, "That action didn't go through"),
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

export interface StoreStats {
  github: {
    repo: string;
    total: number;
    last7Days: number;
    byPlatform: Array<{ platform: string; count: number }>;
    updatedAt: string | null;
  };
  play: {
    connected: boolean;
    serviceAccount: string | null;
    installsTotal: number;
    installsLast7Days: number;
    uninstallsLast7Days: number;
    uninstallsLast30Days: number;
    activeInstalls: number | null;
    latestDay: string | null;
    updatedAt: string | null;
  };
  series: Array<{ date: string; github: number; playInstalls: number; playUninstalls: number }>;
}

export interface InstallStats {
  tracking: boolean;
  activeInstalls: Array<{ app: string; platform: string; count: number }>;
  lostLast7Days: number;
  lostLast30Days: number;
  lostTotal: number;
  lostUsers30Days: number;
  series: Array<{ date: string; lost: number; installed: number }>;
}

export interface BusinessMetrics {
  revenue: RevenueStats;
  downloads: DownloadStats;
  bandwidth: BandwidthDay[];
  /** Absent from a backend older than build 129. */
  store?: StoreStats;
  installs?: InstallStats;
}

/**
 * Every download Lumina can count, as one number: the site's own counted links, GitHub release
 * assets and Google Play installs. The owner console's own APK is left out of all three - it is a
 * staff tool, not a user download.
 */
export function combinedDownloads(b: BusinessMetrics | undefined) {
  if (!b) return { total: 0, last7Days: 0 };
  const siteOwner = b.downloads.byPlatform.find((p) => p.platform === "android-owner")?.count ?? 0;
  const ghOwner = b.store?.github.byPlatform.find((p) => p.platform === "android-owner")?.count ?? 0;
  const ghUser = (b.store?.github.byPlatform ?? []).reduce((n, p) => n + p.count, 0) - ghOwner;
  return {
    total: b.downloads.total - siteOwner + ghUser + (b.store?.play.installsTotal ?? 0),
    last7Days: b.downloads.last7Days + (b.store?.github.last7Days ?? 0) + (b.store?.play.installsLast7Days ?? 0),
  };
}

export function useBusinessMetrics() {
  return useQuery({
    queryKey: ["owner", "business"],
    queryFn: () => api.get<BusinessMetrics>("/owner/business"),
    refetchInterval: 60_000,
  });
}

// ---- Age review (owner decision 2026-10-01): held sign-ups the owner approves or denies ----

export interface AgeQueuePending {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  createdAt: string;
  ageBracket: string | null;
  birthDate: string | null;
  reason: string | null;
  country: string | null;
  client: string | null;
  device: string;
  otherAccountsOnDevice: number;
}

export interface AgeQueueRefused {
  id: string;
  reasonCode: string;
  detail: string | null;
  createdAt: string;
  country: string | null;
  client: string | null;
  device: string | null;
  hasProvenance: boolean;
  heldForReview: boolean;
  active: boolean;
}

export interface AgeQueue {
  pending: AgeQueuePending[];
  refused: AgeQueueRefused[];
  decided: Array<{ id: string; username: string; reason: string | null; decidedAt: string | null; minor: boolean }>;
}

export function useAgeQueue() {
  return useQuery({
    queryKey: ["owner", "age-queue"],
    queryFn: () => api.get<AgeQueue>("/owner/age-queue"),
    refetchInterval: 30_000,
  });
}

export function useDecideHeldSignup() {
  return useOwnerMutation(
    ({ userId, decision, note }: { userId: string; decision: "APPROVE" | "DENY"; note?: string }) =>
      api.post<{ ok: true; decision: string; minor?: boolean }>(`/owner/age-queue/${userId}/decide`, { decision, note }),
  );
}

export interface UserProvenance {
  signup: { at: string; ip: string | null; userAgent: string | null; device: string | null; client: string | null; country: string | null; recorded: boolean };
  account: { email: string; emailVerified: boolean; ageBracket: string | null; birthDate: string | null; isMinor: boolean; ageReview: string | null; ageReviewReason: string | null };
  devices: Array<{ device: string; userAgent: string | null; ips: string[]; firstSeen: string; lastSeen: string; sessions: number; active: number }>;
  apps: Array<{ app: string; platform: string; build: number | null; installedAt: string; lastSeen: string }>;
  otherAccountsOnTheseDevices: Array<{ id: string; username: string }>;
  flags: Array<{ id: string; reasonCode: string; detail: string | null; createdAt: string; active: boolean; resolvedAt: string | null }>;
}

export interface FlagProvenance {
  id: string;
  reasonCode: string;
  detail: string | null;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  device: string | null;
  country: string | null;
  client: string | null;
  purgedAt: string | null;
  otherFlagsFromThisDevice: number;
  otherFlagsFromThisAddress: number;
}

/** Provenance reads are audited server-side, so they only run when the owner opens them. */
export function useUserProvenance(userId: string | null) {
  return useQuery({
    queryKey: ["owner", "provenance", "user", userId],
    queryFn: () => api.get<UserProvenance>(`/owner/users/${userId}/provenance`),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

export function useFlagProvenance(flagId: string | null) {
  return useQuery({
    queryKey: ["owner", "provenance", "flag", flagId],
    queryFn: () => api.get<FlagProvenance>(`/owner/flags/${flagId}/provenance`),
    enabled: !!flagId,
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

/** Resolves one flag. On an under-13 refusal or a denial this lifts the device's sign-up cooldown. */
export function useResolveFlag() {
  return useOwnerMutation(({ flagId }: { flagId: string }) => api.post(`/master/flags/${flagId}/resolve`, {}));
}
