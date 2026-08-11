import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

export interface TagSuggestion {
  id: string;
  name: string;
  displayName: string | null;
  useCount: number;
}

export const MAX_TAGS_PER_VIDEO = 8;

/**
 * Mirrors normaliseTag in apps/backend/src/modules/tags/service.ts.
 *
 * Duplicated deliberately rather than shared: the client needs it synchronously on every keystroke
 * to show the user the tag they will actually get, and the server must never trust a client-side
 * normalisation anyway — both run it, and the server's result is authoritative. Any change here
 * must be made there too.
 */
export function normaliseTag(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (cleaned.length < 2 || cleaned.length > 30) return null;
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned;
}

/** Typeahead over existing tags. An empty query returns the most-used tags, flagged `suggested`. */
export function useTagSuggestions(query: string, enabled = true) {
  return useQuery({
    queryKey: ["tagSuggestions", query],
    queryFn: () =>
      api.get<{ tags: TagSuggestion[]; suggested: boolean }>(
        `/lookup/tags?q=${encodeURIComponent(query)}&limit=8`,
      ),
    enabled,
    staleTime: 30_000,
  });
}
