import { useRef, useState } from "react";
import { Image as ImageIcon, Loader2, X, Newspaper } from "lucide-react";
import { useFeed, useCreatePost, uploadPostMedia, type Post } from "../queries/posts";
import { PostCard } from "../components/feed/PostCard";
import { UserAvatar } from "../components/common/UserAvatar";
import { useAuthStore } from "../store/authStore";
import { resolveAssetUrl } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

/**
 * The feed — writing, and reading what everyone else wrote.
 *
 * A single column, newest first. Deliberately NOT ranked: a chronological feed is one people can
 * reason about, and a ranking model is a thing you own forever once you ship it. The For You video
 * feed is where ranking belongs, and it already does that.
 */
export function PostsRoute() {
  const me = useAuthStore((s) => s.user);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useFeed();
  const [sharing, setSharing] = useState<Post | null>(null);

  const posts = data?.pages.flatMap((page) => page.posts) ?? [];

  return (
    <div className="lx-pane flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0 bg-base-900">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline bg-base-800 px-4 py-3">
        <Newspaper className="h-5 w-5 shrink-0 text-accent" />
        <h1 className="font-display text-lg text-signal">Feed</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl space-y-3 p-3">
          <PostComposer
            avatarUrl={me?.avatarUrl ?? null}
            name={me?.displayName ?? me?.username ?? "You"}
            sharing={sharing}
            onDoneSharing={() => setSharing(null)}
          />

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
            </div>
          ) : posts.length === 0 ? (
            <div className="py-16 text-center">
              <Newspaper className="mx-auto mb-3 h-10 w-10 text-signal-faint" aria-hidden="true" />
              <p className="text-sm text-signal">Nothing here yet</p>
              <p className="mt-1 text-xs text-signal-faint">
                Write the first one — a thought, a photo, a video, anything.
              </p>
            </div>
          ) : (
            posts.map((post) => <PostCard key={post.id} post={post} onShare={setSharing} />)
          )}

          {hasNextPage ? (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full rounded-xl border border-hairline bg-base-800 py-2.5 text-sm text-signal-dim transition hover:text-signal disabled:opacity-50"
            >
              {isFetchingNextPage ? "Loading…" : "Show older posts"}
            </button>
          ) : posts.length > 0 ? (
            <p className="py-4 text-center text-xs text-signal-faint">That's everything.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Writing a post.
 *
 * Media uploads as soon as it is picked rather than on submit: it means the progress happens while
 * someone is still typing, and a failed upload does not take the words with it. The ids come back
 * immediately and the post is created from those.
 */
function PostComposer({
  avatarUrl,
  name,
  sharing,
  onDoneSharing,
}: {
  avatarUrl: string | null;
  name: string;
  sharing: Post | null;
  onDoneSharing: () => void;
}) {
  const create = useCreatePost();
  const fileRef = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<Array<{ id: string; kind: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);

  const canPost = Boolean(body.trim() || media.length > 0 || sharing);

  const pick = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadPostMedia(files);
      setMedia((m) => [...m, ...uploaded].slice(0, 10));
    } catch (error) {
      reportError(error, "That upload didn't go through");
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!canPost) return;
    create.mutate(
      {
        body: body.trim(),
        mediaIds: media.map((m) => m.id),
        ...(sharing ? { sharedPostId: sharing.id } : {}),
      },
      {
        onSuccess: () => {
          setBody("");
          setMedia([]);
          onDoneSharing();
        },
      },
    );
  };

  return (
    <div className="rounded-xl border border-hairline bg-base-800 p-3">
      <div className="flex gap-2.5">
        <UserAvatar avatarUrl={avatarUrl} name={name} size={38} />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 20000))}
          rows={sharing || media.length ? 3 : 2}
          placeholder={sharing ? "Add something to this…" : "What's on your mind?"}
          className="max-h-60 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
        />
      </div>

      {sharing ? (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-hairline bg-base-900 p-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-signal-faint">
              Sharing {sharing.author?.displayName ?? sharing.author?.username ?? "a post"}
            </p>
            <p className="line-clamp-2 text-sm text-signal-dim">{sharing.body || "(no text)"}</p>
          </div>
          <button
            type="button"
            onClick={onDoneSharing}
            aria-label="Don't share this"
            className="shrink-0 text-signal-faint hover:text-signal"
          >
            <X size={15} />
          </button>
        </div>
      ) : null}

      {media.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {media.map((item) => (
            <div key={item.id} className="relative">
              {item.kind === "VIDEO" ? (
                <video src={resolveAssetUrl(item.url)} className="h-16 w-16 rounded bg-black object-cover" />
              ) : (
                <img src={resolveAssetUrl(item.url)} alt="" className="h-16 w-16 rounded object-cover" />
              )}
              <button
                type="button"
                onClick={() => setMedia((m) => m.filter((x) => x.id !== item.id))}
                aria-label="Remove this"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-base-900 text-signal-dim hover:text-flare"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2 border-t border-hairline pt-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            void pick(Array.from(e.target.files ?? []));
            // Reset so picking the same file again still fires a change event.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || media.length >= 10}
          className="lx-focus flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-signal-dim transition hover:bg-base-700 hover:text-signal disabled:opacity-50"
        >
          {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />}
          Photo or video
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canPost || create.isPending || uploading}
          className="ml-auto rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
        >
          {create.isPending ? "Posting…" : sharing ? "Share" : "Post"}
        </button>
      </div>
    </div>
  );
}
