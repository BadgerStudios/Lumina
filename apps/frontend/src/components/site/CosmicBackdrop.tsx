import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./useLanding";

/**
 * The page's background: a seamless ~5-minute loop of REAL nebulae — Orion, Westerlund 2, the
 * Lagoon, the Tarantula, the Helix and the Cygnus Loop — shot by Hubble and Spitzer, graded to
 * the brand's violet. All source imagery is public domain (NASA / ESA / STScI / JPL-Caltech);
 * see apps/frontend/scripts/build-nebula-loop.sh for the exact frames and the build.
 *
 * Fixed behind the entire page, so scrolling travels through it. Engineered to never cost a
 * visitor anything they did not ask for:
 *  - The POSTER (a real graded frame) paints immediately and is what everyone sees first, so the
 *    page is never blank or black while several MB of video streams in.
 *  - Resolution is chosen at mount: phones and small windows get the 720p cut, roughly half the
 *    bytes of the 1080p one.
 *  - prefers-reduced-motion, Save-Data, and 2G/3G connections never load the video at all — they
 *    keep the still poster, which is a perfectly good background.
 *  - Playback pauses when the tab is hidden.
 */

// The `-vN` suffix is the cache-busting handle. These files are served with a 30-day max-age and
// sit behind Cloudflare, which means replacing the BYTES at an existing path does not reach anyone
// — the edge keeps serving the old copy until the TTL lapses (observed: a re-encoded loop still
// returning the previous file with cf-cache-status HIT). There is no Cloudflare API token on this
// deployment to purge with, so regenerating the loop means bumping this suffix and renaming the
// files to match. See apps/frontend/scripts/build-nebula-loop.sh.
const SOURCES = {
  hd: { webm: "/screens/nebula/nebula-1080-v3.webm", mp4: "/screens/nebula/nebula-1080-v3.mp4" },
  sd: { webm: "/screens/nebula/nebula-720-v3.webm", mp4: "/screens/nebula/nebula-720-v3.mp4" },
};
const POSTER = "/screens/nebula/nebula-poster-v3.jpg";

/** Would loading several MB of decorative video be rude here? */
function shouldSkipVideo(): boolean {
  if (prefersReducedMotion()) return true;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return true;
  if (conn?.effectiveType && /(^|-)(2g|3g)$/.test(conn.effectiveType)) return true;
  return false;
}

export default function CosmicBackdrop() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Once the video is up and its fade has finished, the poster underneath is a second
  // full-viewport 1920x1080 layer showing something nobody can see. `playing` retires it (the
  // rest of that story is on .nebula-poster in landing.css); anything that interrupts playback
  // brings it straight back, so a stalled or failed video never leaves a bare background.
  const [playing, setPlaying] = useState(false);
  // Decided once, on the client, after mount — never during render, so there is no hydration
  // mismatch and no layout thrash from reading connection info too early.
  const [variant, setVariant] = useState<"hd" | "sd" | null>(null);

  useEffect(() => {
    if (shouldSkipVideo()) return;
    // CSS width alone decides this. An earlier version also forced the SD cut when
    // devicePixelRatio < 1.2 — but an ordinary 1080p desktop monitor IS dpr 1, so every standard
    // desktop was being served the 720p cut stretched across a 1440px-wide viewport. Physical
    // density is the wrong question for a full-viewport background; how many CSS pixels it has to
    // cover is the right one.
    setVariant(window.innerWidth < 900 ? "sd" : "hd");
  }, []);

  // Pause while the tab is hidden: a 5-minute loop decoding behind a backgrounded tab is pure
  // battery cost for something nobody is looking at.
  useEffect(() => {
    const onVisibility = () => {
      const v = videoRef.current;
      if (!v) return;
      if (document.visibilityState === "hidden") v.pause();
      else void v.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [variant]);

  // A slow parallax drift as the page scrolls, so the background reads as depth rather than as
  // wallpaper. Written to a custom property and applied in CSS, and driven from rAF so a fast
  // scroll cannot queue a style write per scroll event.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || prefersReducedMotion()) return;
    let raf = 0;
    let queued = false;
    const apply = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      host.style.setProperty("--drift", `${(p * -5).toFixed(3)}%`);
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(apply);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    apply();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const src = variant ? SOURCES[variant] : null;

  return (
    <div ref={hostRef} aria-hidden="true" className="nebula-backdrop" data-video={playing ? "playing" : undefined}>
      {/* The poster is a real graded frame of the loop, so the still and the video are the same
          picture — there is no visible swap when playback begins. */}
      <img src={POSTER} alt="" className="nebula-layer nebula-poster" decoding="async" fetchPriority="high" />
      {src && (
        <video
          ref={videoRef}
          className="nebula-layer nebula-video"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster={POSTER}
          onPlaying={(e) => {
            e.currentTarget.classList.add("is-ready");
            setPlaying(true);
          }}
          onWaiting={() => setPlaying(false)}
          onStalled={() => setPlaying(false)}
          onError={() => setPlaying(false)}
        >
          <source src={src.webm} type="video/webm" />
          <source src={src.mp4} type="video/mp4" />
        </video>
      )}
    </div>
  );
}
