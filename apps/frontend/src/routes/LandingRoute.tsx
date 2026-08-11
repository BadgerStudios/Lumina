import { Link } from "react-router-dom";
import {
  MessageSquare,
  Mic,
  Clapperboard,
  Shield,
  Palette,
  Code2,
  Monitor,
  Smartphone,
  Globe,
  ArrowRight,
  Check,
} from "lucide-react";

/**
 * The public front door.
 *
 * Until this existed, every link to Lumina landed a stranger on a login form with no indication of
 * what they were being asked to sign into. This page is what an unauthenticated web visitor sees at
 * `/`; the app itself moved to `/app`, and anyone with a session is redirected straight there so a
 * returning user never reads marketing copy twice.
 *
 * Web-only by construction — App.tsx routes `/` to the app on native builds, where CLIENT_TYPE is
 * set at build time. An Android or desktop launch must never open a marketing page.
 *
 * Everything here uses the same design tokens as the app (base/signal/accent/hairline), so all
 * seven themes apply to it without a second palette to maintain.
 */
export function LandingRoute() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-base-900 text-signal">
      <SiteNav />
      <Hero />
      <Features />
      <Platforms />
      <SelfHosted />
      <SiteFooter />
    </div>
  );
}

function SiteNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-base-900/80 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3.5">
        <Link to="/" className="flex items-center gap-2">
          <Mark />
          <span className="font-display text-lg font-bold tracking-tight">Lumina</span>
        </Link>
        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          <a
            href="#features"
            className="hidden rounded-full px-3 py-1.5 text-sm text-signal-dim transition hover:text-signal sm:block"
          >
            Features
          </a>
          <a
            href="#apps"
            className="hidden rounded-full px-3 py-1.5 text-sm text-signal-dim transition hover:text-signal sm:block"
          >
            Apps
          </a>
          <Link
            to="/login"
            className="rounded-full px-3 py-1.5 text-sm text-signal-dim transition hover:text-signal"
          >
            Sign in
          </Link>
          <Link
            to="/register"
            className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent-hover"
          >
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}

/**
 * The Lumina mark — the real logo asset, not a drawn substitute.
 *
 * This was previously an inline SVG "L" glyph invented for the landing page, on the reasoning that
 * a vector mark could inherit the accent colour per theme. That reasoning was wrong: it put a logo
 * on the public marketing site that the product does not use anywhere else. Every other entry
 * point — sign-in, register, invite, the OAuth consent screen — already renders
 * /icons/logo-128.png, so the one page a new visitor sees first was the only one showing a
 * different brand.
 *
 * A brand mark is fixed artwork. It does not re-tint per theme, and it should not have been
 * treated as a themeable component.
 */
function Mark({ className = "h-8 w-8" }: { className?: string }) {
  return <img src="/icons/logo-128.png" alt="" aria-hidden="true" className={className} />;
}

function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* Ambient glow. pointer-events-none and aria-hidden — it is decoration and must never
          intercept a click on the buttons layered above it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(60rem 30rem at 50% -8rem, color-mix(in srgb, var(--accent) 28%, transparent), transparent 70%)",
        }}
      />
      <div className="mx-auto max-w-4xl px-5 pb-20 pt-16 text-center sm:pt-24">
        <img
          src="/icons/pwa-512.png"
          alt="Lumina"
          width={96}
          height={96}
          className="mx-auto mb-6 h-20 w-20 rounded-3xl shadow-2xl sm:h-24 sm:w-24"
        />
        <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-base-800/70 px-3 py-1 text-xs text-signal-dim">
          <span className="h-1.5 w-1.5 rounded-full bg-pulse" />
          Self-hosted and running
        </span>

        <h1 className="mt-6 font-display text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-6xl">
          Your community,
          <br />
          <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--pulse)] bg-clip-text text-transparent">
            on your own terms.
          </span>
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-signal-dim sm:text-lg">
          Servers, channels, direct messages, voice and video, and a short-video feed — in one place
          you actually control. No ads sold against your conversations, no algorithm you can't turn
          off, no company deciding your community's fate.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/register"
            className="group flex w-full items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 font-medium text-white transition hover:bg-accent-hover sm:w-auto"
          >
            Create your account
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </Link>
          <Link
            to="/login"
            className="flex w-full items-center justify-center gap-2 rounded-full border border-hairline bg-base-800 px-6 py-3 font-medium text-signal transition hover:border-accent sm:w-auto"
          >
            Sign in
          </Link>
        </div>

        <p className="mt-4 text-xs text-signal-faint">Free to join · No credit card · 18+ for the video feed</p>
      </div>

      <AppPreview />
    </section>
  );
}

