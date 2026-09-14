import { useQuery } from "@tanstack/react-query";

/** Mirrors the response of GET /api/bans/:banId — see apps/backend/src/modules/bans/routes.ts. */
export interface BanStatusDTO {
  id: string;
  reason: string;
  scope: string;
  expiresAt: string | null;
  lifted: boolean;
  appealStatus: "NONE" | "PENDING" | "APPROVED" | "DENIED";
  appealResponse: string | null;
  createdAt: string;
}

/**
 * GET /api/bans/:banId is deliberately unauthenticated (see that route's docblock): a banned user
 * cannot authenticate, and possessing the ban id — a cuid, handed only to the banned party — is the
 * authorization. Fetched directly rather than through the shared `api` client (lib/apiClient.ts),
 * mirroring the appeal POST already in BanScreen.tsx: the api client's Authorization header,
 * refresh-on-401 and PQ handshake all exist for authenticated app traffic that this public,
 * possibly-session-less screen has no use for.
 */
async function fetchBanStatus(banId: string): Promise<BanStatusDTO> {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
  const res = await fetch(`${base}/bans/${banId}`);
  if (!res.ok) throw new Error("Could not load ban status");
  return res.json() as Promise<BanStatusDTO>;
}

/**
 * Live view of one ban, for BanScreen. The ban store only ever holds the payload from the original
 * 403 — a fine first paint, but it goes stale the moment an appeal is reviewed, so this refetches
 * the real row instead of trusting that snapshot forever.
 */
export function useBanStatus(banId: string | undefined) {
  return useQuery({
    queryKey: ["banStatus", banId],
    queryFn: () => fetchBanStatus(banId!),
    enabled: !!banId,
    retry: false,
  });
}
