import { useState } from "react";
import { Heart, MessageCircle, Repeat2, Trash2, Send, CornerDownRight } from "lucide-react";
import {
  useLikePost,
  useDeletePost,
  usePostComments,
  useAddComment,
  useDeleteComment,
  useLikeComment,
  type Post,
  type PostComment,
} from "../../queries/posts";
import { UserAvatar } from "../common/UserAvatar";
import { OfficialBadge } from "../common/OfficialBadge";
import { StaffBadge } from "../common/StaffBadge";
import { resolveAssetUrl } from "../../lib/apiClient";
import { relativeTime } from "../../lib/relativeTime";
import { cn } from "../../lib/cn";

/**
 * One post, with everything you can do to it.
 *
 * Comments load only when opened. A feed page is twenty posts and most of them are scrolled past
 * without a second thought, so fetching every thread up front would be twenty requests to render
 * one screen almost none of which anyone reads.
 */
export function PostCard({ post, onShare }: { post: Post; onShare: (post: Post) => void }) {
  const [showComments, setShowComments] = useState(false);
  const like = useLikePost();
  const remove = useDeletePost();

  return (
    <article className="rounded-xl border border-hairline bg-base-800">
      <PostHeader post={post} onDelete={() => remove.mutate({ id: post.id })} />

      {post.body ? (
        <p className="whitespace-pre-wrap break-words px-3 pb-2 text-sm leading-relaxed text-signal">
          {post.body}
        </p>
      ) : null}

      <PostMediaGrid post={post} />

      {/* A share renders the original inside a frame of its own, so it is always obvious which
          words belong to whom. */}
      {post.shared ? (
        <div className="mx-3 mb-2 rounded-lg border border-hairline bg-base-900">
          <PostHeader post={post.shared} compact />
          {post.shared.body ? (
            <p className="whitespace-pre-wrap break-words px-3 pb-2 text-sm text-signal-dim">
              {post.shared.body}
            </p>
          ) : null}
          <PostMediaGrid post={post.shared} />
        </div>
      ) : post.sharedUnavailable ? (
        <p className="mx-3 mb-2 rounded-lg border border-hairline bg-base-900 p-3 text-xs text-signal-faint">
          The post this shared is no longer available.
        </p>
      ) : null}

      <div className="flex items-center gap-1 border-t border-hairline px-1.5 py-1">
        <Action
          icon={Heart}
          label="Like"
          count={post.likeCount}
          active={post.likedByMe}
          activeClass="text-flare"
          fill={post.likedByMe}
          onClick={() => like.mutate({ id: post.id })}
        />
        <Action
          icon={MessageCircle}
          label="Comment"
          count={post.commentCount}
          active={showComments}
          onClick={() => setShowComments((s) => !s)}
        />
        <Action
          icon={Repeat2}
          label="Share"
          count={post.shareCount}
          onClick={() => onShare(post.shared ?? post)}
        />
      </div>

      {showComments ? <CommentThread postId={post.id} /> : null}
    </article>
  );
}

function PostHeader({
  post,
  compact = false,
  onDelete,
}: {
  post: Post;
  compact?: boolean;
  onDelete?: () => void;
}) {
  const name = post.author?.displayName ?? post.author?.username ?? "Deleted account";
  return (
    <header className="flex items-center gap-2.5 p-3">
      <UserAvatar avatarUrl={post.author?.avatarUrl ?? null} name={name} size={compact ? 28 : 38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-signal">{name}</span>
          {post.author?.isOfficial ? <OfficialBadge compact /> : null}
          {!post.author?.isOfficial && post.author?.isStaff ? <StaffBadge compact /> : null}
        </div>
        <p className="text-xs text-signal-faint">
          {relativeTime(post.createdAt)}
          {post.editedAt ? " · edited" : ""}
        </p>
      </div>
      {onDelete && post.mine ? (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete this post"
          className="shrink-0 text-signal-faint transition hover:text-flare"
        >
          <Trash2 size={16} />
        </button>
      ) : null}
    </header>
  );
}

/**
 * The pictures.
 *
 * One image runs full width at its own shape; several go into a square grid, because a row of
 * mismatched aspect ratios is the thing that makes a feed look broken. Videos carry controls and
 * are never autoplayed — a feed that starts playing sound on scroll is a feed people mute once and
 * never unmute.
 */
function PostMediaGrid({ post }: { post: Post }) {
  if (post.media.length === 0) return null;
  const single = post.media.length === 1;

  return (
    <div
      className={cn(
        "gap-0.5 overflow-hidden",
        single ? "px-3 pb-2" : "grid grid-cols-2 px-3 pb-2",
      )}
    >
      {post.media.map((item) =>
        item.kind === "VIDEO" ? (
          <video
            key={item.id}
            src={resolveAssetUrl(item.url)}
            controls
            preload="metadata"
            playsInline
            className={cn("w-full rounded-lg bg-black", single ? "max-h-[70vh]" : "aspect-square object-cover")}
          />
        ) : (
          <img
            key={item.id}
            src={resolveAssetUrl(item.url)}
            alt=""
            loading="lazy"
            className={cn(
              "w-full rounded-lg bg-base-900",
              single ? "max-h-[70vh] object-contain" : "aspect-square object-cover",
            )}
          />
        ),
      )}
    </div>
  );
}

function Action({
  icon: Icon,
  label,
  count,
  active = false,
  activeClass = "text-accent",
  fill = false,
  onClick,
}: {
  icon: typeof Heart;
  label: string;
  count?: number;
  active?: boolean;
  activeClass?: string;
  fill?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "lx-focus flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition",
        active ? activeClass : "text-signal-dim hover:bg-base-700 hover:text-signal",
      )}
    >
      <Icon size={17} fill={fill ? "currentColor" : "none"} />
      {count ? <span className="font-mono">{count}</span> : null}
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  );
}

