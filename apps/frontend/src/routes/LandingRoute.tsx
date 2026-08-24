import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Mic,
  Clapperboard,
  Shield,
  Palette,
  Code2,
  Monitor,
  Smartphone,
  Globe,
  ArrowRight,
  ArrowDown,
  Check,
  Gamepad2,
  Users,
  Lock,
  Gavel,
  Sparkles,
  CalendarClock,
} from "lucide-react";
import { SiteNav, SiteFooter } from "../components/site/SiteChrome";
import { SiteStatusPill } from "../components/SiteStatusPill";
import { BrowserFrame, PhoneFrame } from "../components/site/Showcase";
import { useActiveSection, useCountUp, useInViewVideo, useReveal, useSpotlight, useTilt } from "../components/site/useLanding";
import { useSiteStats } from "../queries/site";
import "../components/site/landing.css";

/**
 * The public front door — a cinematic scroll journey through the brand's own cosmos.
 *
 * The design rests on four decisions:
 *  1. The background is a seamless ~5-minute loop of REAL NEBULAE — Orion, Westerlund 2, the
 *     Lagoon, the Tarantula, the Helix and the Cygnus Loop, all public-domain Hubble/Spitzer
 *     imagery — graded to the brand violet and fixed behind the whole page, so scrolling travels
 *     through them. Built by scripts/build-nebula-loop.sh; see CosmicBackdrop for how it is
 *     served (poster-first, resolution by device, skipped entirely on Save-Data).
 *  2. TYPE CARRIES THE PAGE. Scale contrast is the whole personality: enormous, tightly-tracked
 *     display type against tiny wide-tracked mono labels, with deliberately little in between.
 *     Headings are left-aligned and asymmetric — a page of centred blocks reads as a template.
 *  3. Sections float as glass panes (.cosmic-panel) with the cosmos visible between them, and
 *     the product imagery deliberately BREAKS OUT of those panes — a screenshot boxed inside
 *     every container is what makes a marketing page look like a slide deck.
 *  4. The page COMMITS to the dark cosmic look (.landing-cosmic re-pins the theme tokens). The
 *     app itself keeps all seven themes.
 *
 * Everything decorative respects prefers-reduced-motion and every section works with JS-free
 * semantics underneath. All product footage is REAL (see scripts/capture-motion.mjs).
 */

const CosmicBackdrop = lazy(() => import("../components/site/CosmicBackdrop"));

/** Rail entries double as the page's table of contents. `apps` is also the nav's /#apps anchor. */
const CHAPTERS = [
  { id: "live", label: "Live" },
  { id: "feed", label: "Feed" },
  { id: "creators", label: "Creators" },
  { id: "themes", label: "Themes" },
  { id: "everything", label: "Everything" },
  { id: "apps", label: "Apps" },
  { id: "promise", label: "Promise" },
];

