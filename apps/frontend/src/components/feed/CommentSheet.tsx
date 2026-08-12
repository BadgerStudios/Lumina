import { useState } from "react";
import { X, Send, Loader2, Trash2 } from "lucide-react";
import type { VideoDTO } from "@lumina/shared";
import { useVideoComments, useCreateComment, useDeleteComment } from "../../queries/videoSocial";
import { useAuthStore } from "../../store/authStore";
import { UserAvatar } from "../common/UserAvatar";
import { FeedText } from "./FeedText";

export function CommentSheet({
  video,
  onClose,
  onSelectTag,
}: {
  video: VideoDTO | null;
  onClose: () => void;
  /** Tapping a hashtag in a comment filters the feed by it, same as tapping one on the card —
   * closing the sheet first, since the thing it filters is behind the sheet. */
  onSelectTag?: (tag: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const me = useAuthStore((s) => s.user);
  const { data: comments, isLoading } = useVideoComments(video?.id ?? null);
  const createComment = useCreateComment(video?.id ?? null);
  const deleteComment = useDeleteComment(video?.id ?? null);

  if (!video) return null;

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    createComment.mutate(content, { onSuccess: () => setDraft("") });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="flex h-[calc(var(--app-height-safe)*0.70)] w-full max-w-md flex-col rounded-t-xl border border-hairline bg-base-800 sm:h-[calc(var(--app-height-safe)*0.80)] sm:rounded-xl">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="font-display text-signal">
            Comments{video.commentCount > 0 ? ` (${video.commentCount})` : ""}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close comments" className="text-signal-faint hover:text-signal">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
            </div>
          ) : !comments || comments.length === 0 ? (
            <p className="py-8 text-center text-sm text-signal-dim">No comments yet.</p>
          ) : (
            <div className="space-y-3">
              {comments.map((c) => {
                // The uploader can moderate replies on their own video, so the delete affordance
                // shows for them too — not just the comment's own author.
                const canDelete = me?.id === c.author?.id || me?.id === video.author?.id;
                return (
                  <div key={c.id} className="group flex gap-2">
                    <UserAvatar
                      avatarUrl={c.author?.avatarUrl ?? null}
                      name={c.author?.displayName ?? c.author?.username ?? "?"}
                      size={28}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-signal-dim">
                        {c.author?.displayName ?? c.author?.username ?? "[deleted user]"}
                      </p>
                      <p className="break-words text-sm text-signal">
                        <FeedText
                          text={c.content}
                          onSelectTag={
                            onSelectTag
                              ? (tag) => {
                                  onClose();
                                  onSelectTag(tag);
                                }
                              : undefined
                          }
                        />
                      </p>
                    </div>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => deleteComment.mutate(c.id)}
                        aria-label="Delete comment"
                        className="opacity-0 transition group-hover:opacity-100"
                      >
                        <Trash2 className="h-4 w-4 text-signal-faint hover:text-flare" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-hairline p-3">
          <input
            aria-label="Add a comment"
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 500))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add a comment…"
            className="flex-1 rounded-full border border-hairline bg-base-700 px-4 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || createComment.isPending}
            aria-label="Send comment"
            className="rounded-full bg-accent p-2 text-white disabled:opacity-50"
          >
            {createComment.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
