import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

/** Public marketing-site stats (GET /api/site/stats). Unauthenticated — this is exactly what the
 * landing page is allowed to show a stranger: aggregates only, never a row attributable to a
 * person. `status` is "online" | "maintenance"; the third pill state, "offline", is inferred by the
 * client when this request fails outright (a reachable server is never offline by definition). */
export interface SiteStats {
  status: "online" | "maintenance";
  totals: {
    users: number;
    onlineNow: number;
    newUsersThisWeek: number;
    downloads: number;
    downloadsThisWeek: number;
    videos: number;
  };
  countries: Array<{ code: string; users: number; downloads: number; recent: number }>;
  note: string;
}

export function useSiteStats() {
  return useQuery({
    queryKey: ["site", "stats"],
    queryFn: () => api.get<SiteStats>("/site/stats"),
    // The count must visibly tick up as people join, so it polls every 10s in the foreground AND
    // refetches the instant the tab regains focus — a visitor who signs up in another tab and comes
    // back sees the new total right away. `/api/site/stats` reads a live COUNT each call (no cache),
    // so every poll reflects the true number. Background tabs stop polling (refetchIntervalInBackground
    // defaults off) so idle tabs aren't hammering the endpoint.
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    // One quick retry, then surface the error so the pill can show "offline" (red) rather than
    // spinning forever behind a dead backend.
    retry: 1,
    staleTime: 5_000,
  });
}
