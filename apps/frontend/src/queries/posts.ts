import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";
import type { UserDTO } from "@lumina/shared";

export interface PostMedia {
  id: string;
  kind: "PHOTO" | "VIDEO" | string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface Post {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  author: UserDTO | null;
  media: PostMedia[];
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByMe: boolean;
  /** The post this one shares, or null when it is not a share. */
  shared: Post | null;
  /** True when this IS a share whose original has since been deleted. */
  sharedUnavailable: boolean;
  mine: boolean;
}

export interface PostComment {
  id: string;
  body: string;
  createdAt: string;
  author: UserDTO | null;
  likeCount: number;
  likedByMe: boolean;
  mine: boolean;
  replies: PostComment[];
}

interface FeedPage {
  posts: Post[];
  nextCursor: string | null;
}

export function useFeed(authorId?: string) {
  return useInfiniteQuery({
    queryKey: ["feed", authorId ?? "all"],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: "20" });
      if (pageParam) search.set("cursor", String(pageParam));
      if (authorId) search.set("author", authorId);
      return api.get<FeedPage>(`/posts?${search.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Every mutation invalidates the whole feed rather than patching one post in place.
 *
 * A like changes one number and could be patched, but a share creates a new post at the top, a
 * delete removes one from the middle, and a comment changes a count on a card that may appear in
 * several pages at once. One rule that is always right beats four that are usually right.
 */
function useFeedAction<T>(fn: (args: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["feed"] }),
    onError: (e) => reportError(e, "That didn't go through"),
  });
}

export function useCreatePost() {
  return useFeedAction(
    ({ body, mediaIds, sharedPostId }: { body: string; mediaIds?: string[]; sharedPostId?: string }) =>
      api.post<Post>("/posts", {
        body,
        mediaIds: mediaIds ?? [],
        ...(sharedPostId ? { sharedPostId } : {}),
      }),
  );
}

export function useDeletePost() {
  return useFeedAction(({ id }: { id: string }) => api.delete(`/posts/${id}`));
}

/**
 * Liking is optimistic.
 *
 * It is the one action people do constantly and expect to be instant; a round trip before the
 * heart fills makes the whole feed feel slow. The rollback restores the exact previous pages, so a
 * failed like cannot leave a count that drifted.
 */
export function useLikePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.post<{ liked: boolean; likeCount: number }>(`/posts/${id}/like`),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["feed"] });
      const previous = queryClient.getQueriesData({ queryKey: ["feed"] });
      queryClient.setQueriesData({ queryKey: ["feed"] }, (old: unknown) => {
        const data = old as { pages?: FeedPage[] } | undefined;
        if (!data?.pages) return old;
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            posts: page.posts.map((post) =>
              post.id === id
                ? {
                    ...post,
                    likedByMe: !post.likedByMe,
                    likeCount: Math.max(0, post.likeCount + (post.likedByMe ? -1 : 1)),
                  }
                : post,
            ),
          })),
        };
      });
      return { previous };
    },
    onError: (error, _vars, context) => {
      for (const [key, value] of context?.previous ?? []) queryClient.setQueryData(key, value);
      reportError(error, "Couldn't save that");
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["feed"] }),
  });
}

export function usePostComments(postId: string | null) {
  return useQuery({
    queryKey: ["postComments", postId],
    queryFn: () => api.get<{ comments: PostComment[] }>(`/posts/${postId!}/comments`),
    enabled: Boolean(postId),
  });
}

function useCommentAction<T>(fn: (args: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["postComments"] });
      // The comment count lives on the post, so the feed is stale too.
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
    onError: (e) => reportError(e, "That didn't go through"),
  });
}

export function useAddComment(postId: string) {
  return useCommentAction(({ body, parentId }: { body: string; parentId?: string }) =>
    api.post(`/posts/${postId}/comments`, { body, ...(parentId ? { parentId } : {}) }),
  );
}

export function useDeleteComment() {
  return useCommentAction(({ id }: { id: string }) => api.delete(`/posts/comments/${id}`));
}

export function useLikeComment() {
  return useCommentAction(({ id }: { id: string }) => api.post(`/posts/comments/${id}/like`));
}

/** Upload photos/videos and get ids back. The post is created from those ids afterwards. */
export async function uploadPostMedia(files: File[]): Promise<Array<{ id: string; kind: string; url: string }>> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const result = await api.postForm<{ media: Array<{ id: string; kind: string; url: string }> }>(
    "/posts/media",
    form,
  );
  return result.media;
}