export function LandingRoute() {
  return (
    <div className="landing-cosmic relative min-h-app overflow-x-hidden bg-base-900 text-signal">
      <SiteNav />

      {/* Real nebulae — Hubble and Spitzer frames, graded to the brand violet — fixed behind the
          whole page, so scrolling travels through them. */}
      <Suspense fallback={null}>
        <CosmicBackdrop />
      </Suspense>

      <SectionRail />

      <div className="relative z-10">
        <Hero />
        <StatBand />
        <LiveChapter />
        <FeedChapter />
        <CreatorsChapter />
        <ThemesChapter />
        <EverythingChapter />
        <AppsChapter />
        <PromiseChapter />
        <CtaBand />
        <BackdropCredit />
        <SiteFooter />
      </div>

      <div aria-hidden="true" className="film-grain" />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Section rail — a fixed index of the page. Real navigation on a page this long, and the
 * "where am I" readout for the descent.
 * ------------------------------------------------------------------------------------------- */

function SectionRail() {
  const ids = useMemo(() => CHAPTERS.map((c) => c.id), []);
  const active = useActiveSection(ids);
  return (
    <nav aria-label="Page sections" className="rail hidden lg:block">
      <ul>
        {CHAPTERS.map((c) => (
          <li key={c.id}>
            <a href={`#${c.id}`} className="rail-item" data-active={active === c.id}>
              <span aria-hidden="true" className="rail-tick" />
              <span className="rail-label">{c.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Hero — left-aligned and enormous. The type IS the hero.
 * ------------------------------------------------------------------------------------------- */

function Hero() {
  // Mounted → reveal classes flip after first paint, choreographing the entrance sequence.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const tilt = useTilt(4);

  return (
    <section className="relative isolate">
      {/* A soft scrim under the copy. The nebula is alive, so a bright cloud can drift behind the
          text at any moment — this guarantees the contrast floor whichever frame the visitor
          happens to land on. Weighted left, where the copy is. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[110svh]"
        style={{ background: "radial-gradient(ellipse 70% 55% at 32% 42%, rgba(10,7,20,0.80), rgba(10,7,20,0.30) 58%, transparent 80%)" }}
      />

      <div data-revealed={entered} className="relative mx-auto flex min-h-[92svh] max-w-6xl flex-col justify-center px-6 py-20 sm:px-8 sm:py-24">
        <div className="max-w-4xl">
          <div className="reveal" style={{ ["--reveal-delay" as string]: "0ms" }}>
            <SiteStatusPill />
          </div>

          <h1 className="reveal display-xl lit mt-8" style={{ ["--reveal-delay" as string]: "120ms" }}>
            Your
            <br />
            community,
            <br />
            <span className="hero-gradient-text">all in one place.</span>
          </h1>

          <div className="reveal rule mt-9 max-w-[16rem]" style={{ ["--reveal-delay" as string]: "300ms" }} />

          <p
            className="reveal mt-7 max-w-xl text-base leading-relaxed text-signal-dim sm:text-lg"
            style={{ ["--reveal-delay" as string]: "380ms" }}
          >
            Chat, voice and video, a short-video feed, a creator economy, bots and games — one app.
            No ads sold against your conversations, no algorithm you can't turn off.
          </p>

          <div
            className="reveal mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
            style={{ ["--reveal-delay" as string]: "480ms" }}
          >
            <Link
              to="/register"
              className="group flex w-full items-center justify-center gap-2 rounded-full bg-accent px-7 py-3.5 font-medium text-white shadow-xl shadow-accent/30 transition hover:bg-accent-hover sm:w-auto"
            >
              Create your account
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Link
              to="/features"
              className="flex w-full items-center justify-center gap-2 rounded-full border border-hairline bg-base-800/50 px-7 py-3.5 font-medium text-signal transition hover:border-accent sm:w-auto"
            >
              See everything it does
            </Link>
          </div>

          <p className="reveal label-mono mt-7 text-signal-faint" style={{ ["--reveal-delay" as string]: "580ms" }}>
            Free to join · 18+ only
          </p>
        </div>

        <div aria-hidden="true" className="reveal absolute bottom-8 left-6 sm:left-8" style={{ ["--reveal-delay" as string]: "900ms" }}>
          <ArrowDown className="scroll-indicator-dot h-4 w-4 text-signal-faint" />
        </div>
      </div>

      {/* The product, breaking out of the text column into open space. */}
      <div data-revealed={entered} className="relative mx-auto max-w-7xl px-6 pb-28 sm:px-8">
        <div className="reveal tilt-wrap" style={{ ["--reveal-delay" as string]: "700ms" }}>
          <div className="tilt-card" {...tilt}>
            <VideoBrowserFrame
              webm="/screens/motion/chat-desktop.webm"
              mp4="/screens/motion/chat-desktop.mp4"
              poster="/screens/app-chat.png"
              label="A Lumina server — a live conversation with reactions arriving in real time"
              glow
            />
          </div>
        </div>
        <div className="float-slow absolute -bottom-4 right-2 hidden w-40 md:block lg:w-52">
          <VideoPhoneFrame
            webm="/screens/motion/chat-mobile.webm"
            mp4="/screens/motion/chat-mobile.mp4"
            poster="/screens/app-mobile-chat.png"
            label="The same Lumina conversation on a phone"
          />
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Device frames playing real product footage. Poster = the real screenshot, so nothing is ever
 * blank: no JS, slow network, missing file — the page still shows the true product.
 * ------------------------------------------------------------------------------------------- */

function VideoBrowserFrame({
  webm,
  mp4,
  poster,
  label,
  url = "lumina.badgerstudios.net",
  glow = false,
  className = "",
}: {
  webm: string;
  mp4: string;
  poster: string;
  label: string;
  url?: string;
  glow?: boolean;
  className?: string;
}) {
  const ref = useInViewVideo();
  return (
    <div className={`relative ${className}`}>
      {glow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-3 -z-10 rounded-[2.5rem] opacity-70 blur-3xl sm:-inset-5 2xl:-inset-10"
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in srgb, var(--ion) 38%, transparent), color-mix(in srgb, var(--aurora) 16%, transparent), transparent)",
          }}
        />
      )}
      <div className="overflow-hidden rounded-xl border border-hairline bg-base-800 shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-hairline bg-base-700 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-flare" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber" />
          <span className="h-2.5 w-2.5 rounded-full bg-pulse" />
          <span className="ml-3 truncate font-mono text-[11px] text-signal-faint">{url}</span>
        </div>
        <video ref={ref} className="device-video" muted loop playsInline preload="metadata" poster={poster} aria-label={label}>
          <source src={webm} type="video/webm" />
          <source src={mp4} type="video/mp4" />
        </video>
      </div>
    </div>
  );
}

function VideoPhoneFrame({
  webm,
  mp4,
  poster,
  label,
  className = "",
}: {
  webm: string;
  mp4: string;
  poster: string;
  label: string;
  className?: string;
}) {
  const ref = useInViewVideo();
  return (
    <div className={`overflow-hidden rounded-[2.2rem] border-[7px] border-base-600 bg-base-900 shadow-2xl ${className}`}>
      <video
        ref={ref}
        className="device-video rounded-[1.5rem]"
        muted
        loop
        playsInline
        preload="metadata"
        poster={poster}
        aria-label={label}
      >
        <source src={webm} type="video/webm" />
        <source src={mp4} type="video/mp4" />
      </video>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Chapter primitives. A chapter is: a mono label, a big left-aligned statement, a rule, and
 * whatever composition that chapter needs — deliberately NOT one repeated row layout.
 * ------------------------------------------------------------------------------------------- */

function Chapter({
  id,
  children,
  className = "",
  pane = true,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
  pane?: boolean;
}) {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} id={id} className="scroll-mt-24 px-4 py-12 sm:px-6 sm:py-16">
      <div className={`${pane ? "cosmic-panel" : ""} reveal mx-auto max-w-6xl ${pane ? "px-6 py-14 sm:px-12 sm:py-16" : ""} ${className}`}>
        {children}
      </div>
    </section>
  );
}

function ChapterHead({ label, title, body, className = "" }: { label: string; title: React.ReactNode; body?: string; className?: string }) {
  return (
    <header className={`max-w-3xl ${className}`}>
      <p className="label-mono text-accent">{label}</p>
      <h2 className="display-lg mt-5 text-signal">{title}</h2>
      <div className="rule mt-7 max-w-[10rem]" />
      {body && <p className="mt-7 max-w-xl text-base leading-relaxed text-signal-dim">{body}</p>}
    </header>
  );
}

/** A short checklist under a chapter head. Two columns on wide screens so it reads as a spec
 *  sheet rather than a long ladder of ticks. */
function PointList({ points, className = "" }: { points: string[]; className?: string }) {
  return (
    <ul className={`grid gap-x-8 gap-y-3 sm:grid-cols-2 ${className}`}>
      {points.map((p) => (
        <li key={p} className="flex items-start gap-3">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-pulse" />
          <span className="text-sm leading-relaxed text-signal-dim">{p}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Stats — real numbers from /api/site/stats. Huge figures against hairline-divided mono labels.
 * ------------------------------------------------------------------------------------------- */

function StatCounter({ label, value }: { label: string; value?: number }) {
  const { ref, value: shown } = useCountUp(value);
  return (
    <div className="px-5 py-7 sm:px-8">
      <div ref={ref as React.RefObject<HTMLDivElement>} className="display-num text-signal">
        {typeof value === "number" ? shown.toLocaleString() : "—"}
      </div>
      <div className="label-mono mt-3 text-signal-faint">{label}</div>
    </div>
  );
}

function StatBand() {
  const { data } = useSiteStats();
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="px-4 sm:px-6">
      <div className="reveal mx-auto grid max-w-6xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline/60 sm:grid-cols-4">
        {/* gap-px over a hairline background paints the dividers — no divide-x edge cases. */}
        {[
          { label: "Members", value: data?.totals.users },
          { label: "Online now", value: data?.totals.onlineNow },
          { label: "Videos shared", value: data?.totals.videos },
          { label: "Platforms", value: 5 },
        ].map((s) => (
          <div key={s.label} className="bg-base-900/85">
            <StatCounter label={s.label} value={s.value} />
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Chapters.
 * ------------------------------------------------------------------------------------------- */

/** Live — copy on the left, footage breaking out to the right past the pane edge. */
function LiveChapter() {
  const tilt = useTilt(3);
  return (
    <Chapter id="live">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
        <div>
          <ChapterHead
            label="Alive by default"
            title={
              <>
                Watch a server
                <br />
                breathe
              </>
            }
            body="A real Lumina conversation, recorded from the running app — messages landing, reactions stacking up, presence flickering on."
          />
          <PointList
            className="mt-9 sm:grid-cols-1"
            points={[
              "Reactions, replies, threads and polls",
              "Voice & video rooms with screen sharing",
              "Presence and typing synced across devices",
              "Slash commands and bots in the conversation",
            ]}
          />
        </div>
        {/* Negative margin on wide screens: the frame escapes the pane into open space. */}
        <div className="tilt-wrap 2xl:-mr-20">
          <div className="tilt-card" {...tilt}>
            <VideoBrowserFrame
              webm="/screens/motion/chat-desktop.webm"
              mp4="/screens/motion/chat-desktop.mp4"
              poster="/screens/app-chat.png"
              label="A live Lumina conversation — messages and reactions arriving in real time"
              glow
            />
          </div>
        </div>
      </div>
    </Chapter>
  );
}

/** Feed — the phone is the hero here, so it sits large and off-axis with copy tucked beside it. */
function FeedChapter() {
  return (
    <Chapter id="feed">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div className="flex justify-center lg:order-1 lg:justify-start lg:-ml-8">
          <div className="float-slower w-2/3 max-w-[16rem] sm:w-1/2 lg:w-full">
            <VideoPhoneFrame
              webm="/screens/motion/feed-mobile.webm"
              mp4="/screens/motion/feed-mobile.mp4"
              poster="/screens/app-mobile-feed.png"
              label="Scrolling Lumina's vertical For You video feed on a phone"
            />
          </div>
        </div>
        <div className="lg:order-2">
          <ChapterHead
            label="A feed of your own"
            title={
              <>
                A short-video feed,
                <br />
                built right in
              </>
            }
            body="A full vertical For You feed lives inside Lumina — not bolted on. Upload, get discovered by a real recommendation engine, and keep your audience where your community already is."
          />
          <PointList
            className="mt-9"
            points={[
              "Likes, comments, stitch and duet",
              "A personalised For You plus Following",
              "Every upload staff-reviewed before it's seen",
              "Adults-only, with age confirmed first",
            ]}
          />
        </div>
      </div>
    </Chapter>
  );
}

/** Creators — the money chapter leads with the number, not the screenshot. */
function CreatorsChapter() {
  const tilt = useTilt(3);
  return (
    <Chapter id="creators">
      <div className="grid items-end gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div>
          <ChapterHead label="Creator economy" title="Creators actually get paid" />
          <div className="mt-10 flex items-baseline gap-5">
            <span className="display-num text-accent lit">90%</span>
            <span className="max-w-[14rem] text-sm leading-relaxed text-signal-dim">
              of every membership payment goes to the creator, not the platform.
            </span>
          </div>
          <PointList
            className="mt-10 sm:grid-cols-1"
            points={[
              "Tips and gifts on videos and in chat",
              "A daily ad-revenue pool split across creators",
              "Every cent visible in a real ledger",
              "Earnings accrue safely until payouts open",
            ]}
          />
        </div>
        <div className="tilt-wrap 2xl:-mr-20">
          <div className="tilt-card" {...tilt}>
            <BrowserFrame src="/screens/app-studio.png" alt="Lumina's Creator Studio — earnings, payouts, membership tiers and eligibility" glow />
          </div>
        </div>
      </div>
    </Chapter>
  );
}

const THEME_SHOTS = [
  { src: "/screens/app-chat.png", label: "Nebula", sub: "the default violet dark" },
  { src: "/screens/app-chat-midnight.png", label: "Midnight", sub: "true black, made for OLED" },
  { src: "/screens/app-chat-moss.png", label: "Moss", sub: "a warm green dark" },
  { src: "/screens/app-chat-daylight.png", label: "Daylight", sub: "a soft, gentle light" },
];

/** Themes — an asymmetric gallery: the first shot leads at double size, the rest follow smaller. */
function ThemesChapter() {
  return (
    <Chapter id="themes">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-14">
        <ChapterHead
          label="Make it yours"
          title={
            <>
              Seven themes.
              <br />
              Every surface.
            </>
          }
          body="Not a dark-mode toggle — seven complete palettes, light and dark, that re-skin the entire app. Here's the exact same conversation in four of them."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {THEME_SHOTS.map((t, i) => (
            <figure
              key={t.label}
              className="reveal group overflow-hidden rounded-xl border border-hairline bg-base-800/60 transition hover:-translate-y-1 hover:border-accent hover:shadow-2xl hover:shadow-accent/10"
              style={{ ["--reveal-delay" as string]: `${i * 90}ms` }}
            >
              <img src={t.src} alt={`Lumina in the ${t.label} theme`} loading="lazy" className="block w-full border-b border-hairline" />
              <figcaption className="px-4 py-3">
                <div className="font-display text-sm font-bold text-signal">{t.label}</div>
                <div className="mt-1.5 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-signal-faint">{t.sub}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
      <p className="label-mono mt-10 text-signal-faint">…plus Carbon, Slate and Parchment — switch from the top corner right now</p>
    </Chapter>
  );
}

/* ---- Everything (features bento) ----------------------------------------------------------- */

const FEATURES: Array<{ icon: typeof Mic; title: string; body: string; span?: string }> = [
  {
    icon: Mic,
    title: "Voice & video",
    body: "Peer-to-peer rooms with screen sharing, Go Live streaming, push-to-talk and a live speaking indicator. No third-party meeting service in the middle.",
    span: "sm:col-span-2",
  },
  {
    icon: Gavel,
    title: "Moderation that shows its work",
    body: "A review queue, report tickets with visible outcomes, an appeal path, AutoMod keyword filters, and an audit log of every privileged action.",
  },
  {
    icon: Code2,
    title: "Bots & an API",
    body: "OAuth2 apps, slash commands, webhooks, a documented HTTP API — and a compatibility layer that runs real Discord bots unmodified.",
  },
  {
    icon: Lock,
    title: "Post-quantum encryption",
    body: "Hybrid X25519 + ML-KEM traffic encryption with rotating keys, layered inside TLS. Security that's ready for what's next.",
  },
  {
    icon: Gamepad2,
    title: "Games & activities",
    body: "Link a Minecraft server, stream its live state into a channel, and run embedded activities right inside your community.",
  },
  {
    icon: Shield,
    title: "Adults only, enforced",
    body: "Lumina is 18+. Age is checked before an account exists, the video feed and payments need a confirmed adult, and every refusal carries a reason and an appeal route.",
  },
  {
    icon: CalendarClock,
    title: "Events, polls & more",
    body: "Scheduled events with RSVPs, message polls, stickers, custom emoji, threads, a soundboard, and an XP-and-levels system.",
  },
];

function FeatureCard({
  icon: Icon,
  title,
  body,
  span,
  index,
}: {
  icon: typeof Mic;
  title: string;
  body: string;
  span?: string;
  index: number;
}) {
  const spotlight = useSpotlight();
  return (
    <div
      {...spotlight}
      className={`reveal spotlight-card group flex flex-col rounded-xl border border-hairline bg-base-800/50 p-6 transition hover:-translate-y-0.5 hover:border-accent ${span ?? ""}`}
      style={{ ["--reveal-delay" as string]: `${(index % 3) * 80}ms` }}
    >
      <Icon className="h-5 w-5 text-accent transition group-hover:scale-110" />
      <h3 className="mt-6 font-display text-base font-bold text-signal">{title}</h3>
      <p className="mt-2.5 text-sm leading-relaxed text-signal-dim">{body}</p>
    </div>
  );
}

function EverythingChapter() {
  return (
    <Chapter id="everything">
      <ChapterHead
        label="And so much more"
        title={
          <>
            One app, not a pile
            <br />
            of integrations
          </>
        }
        body="Everything below is built in and works together — because it's one product, not a marketplace of plugins you have to assemble."
      />
      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <FeatureCard key={f.title} {...f} index={i} />
        ))}
        <div
          className="reveal flex flex-col justify-between rounded-xl border border-hairline bg-gradient-to-br from-[color-mix(in_srgb,var(--accent)_20%,transparent)] to-transparent p-6"
          style={{ ["--reveal-delay" as string]: "160ms" }}
        >
          <Palette className="h-5 w-5 text-accent" />
          <div>
            <h3 className="mt-6 font-display text-base font-bold text-signal">Seven full themes</h3>
            <p className="mt-2.5 text-sm leading-relaxed text-signal-dim">Every surface re-skins — try the picker in the top corner.</p>
          </div>
        </div>
      </div>
    </Chapter>
  );
}

/* ---- Apps ---------------------------------------------------------------------------------- */

const PLATFORMS = [
  { icon: Globe, name: "Web", detail: "Any modern browser. Nothing to install.", href: "/register", cta: "Open in browser", internal: true },
  { icon: Smartphone, name: "Android", detail: "Native app with push notifications.", href: "/downloads/lumina.apk", cta: "Download APK", internal: false },
  { icon: Monitor, name: "Windows", detail: "Portable build — unzip and run.", href: "/downloads/lumina-windows.zip", cta: "Download for Windows", internal: false },
  { icon: Monitor, name: "Linux desktop", detail: "Portable AppImage, no installer.", href: "/downloads/lumina-desktop.AppImage", cta: "Download AppImage", internal: false },
];

function AppsChapter() {
  return (
    <Chapter id="apps">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <ChapterHead
          label="Get the app"
          title={
            <>
              Wherever
              <br />
              you already are
            </>
          }
          body="Same account, same conversations, synced live across every device."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {PLATFORMS.map(({ icon: Icon, name, detail, href, cta, internal }, i) => (
            <div
              key={name}
              className="reveal flex flex-col rounded-xl border border-hairline bg-base-800/50 p-6 transition hover:-translate-y-0.5 hover:border-accent"
              style={{ ["--reveal-delay" as string]: `${i * 80}ms` }}
            >
              <Icon className="h-6 w-6 text-accent" />
              <h3 className="mt-5 font-display text-base font-bold text-signal">{name}</h3>
              <p className="mt-1.5 flex-1 text-sm text-signal-dim">{detail}</p>
              {internal ? (
                <Link to={href} className="mt-6 self-start rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hover">
                  {cta}
                </Link>
              ) : (
                <a href={href} className="mt-6 self-start rounded-full border border-hairline bg-base-700 px-4 py-2 text-sm font-medium text-signal transition hover:border-accent">
                  {cta}
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="label-mono mt-10 max-w-2xl leading-relaxed text-signal-faint">
        No iOS build yet — the web app installs to your home screen from Safari
      </p>
    </Chapter>
  );
}

/* ---- Promise ------------------------------------------------------------------------------- */

const PROMISES = [
  "Your data is yours — never sold, never used to target ads",
  "No advertising sold against your conversations",
  "No engagement algorithm you can't switch off",
  "Export or delete your account and data at any time",
];

function PromiseChapter() {
  return (
    <Chapter id="promise">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <ChapterHead
          label="Independent"
          title={
            <>
              Run by people,
              <br />
              not a platform
            </>
          }
          body="Lumina is built and hosted by Badger Studios, a small independent studio — not a big platform that measures you by ad revenue."
        />
        <ul className="divide-y divide-hairline border-y border-hairline">
          {PROMISES.map((p, i) => (
            <li
              key={p}
              className="reveal flex items-start gap-4 py-5"
              style={{ ["--reveal-delay" as string]: `${i * 80}ms` }}
            >
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-pulse" />
              <span className="text-sm leading-relaxed text-signal-dim">{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </Chapter>
  );
}

/* ---- Closing CTA --------------------------------------------------------------------------- */

function CtaBand() {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="px-4 py-16 pb-28 sm:px-6">
      <div className="reveal aurora-border mx-auto max-w-6xl rounded-3xl p-px">
        {/* Opaque background lives ON this div: it is what masks the rotating conic ring down to
            the 1px padding, so the card needs no separate cover element. */}
        <div
          className="relative overflow-hidden rounded-[calc(1.5rem-1px)] px-8 py-20 text-center sm:px-16 sm:py-28"
          style={{
            background:
              "radial-gradient(ellipse 70% 90% at 50% 0%, color-mix(in srgb, var(--ion) 24%, transparent), transparent 70%), var(--nebula)",
          }}
        >
          <h2 className="display-lg lit mx-auto max-w-2xl text-signal">Bring your people home.</h2>
          <p className="mx-auto mt-6 max-w-md text-base text-signal-dim">
            Create a server in under a minute. Invite your community. Make it home.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/register"
              className="group flex w-full items-center justify-center gap-2 rounded-full bg-accent px-8 py-3.5 font-medium text-white shadow-xl shadow-accent/30 transition hover:bg-accent-hover sm:w-auto"
            >
              Get started free
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Link
              to="/login"
              className="flex w-full items-center justify-center rounded-full border border-hairline bg-base-900/40 px-8 py-3.5 font-medium text-signal transition hover:border-accent sm:w-auto"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Backdrop credit. The source imagery is public domain, so this carries no legal obligation —
 * it is here because naming the telescopes is both honest and the most credible thing on the
 * page: the background really is Hubble data, not a render.
 * ------------------------------------------------------------------------------------------- */

function BackdropCredit() {
  return (
    <div className="px-6 pb-10 sm:px-8">
      <p className="mx-auto max-w-6xl font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-signal-faint/70">
        Backdrop: the Orion, Westerlund 2, Lagoon, Tarantula, Helix and Cygnus Loop nebulae —
        imaged by Hubble and Spitzer. Courtesy NASA / ESA / STScI / JPL-Caltech, public domain.
      </p>
    </div>
  );
}
