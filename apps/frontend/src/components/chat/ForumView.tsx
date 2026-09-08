import { useState } from "react";
import type { ChannelDTO } from "@lumina/shared";
import { MessagesSquare, Plus, Users } from "lucide-react";
import { Modal } from "../modals/Modal";
import { useThreads, useCreateThread } from "../../queries/threads";
import { reportError } from "../../store/toastStore";
import { cn } from "../../lib/cn";

/** Compact "3m ago" / "2d ago", falling back to a date past a week. */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * A forum channel's main pane: a board of posts. Each post is a THREAD under the forum channel, so
 * reading and replying reuse ThreadPanel and every piece of message machinery — this view only adds
 * the post list and the "new post" composer. The selected post opens in the docked ThreadPanel
 * (rendered by ChannelRoute), so clicking a post just hands its id up via onOpenPost.
 */
export function ForumView({
  serverId,
  channel,
  canPost,
  activePostId,
  onOpenPost,
}: {
  serverId: string;
  channel: ChannelDTO;
  canPost: boolean;
  activePostId?: string | null;
  onOpenPost: (threadId: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { data: posts, isLoading } = useThreads(channel.id, showArchived);
  const createPost = useCreateThread(channel.id);

  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  async function submitPost() {
    if (!title.trim() || !body.trim() || createPost.isPending) return;
    try {
      const thread = await createPost.mutateAsync({ name: title.trim(), content: body.trim() });
      setComposing(false);
      setTitle("");
      setBody("");
      onOpenPost(thread.id);
    } catch (e) {
      reportError(e, "Couldn't create that post");
    }
  }

  return (
    <div className="lx-pane relative flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-base-700 px-4">
        <MessagesSquare size={16} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-signal">{channel.name}</span>
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="shrink-0 rounded px-2 py-1 text-xs text-signal-dim hover:bg-base-700 hover:text-signal"
        >
          {showArchived ? "Active posts" : "Archived"}
        </button>
        {canPost && (
          <button
            onClick={() => setComposing(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
          >
            <Plus size={14} /> New post
          </button>
        )}
      </header>

      {channel.topic && (
        <p className="shrink-0 border-b border-base-700 px-4 py-2 text-xs text-signal-faint">{channel.topic}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-signal-faint">Loading posts…</div>
        ) : (posts?.length ?? 0) === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-signal-faint">
            <MessagesSquare size={28} className="opacity-40" />
            {showArchived ? "No archived posts." : "No posts yet. Start the first one."}
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-1.5">
            {posts!.map((p) => {
              const replies = Math.max(0, p.messageCount - 1);
              return (
                <button
                  key={p.id}
                  onClick={() => onOpenPost(p.id)}
                  data-active={p.id === activePostId}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition",
                    p.id === activePostId
                      ? "border-accent bg-accent/10"
                      : "border-hairline bg-base-900/40 hover:border-signal-faint",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-signal">{p.name}</span>
                      {p.archived && (
                        <span className="shrink-0 rounded bg-base-700 px-1.5 py-px font-mono text-[9px] uppercase text-signal-faint">
                          archived
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-signal-faint">
                      <span className="flex items-center gap-1">
                        <MessagesSquare size={11} /> {replies === 1 ? "1 reply" : `${replies} replies`}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={11} /> {p.memberCount}
                      </span>
                      <span>{timeAgo(p.lastActivityAt ?? p.createdAt)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={composing} onOpenChange={(o) => !o && setComposing(false)} title={`New post in ${channel.name}`}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Title</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              className="rounded bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              placeholder="What's this post about?"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Body</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              maxLength={4000}
              className="resize-none rounded bg-base-900 px-3 py-2.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              placeholder="Write the first message…"
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={() => setComposing(false)}
            className="rounded px-4 py-2 text-sm font-medium text-signal-dim hover:underline"
          >
            Cancel
          </button>
          <button
            onClick={() => void submitPost()}
            disabled={!title.trim() || !body.trim() || createPost.isPending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Post
          </button>
        </div>
      </Modal>
    </div>
  );
}
