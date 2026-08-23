import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VideoDTO } from "@lumina/shared";
import { api, resolveAssetUrl } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import { queryKeys } from "../lib/queryKeys";
import { reportError } from "../store/toastStore";

const PAGE_SIZE = 10;

export interface FeedPage {
  seed: number;
  nextOffset: number | null;
  videos: VideoDTO[];
}

/**
 * Media URLs carry the access token as a query param, because `<video src>` cannot send an
 * Authorization header (same constraint as attachments — see attachmentUrl in lib/apiClient.ts).
 * Read imperatively rather than via the hook: this is called per card during render and
 * subscribing would re-render the entire feed on every token refresh.
 */
export function videoMediaUrl(path: string | null): string | null {
  if (!path) return null;
  const base = resolveAssetUrl(path);
  const token = useAuthStore.getState().accessToken;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * The For You feed.
 *
 * Paginated by offset+seed rather than the id cursor used elsewhere: the order is a computed
 * ranking, not monotonic in id, so the server needs the same seed on every page to keep one scroll
 * session's ordering stable. Threading `seed` from the first page through `getNextPageParam` is
 * what prevents cards duplicating across pages.
 */
export function useFeed(tag?: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.feed(tag),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (tag) params.set("tag", tag);
      if (pageParam) {
        params.set("offset", String(pageParam.offset));
        params.set("seed", String(pageParam.seed));
      }
      return api.get<FeedPage>(`/feed?${params.toString()}`);
    },
    initialPageParam: undefined as { offset: number; seed: number } | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.nextOffset === null ? undefined : { offset: lastPage.nextOffset, seed: lastPage.seed },
    // A feed is stale the moment it's rendered, but refetching mid-scroll would reshuffle cards
    // under the user's finger. Only refetched on an explicit pull-to-refresh / remount.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export interface FollowingPage {
  videos: VideoDTO[];
  nextCursor: string | null;
}