/**
 * A stylised representation of the app chrome rather than a screenshot: a real screenshot would go
 * stale the moment the UI changes and would leak whatever happened to be on screen when it was
 * taken. This is built from the same tokens, so it re-themes along with everything else.
 */
function AppPreview() {
  return (
    <div className="mx-auto max-w-5xl px-5 pb-24">
      <div className="overflow-hidden rounded-2xl border border-hairline bg-base-800 shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-hairline bg-base-700 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-flare" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber" />
          <span className="h-2.5 w-2.5 rounded-full bg-pulse" />
          <span className="ml-3 font-mono text-[11px] text-signal-faint">lumina.badgerstudios.net</span>
        </div>
        {/* The placeholder bars are tinted from signal-faint rather than the base-* surfaces:
            in the light themes base-600/700 are near-white, which made the whole mock read as an
            empty box. signal-faint is a text tone, so it keeps contrast against the panel in both
            directions. */}
        <div className="flex h-[19rem] sm:h-[23rem]">
          <div className="hidden w-14 shrink-0 flex-col items-center gap-3 border-r border-hairline bg-base-900 py-4 sm:flex">
            <img src="/icons/logo-128.png" alt="" aria-hidden="true" className="h-9 w-9 rounded-xl" />
            {["", "", ""].map((_, i) => (
              <div key={i} className="h-9 w-9 rounded-2xl bg-signal-faint/25" />
            ))}
          </div>
          <div className="hidden w-44 shrink-0 flex-col gap-2 border-r border-hairline bg-base-800 p-3 sm:flex">
            <div className="h-3 w-20 rounded bg-signal-faint/45" />
            {[68, 52, 76, 44, 60].map((w, i) => (
              <div key={i} className="h-2.5 rounded bg-signal-faint/25" style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            {[
              { w: "72%", accent: true },
              { w: "48%", accent: false },
              { w: "84%", accent: false },
              { w: "36%", accent: true },
              { w: "64%", accent: false },
            ].map((row, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <div
                  className={`h-7 w-7 shrink-0 rounded-full ${row.accent ? "bg-accent" : "bg-signal-faint/35"}`}
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-2.5 w-24 rounded bg-signal-faint/45" />
                  <div className="h-2.5 rounded bg-signal-faint/25" style={{ width: row.w }} />
                </div>
              </div>
            ))}
            <div className="mt-auto h-9 rounded-lg border border-hairline bg-signal-faint/10" />
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: MessageSquare,
    title: "Servers, channels, DMs",
    body: "Roles and per-channel permissions, threads, reactions, pins, search, and group DMs. The parts of a chat app you'd miss immediately if they were absent.",
  },
  {
    icon: Mic,
    title: "Voice and video",
    body: "Peer-to-peer voice and video rooms with screen sharing, push-to-talk, and a live speaking indicator. No third-party meeting service in the middle.",
  },
  {
    icon: Clapperboard,
    title: "A short-video feed",
    body: "Upload short videos with tags and captions to a vertical feed, with likes, comments and a Following tab. Every upload is reviewed before anyone sees it.",
  },
  {
    icon: Shield,
    title: "Moderation that's real",
    body: "A review queue, report tickets with owners and outcomes, an appeal path, and an audit log of every privileged action. Reporters are told what happened.",
  },
  {
    icon: Palette,
    title: "Seven full themes",
    body: "Not a dark-mode toggle — seven complete palettes, light and dark, applied across every surface including this page.",
  },
  {
    icon: Code2,
    title: "Bots and an API",
    body: "OAuth2 applications, bot accounts, webhooks and a documented HTTP API, so you can automate your community instead of asking someone's permission.",
  },
];

function Features() {
  return (
    <section id="features" className="border-t border-hairline bg-base-900 py-20">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading
          eyebrow="What's inside"
          title="Everything a community needs"
          sub="Built as one app, so these work together rather than through integrations."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="group rounded-xl border border-hairline bg-base-800 p-5 transition hover:border-accent"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-base-700 text-accent transition group-hover:bg-accent group-hover:text-white">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-display text-base font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-signal-dim">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const PLATFORMS = [
  {
    icon: Globe,
    name: "Web",
    detail: "Any modern browser. Nothing to install.",
    href: "/register",
    cta: "Open in browser",
    internal: true,
  },
  {
    icon: Smartphone,
    name: "Android",
    detail: "Native app with push notifications.",
    href: "/downloads/lumina.apk",
    cta: "Download APK",
    internal: false,
  },
  {
    icon: Monitor,
    name: "Linux desktop",
    detail: "Portable AppImage, no installer needed.",
    href: "/downloads/lumina-desktop.AppImage",
    cta: "Download AppImage",
    internal: false,
  },
];

function Platforms() {
  return (
    <section id="apps" className="border-t border-hairline bg-base-800/40 py-20">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading
          eyebrow="Get the app"
          title="Wherever you already are"
          sub="Same account, same conversations, synced live across every device."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {PLATFORMS.map(({ icon: Icon, name, detail, href, cta, internal }) => (
            <div
              key={name}
              className="flex flex-col rounded-xl border border-hairline bg-base-800 p-6 text-center transition hover:border-accent"
            >
              <Icon className="mx-auto h-8 w-8 text-accent" />
              <h3 className="mt-4 font-display text-lg font-bold">{name}</h3>
              <p className="mt-1.5 text-sm text-signal-dim">{detail}</p>
              {internal ? (
                <Link
                  to={href}
                  className="mt-5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hover"
                >
                  {cta}
                </Link>
              ) : (
                // A real file download, not a router navigation — these are served by nginx from
                // /downloads, outside the SPA entirely.
                <a
                  href={href}
                  className="mt-5 rounded-full border border-hairline bg-base-700 px-4 py-2 text-sm font-medium text-signal transition hover:border-accent"
                >
                  {cta}
                </a>
              )}
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-xs text-signal-faint">
          iOS and Windows builds aren't available yet — the web app works on both.
        </p>
      </div>
    </section>
  );
}

const PROMISES = [
  "Your messages live on hardware you control",
  "No advertising sold against your conversations",
  "No engagement algorithm you can't switch off",
  "Export or delete your account and data at any time",
];

function SelfHosted() {
  return (
    <section className="border-t border-hairline py-20">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 lg:grid-cols-2">
        <div>
          <SectionHeading
            eyebrow="Self-hosted"
            title="Run by people, not a platform"
            sub="Lumina runs on its own server. There is no company between you and your community deciding what it's worth."
            align="left"
          />
        </div>
        <ul className="space-y-3">
          {PROMISES.map((p) => (
            <li
              key={p}
              className="flex items-start gap-3 rounded-lg border border-hairline bg-base-800 p-4"
            >
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-pulse" />
              <span className="text-sm text-signal-dim">{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  sub,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  sub: string;
  align?: "center" | "left";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <p className="font-mono text-xs uppercase tracking-widest text-accent">{eyebrow}</p>
      <h2 className="mt-3 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h2>
      <p className="mt-3 text-base leading-relaxed text-signal-dim">{sub}</p>
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-base-900 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-5 sm:flex-row">
        <div className="flex items-center gap-2">
          <Mark />
          <span className="font-display text-base font-bold">Lumina</span>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-signal-dim sm:ml-auto">
          <Link to="/login" className="transition hover:text-signal">
            Sign in
          </Link>
          <Link to="/register" className="transition hover:text-signal">
            Create account
          </Link>
          <Link to="/privacy" className="transition hover:text-signal">
            Privacy
          </Link>
          <a href="/downloads/lumina.apk" className="transition hover:text-signal">
            Android
          </a>
          <a href="/downloads/lumina-desktop.AppImage" className="transition hover:text-signal">
            Desktop
          </a>
        </nav>
      </div>
      <p className="mx-auto mt-6 max-w-6xl px-5 text-xs text-signal-faint">
        © {new Date().getFullYear()} Lumina · Self-hosted by Badger Studios
      </p>
    </footer>
  );
}
