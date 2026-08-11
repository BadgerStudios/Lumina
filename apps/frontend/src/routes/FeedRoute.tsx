import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Loader2, Clapperboard, X } from "lucide-react";
import type { VideoDTO } from "@lumina/shared";
import { useFeed, useFollowingFeed } from "../queries/videos";
import { VideoCard } from "../components/feed/VideoCard";
import { FeedUploadModal } from "../components/feed/FeedUploadModal";
import { MyVideosPanel } from "../components/feed/MyVideosPanel";
import { MyReportsPanel } from "../components/feed/MyReportsPanel";
import { CommentSheet } from "../components/feed/CommentSheet";
import { ReportModal } from "../components/feed/ReportModal";
import { RemixChooser } from "../components/feed/RemixChooser";
import { RemixModal } from "../components/feed/RemixModal";
import { cn } from "../lib/cn";
import { useAuthStore } from "../store/authStore";

type Tab = "foryou" | "following" | "mine" | "reports";

export function FeedRoute() {
  const [tab, setTab] = useState<Tab>("foryou");
  const [tag, setTag] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const user = useAuthStore((s) => s.user);

  // Only the For You feed filters by tag server-side, so tapping a tag moves there rather than
  // silently doing nothing on the Following tab.
  const selectTag = (next: string) => {
    setTag(next);
    setTab("foryou");
  };

  // Presentation only — every feed route enforces requireAdult server-side. An account with no age
  // on record counts as not-adult, which is what keeps the legacy accounts out until they answer.
  if (!user || user.ageVerified !== true || user.isMinor !== false) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-sm text-signal-dim">
          The video feed is for members aged 18 and over. If you've just been asked for your age,
          answer that first and it'll appear here.
        </p>
      </div>
    );
  }

  return (
    // base-900 rather than black behind the column: on a wide screen the portrait card left the
    // entire rest of the pane as dead black, which reads as a rendering failure rather than as
    // letterboxing. The card itself stays black.
    <div className="flex h-full min-w-0 flex-1 flex-col bg-base-900">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline/40 bg-base-800 px-2 py-2">
        {/* Four tabs plus Upload overflow a phone. The tabs scroll; Upload is pinned outside the
            scroller so the primary action can never be scrolled out of reach. */}
        <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:justify-center">
          <TabButton active={tab === "foryou"} onClick={() => setTab("foryou")}>
            For You
          </TabButton>
          <TabButton active={tab === "following"} onClick={() => setTab("following")}>
            Following
          </TabButton>
          <TabButton active={tab === "mine"} onClick={() => setTab("mine")}>
            My videos
          </TabButton>
          <TabButton active={tab === "reports"} onClick={() => setTab("reports")}>
            My reports
          </TabButton>
        </div>
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          // The label collapses to just the icon on narrow screens, which would otherwise leave
          // the button with no accessible name at all — invisible to a screen reader and to any
          // test that looks it up by name.
          aria-label="Upload a video"
          className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Upload</span>
        </button>
      </div>

      {tag && tab === "foryou" && (
        <div className="flex items-center gap-2 border-b border-hairline/40 bg-base-800 px-3 py-1.5">
          <span className="text-sm text-signal">#{tag}</span>
          <button
            type="button"
            onClick={() => setTag(null)}
            className="flex items-center gap-1 rounded-full bg-base-600 px-2 py-0.5 text-xs text-signal-dim hover:text-signal"
          >
            <X className="h-3 w-3" />
            Clear filter
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "mine" ? (
          <MyVideosPanel />
        ) : tab === "reports" ? (
          <MyReportsPanel />
        ) : (
          // Keyed on the filter too — a new tag is a different list, and reusing the mounted
          // instance would leave the IntersectionObserver bound to the previous cards.
          <ScrollFeed
            key={`${tab}:${tag ?? ""}`}
            tab={tab}
            tag={tab === "foryou" ? tag : null}
            onSelectTag={selectTag}
          />
        )}
      </div>

      <FeedUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition",
        active ? "bg-base-600 text-signal" : "text-signal-dim hover:text-signal",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The vertical snap-scrolling feed.
 *
 * Which card is "active" (and therefore playing) is decided by an IntersectionObserver against the
 * scroll container rather than by scroll-offset math: offset math has to be re-derived on every
 * resize and gets the answer wrong during momentum scrolling, whereas the observer reports exactly
 * what the user is actually looking at. A high threshold means the switch happens when a card
 * genuinely dominates the viewport, not the moment it peeks in.
 */
function ScrollFeed({
  tab,
  tag,
  onSelectTag,
}: {
  tab: "foryou" | "following";
  tag: string | null;
  onSelectTag: (tag: string) => void;
}) {
  const [commentsFor, setCommentsFor] = useState<VideoDTO | null>(null);
  const [reportFor, setReportFor] = useState<VideoDTO | null>(null);
  // Two steps, two pieces of state: pick which kind of remix, then record it. Kept separate so
  // backing out of the recorder returns to the chooser rather than all the way to the feed.
  const [remixChoiceFor, setRemixChoiceFor] = useState<VideoDTO | null>(null);
  const [remixFor, setRemixFor] = useState<{ video: VideoDTO; mode: "STITCH" | "DUET" } | null>(null);
  const forYou = useFeed(tag);
  const following = useFollowingFeed();
  const query = tab === "foryou" ? forYou : following;

  const videos: VideoDTO[] = useMemo(
    () => query.data?.pages.flatMap((p) => p.videos) ?? [],
    [query.data],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  const observerCallback = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = (entry.target as HTMLElement).dataset.videoId;
          if (id) setActiveId(id);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(observerCallback, { root, threshold: 0.6 });
    for (const child of Array.from(root.children)) {
      if ((child as HTMLElement).dataset.videoId) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [observerCallback, videos.length]);

  // Prefetch the next page a couple of cards ahead of the end, so scrolling never stops at a
  // spinner when there is more to show.
  useEffect(() => {
    if (!activeId || !hasNextPage || isFetchingNextPage) return;
    const index = videos.findIndex((v) => v.id === activeId);
    if (index >= 0 && index >= videos.length - 3) void fetchNextPage();
  }, [activeId, videos, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Clapperboard className="h-10 w-10 text-signal-faint" />
        <p className="text-signal-dim">
          {tag
            ? `No approved videos are tagged #${tag} yet.`
            : tab === "following"
              ? "None of your friends have posted a video yet."
              : "No videos here yet. Upload one — it'll appear once a moderator approves it."}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full snap-y snap-mandatory overflow-y-scroll overscroll-contain"
    >
      {videos.map((video) => (
        <div key={video.id} data-video-id={video.id} className="h-full w-full snap-start">
          <VideoCard
            video={video}
            // Opening a sheet over the feed pauses playback: audio continuing behind a modal the
            // user is reading is disorienting, and it keeps only one video ever playing.
            active={activeId === video.id && !commentsFor && !reportFor && !remixChoiceFor && !remixFor}
            onOpenComments={setCommentsFor}
            onReport={setReportFor}
            onSelectTag={onSelectTag}
            onRemix={setRemixChoiceFor}
          />
        </div>
      ))}
      {isFetchingNextPage && (
        <div className="flex h-20 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
        </div>
      )}
      <CommentSheet video={commentsFor} onClose={() => setCommentsFor(null)} onSelectTag={onSelectTag} />
      <ReportModal video={reportFor} onClose={() => setReportFor(null)} />
      {!remixFor && (
        <RemixChooser
          video={remixChoiceFor}
          onClose={() => setRemixChoiceFor(null)}
          onPick={(mode) => {
            if (remixChoiceFor) setRemixFor({ video: remixChoiceFor, mode });
          }}
        />
      )}
      {remixFor && (
        <RemixModal
          source={remixFor.video}
          mode={remixFor.mode}
          onClose={() => {
            setRemixFor(null);
            setRemixChoiceFor(null);
          }}
        />
      )}
    </div>
  );
}
