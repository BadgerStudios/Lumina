import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { GifPageDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";

/**
 * The composer's GIF picker (KLIPY, proxied by the backend — see apps/backend/src/modules/gifs).
 * `enabled` is false until the server has a KLIPY key, and the composer shows no GIF button then.
 */
export function useGifConfig() {
  return useQuery({
    queryKey: ["gifs", "config"],
    queryFn: () => api.get<{ enabled: boolean }>("/gifs/config"),
    staleTime: 5 * 60_000,
  });
}

/** Trending when `query` is empty, search results otherwise; pages load as the grid scrolls. */
export function useGifFeed(query: string, enabled: boolean) {
  const q = query.trim();
  return useInfiniteQuery({
    queryKey: ["gifs", q ? "search" : "trending", q.toLowerCase()],
    queryFn: ({ pageParam }) =>
      api.get<GifPageDTO>(
        q ? `/gifs/search?q=${encodeURIComponent(q)}&page=${pageParam}` : `/gifs/trending?page=${pageParam}`,
      ),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasNext && last.page < 50 ? last.page + 1 : undefined),
    enabled,
    // Results are cached server-side for everyone; a picker reopened a minute later needs no refetch.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