function CommentThread({ postId }: { postId: string }) {
  const { data, isLoading } = usePostComments(postId);
  const add = useAddComment(postId);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);

  const send = () => {
    const text = body.trim();
    if (!text) return;
    add.mutate(
      { body: text, parentId: replyTo?.id },
      { onSuccess: () => { setBody(""); setReplyTo(null); } },
    );
  };

  return (
    <div className="border-t border-hairline p-3">
      {isLoading ? (
        <p className="text-xs text-signal-faint">Loading…</p>
      ) : !data || data.comments.length === 0 ? (
        <p className="mb-2 text-xs text-signal-faint">No comments yet.</p>
      ) : (
        <div className="mb-2 space-y-2">
          {data.comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} onReply={setReplyTo} />
          ))}
        </div>
      )}

      {replyTo ? (
        <p className="mb-1 flex items-center gap-1 text-xs text-signal-faint">
          <CornerDownRight size={12} />
          Replying to {replyTo.author?.displayName ?? replyTo.author?.username ?? "someone"}
          <button type="button" onClick={() => setReplyTo(null)} className="ml-1 underline">
            cancel
          </button>
        </p>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 4000))}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — the same rule as the message composer, so
            // the two do not need to be learned separately.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={replyTo ? "Write a reply…" : "Write a comment…"}
          className="max-h-24 min-w-0 flex-1 resize-none rounded-lg border border-hairline bg-base-700 px-2.5 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint focus:border-accent"
        />
        <button
          type="button"
          onClick={send}
          disabled={!body.trim() || add.isPending}
          aria-label="Post comment"
          className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-hover disabled:bg-transparent disabled:text-signal-faint"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  onReply,
  nested = false,
}: {
  comment: PostComment;
  onReply: (comment: PostComment) => void;
  nested?: boolean;
}) {
  const like = useLikeComment();
  const remove = useDeleteComment();
  const name = comment.author?.displayName ?? comment.author?.username ?? "Deleted account";

  return (
    <div className={cn("flex gap-2", nested && "ml-6")}>
      <UserAvatar avatarUrl={comment.author?.avatarUrl ?? null} name={name} size={24} />
      <div className="min-w-0 flex-1">
        <div className="rounded-lg bg-base-900 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-signal">{name}</span>
            {comment.author?.isOfficial ? <OfficialBadge compact /> : null}
            {!comment.author?.isOfficial && comment.author?.isStaff ? <StaffBadge compact /> : null}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-signal-dim">{comment.body}</p>
        </div>
        <div className="mt-0.5 flex items-center gap-3 px-1 text-[0.7rem] text-signal-faint">
          <span>{relativeTime(comment.createdAt)}</span>
          <button
            type="button"
            onClick={() => like.mutate({ id: comment.id })}
            className={cn("flex items-center gap-1 transition hover:text-signal", comment.likedByMe && "text-flare")}
            aria-pressed={comment.likedByMe}
          >
            <Heart size={11} fill={comment.likedByMe ? "currentColor" : "none"} />
            {comment.likeCount > 0 ? comment.likeCount : "Like"}
          </button>
          {/* Replies attach to the top-level comment, so a thread stays two levels deep instead of
              walking off the right edge of a phone. */}
          <button type="button" onClick={() => onReply(comment)} className="transition hover:text-signal">
            Reply
          </button>
          {comment.mine ? (
            <button
              type="button"
              onClick={() => remove.mutate({ id: comment.id })}
              className="transition hover:text-flare"
            >
              Delete
            </button>
          ) : null}
        </div>

        {comment.replies.length > 0 ? (
          <div className="mt-2 space-y-2">
            {comment.replies.map((reply) => (
              <CommentRow key={reply.id} comment={reply} onReply={onReply} nested />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