export function useFollowingFeed() {
  return useInfiniteQuery({
    queryKey: queryKeys.feedFollowing(),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) params.set("before", pageParam);
      return api.get<FollowingPage>(`/feed/following?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** The uploader's own videos, including non-public ones — the only place to see that an upload is
 * awaiting review, was rejected, or failed. */
export function useMyVideos() {
  return useQuery({
    queryKey: queryKeys.myVideos(),
    queryFn: () => api.get<VideoDTO[]>("/videos/mine"),
    // Poll while anything is still moving through the pipeline, so "Processing" becomes "Awaiting
    // review" and "Awaiting review" becomes "Live" on its own. Without this the tile is frozen at
    // whatever it showed on the last full page load — the transcode and the review both happen
    // entirely out of view of a tab that's just sitting open. Stops itself the moment nothing left
    // is PROCESSING/PENDING_REVIEW, so a page full of already-decided videos costs nothing.
    refetchInterval: (query) => {
      const videos = query.state.data;
      const stillMoving = videos?.some(
        (v) => v.status === "PROCESSING" || v.status === "PENDING_REVIEW",
      );
      return stillMoving ? 3000 : false;
    },
  });
}

export function useUploadVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      caption,
      tags,
      remix,
      allowStitch,
      allowDuet,
      onProgress,
    }: {
      file: File;
      caption: string;
      tags?: string[];
      /** Set when this upload is a stitch or duet of an existing video. */
      remix?: { type: "STITCH" | "DUET"; sourceId: string; startMs?: number; endMs?: number };
      allowStitch?: boolean;
      allowDuet?: boolean;
      onProgress?: (fraction: number) => void;
    }) => {
      const form = new FormData();
      if (caption) form.append("caption", caption);
      // One comma-separated field, matching what modules/videos/routes.ts parses. The field must
      // be appended before the file: fastify-multipart streams parts in order and the handler
      // reads the tag field while consuming the file part.
      if (tags && tags.length > 0) form.append("tags", tags.join(","));
      // Same ordering rule as tags — every non-file field has to precede the file part or the
      // handler will have already streamed past it by the time it looks.
      if (remix?.type === "DUET") form.append("duetOf", remix.sourceId);
      if (remix?.type === "STITCH") {
        form.append("stitchOf", remix.sourceId);
        form.append("stitchStartMs", String(remix.startMs ?? 0));
        form.append("stitchEndMs", String(remix.endMs ?? 0));
      }
      if (allowStitch === false) form.append("allowStitch", "false");
      if (allowDuet === false) form.append("allowDuet", "false");
      form.append("file", file);

      // XMLHttpRequest rather than fetch: fetch cannot report upload progress at all, and a
      // 100MB upload with no progress indication reads as a frozen app.
      return new Promise<VideoDTO>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
        xhr.open("POST", `${base}/videos`);
        const token = useAuthStore.getState().accessToken;
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText) as VideoDTO);
          } else {
            let message = "Upload failed";
            try {
              message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
            } catch {
              /* non-JSON error body */
            }
            reject(new Error(message));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
        // Without these two an upload that stalls or is cancelled by the OS never settles the
        // promise: the progress bar sits there and the modal stays in a permanent "uploading"
        // state with no error and no way back.
        xhr.onabort = () => reject(new Error("Upload was cancelled."));
        xhr.ontimeout = () => reject(new Error("Upload timed out — check your connection and try again."));
        // Generous: 100MB over a slow mobile connection is legitimately slow. This exists to
        // eventually fail rather than to hurry anything.
        xhr.timeout = 15 * 60 * 1000;
        xhr.send(form);
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myVideos() });
    },
  });
}

/**
 * Like/unlike with an optimistic update. The server is the authority on the final count (another
 * viewer may have liked it in the same moment), so the response overwrites the optimistic guess
 * rather than the guess being trusted.
 */
export function useToggleLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ videoId, liked }: { videoId: string; liked: boolean }) =>
      liked
        ? api.delete<{ liked: boolean; likeCount: number }>(`/feed/${videoId}/like`)
        : api.post<{ liked: boolean; likeCount: number }>(`/feed/${videoId}/like`, {}),
    onMutate: async ({ videoId, liked }) => {
      patchFeedVideo(queryClient, videoId, (v) => ({
        ...v,
        likedByMe: !liked,
        likeCount: v.likeCount + (liked ? -1 : 1),
      }));
    },
    onSuccess: (result, { videoId }) => {
      patchFeedVideo(queryClient, videoId, (v) => ({
        ...v,
        likedByMe: result.liked,
        likeCount: result.likeCount,
      }));
    },
    onError: (_err, { videoId, liked }) => {
      // Roll back to the pre-click state; leaving a wrong heart filled in is worse than no-op.
      patchFeedVideo(queryClient, videoId, (v) => ({
        ...v,
        likedByMe: liked,
        likeCount: v.likeCount + (liked ? 1 : -1),
      }));
    },
  });
}

/** Views are best-effort telemetry — a failure is swallowed rather than surfaced, since nothing
 * about the user's experience depends on the count being exact. */
export function recordView(videoId: string): void {
  void api.post(`/feed/${videoId}/view`, {}).catch(() => undefined);
}

/** Patches one video wherever it appears across every paginated feed cache — "For You", Following,
 * and any per-tag feed — so a like registers on the card the user tapped regardless of which one is
 * on screen. A fixed two-key list here previously missed tag-filtered feeds (queryKeys.feed(tag)),
 * so liking a video while browsing a hashtag silently patched a cache the screen wasn't reading
 * from. Matching on the "feed" key prefix covers every current and future feed variant instead. */
function patchFeedVideo(
  queryClient: ReturnType<typeof useQueryClient>,
  videoId: string,
  update: (v: VideoDTO) => VideoDTO,
): void {
  queryClient.setQueriesData<{ pages: Array<{ videos: VideoDTO[] }>; pageParams: unknown[] }>(
    { queryKey: ["feed"] },
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          videos: page.videos.map((v) => (v.id === videoId ? update(v) : v)),
        })),
      };
    },
  );
}

/**
 * Turn stitching/duetting of one of your own videos on or off.
 *
 * Every cached copy of the video is patched rather than refetched: the same row appears in the
 * feed, in "My videos" and inside a remix sheet at once, and letting only one of them update is
 * how a toggle ends up looking like it didn't take.
 */
export function useUpdateRemixSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ videoId, ...body }: { videoId: string; allowStitch?: boolean; allowDuet?: boolean }) =>
      api.patch<VideoDTO>(`/videos/${videoId}/remix-settings`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myVideos() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.feed() });
    },
    onError: (e) => reportError(e, "Couldn't change who can remix this"),
  });
}
