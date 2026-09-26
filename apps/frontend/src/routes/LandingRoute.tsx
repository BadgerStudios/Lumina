import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Check, Hash, Monitor, Globe, Smartphone, SendHorizontal } from "lucide-react";
import { SiteNav, SiteFooter } from "../components/site/SiteChrome";
import { useInViewVideo } from "../components/site/useLanding";
import { useSiteStats } from "../queries/site";
import { PLAY_STORE_URL, PlayStoreBadge } from "../components/site/PlayStoreBadge";
import "../components/site/landing2.css";

/**
 * The public front door.
 *
 * Lumina means light, and the page is built on that one idea: a dusk-coloured room where the only
 * warm light is things happening live — people online, a message landing. Everything else stays
 * quiet so that light reads.
 *
 * The one bold element is the hero conversation. It is not a screenshot: it is a working, scripted
 * Lumina channel that plays in once, and the visitor can type into it and get answered. That says
 * "this is a place people talk" faster than any feature list. The rest of the page is deliberately
 * plain: one tabbed frame of real app footage, one light band for the promise and the 90% number,
 * and a list of where to get the app — Google Play first.
 *
 * The page pins its own palette (see landing2.css); the app keeps its seven themes.
 */

export function LandingRoute() {
  return (
    <div className="lm2 min-h-app">
      <SiteNav />
      <main>
        <Hero />
        <Inside />
        <Promise />
        <Apps />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------------------------- */

function OnlineNow() {
  const { data } = useSiteStats();
  const online = data?.totals.onlineNow;
  if (typeof online !== "number" || online < 1) return null;
  return (
    <p className="lm2-live">
      <span className="lm2-live-dot" aria-hidden="true" />
      {online === 1 ? "1 person on Lumina right now" : `${online.toLocaleString()} people on Lumina right now`}
    </p>
  );
}

function Hero() {
  return (
    <section className="lm2-hero">
      <div className="lm2-wrap lm2-hero-grid">
        <div className="lm2-hero-copy">
          <OnlineNow />
          <h1 className="lm2-display">Where your people hang out.</h1>
          <p className="lm2-lede">
            Chat, voice and video rooms, a short-video feed and a way for creators to get paid, in one
            app. Run by a small studio, with no ads sold against your conversations.
          </p>
          <div className="lm2-cta-row">
            <Link to="/register" className="lm2-btn lm2-btn-primary">
              Create your account
            </Link>
            <PlayStoreBadge />
          </div>
          <p className="lm2-fine">
            Free to join, adults only. Also on <Link to="/downloads">Windows, Linux</Link> and in your browser.
          </p>
        </div>
        <LiveChannel />
      </div>
    </section>
  );
}

/* ---- The live channel --------------------------------------------------------------------- */

interface Msg {
  id: number;
  who: string;
  tone: string;
  text: string;
  reaction?: string;
  you?: boolean;
}

const SCRIPT: Array<Omit<Msg, "id">> = [
  { who: "Maya", tone: "#FFB547", text: "voice room's open, who's in for the raid tonight?" },
  { who: "Diego", tone: "#7FD1B9", text: "in. bringing the new build", reaction: "🔥 3" },
  { who: "Priya", tone: "#FF8FA3", text: "posted the clip from last night in #highlights" },
  { who: "Sam", tone: "#8C6BFF", text: "that clip is going straight to the feed lol", reaction: "😂 5" },
];

const REPLIES = ["welcome in 👋", "hey! grab a seat in voice", "good timing, we're just starting"];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function LiveChannel() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const nextId = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);
  const replyIndex = useRef(0);
  const scriptTimers = useRef<number[]>([]);
  const scriptShown = useRef(0);

  // Plays the channel in once: each message preceded by its author typing. With reduced motion,
  // the whole conversation is simply there.
  useEffect(() => {
    if (prefersReducedMotion()) {
      scriptShown.current = SCRIPT.length;
      setMsgs(SCRIPT.map((m) => ({ ...m, id: nextId.current++ })));
      return;
    }
    const timers = scriptTimers.current;
    let at = 500;
    SCRIPT.forEach((m) => {
      timers.push(window.setTimeout(() => setTyping(m.who), at));
      at += 900 + Math.min(m.text.length * 18, 900);
      timers.push(
        window.setTimeout(() => {
          setTyping(null);
          scriptShown.current += 1;
          setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]);
        }, at),
      );
      at += 500;
    });
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, typing]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim().slice(0, 140);
    if (!text) return;
    setDraft("");
    // Typing before the scripted conversation has finished: finish it at once, so the visitor's
    // message lands at the bottom rather than in the middle of someone else's exchange.
    const rest = SCRIPT.slice(scriptShown.current).map((m) => ({ ...m, id: nextId.current++ }));
    if (rest.length) {
      scriptTimers.current.forEach((t) => window.clearTimeout(t));
      scriptTimers.current = [];
      scriptShown.current = SCRIPT.length;
      setTyping(null);
    }
    setMsgs((prev) => [...prev, ...rest, { id: nextId.current++, who: "You", tone: "#F4F0FF", text, you: true }]);
    const reply = REPLIES[replyIndex.current++ % REPLIES.length]!;
    const quick = prefersReducedMotion();
    window.setTimeout(() => setTyping("Maya"), quick ? 0 : 500);
    window.setTimeout(() => {
      setTyping(null);
      setMsgs((prev) => [...prev, { id: nextId.current++, who: "Maya", tone: "#FFB547", text: reply }]);
    }, quick ? 0 : 1600);
  };

  return (
    <figure className="lm2-channel" aria-label="A Lumina channel you can type into">
      <header className="lm2-channel-head">
        <Hash className="h-4 w-4" aria-hidden="true" />
        <span translate="no">general</span>
        <span className="lm2-channel-server" translate="no">
          Night Owls
        </span>
        <span className="lm2-channel-voice">
          <span className="lm2-live-dot" aria-hidden="true" />4 in voice
        </span>
      </header>
      <ol ref={listRef} className="lm2-channel-list" aria-live="polite">
        {msgs.map((m) => (
          <li key={m.id} className={`lm2-msg${m.you ? " lm2-msg-you" : ""}`}>
            <span className="lm2-avatar" style={{ background: m.tone }} aria-hidden="true">
              {m.who[0]}
            </span>
            <div className="min-w-0">
              <span className="lm2-msg-who" translate="no">
                {m.who}
              </span>
              <p className="lm2-msg-text" translate="no">
                {m.text}
              </p>
              {m.reaction && <span className="lm2-reaction">{m.reaction}</span>}
            </div>
          </li>
        ))}
        {typing && (
          <li className="lm2-typing" aria-hidden="true">
            <span translate="no">{typing}</span>is typing
            <span className="lm2-dots">
              <i />
              <i />
              <i />
            </span>
          </li>
        )}
      </ol>
      <form className="lm2-composer" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say hi to #general"
          aria-label="Type a message into the demo channel"
          maxLength={140}
        />
        <button type="submit" aria-label="Send" disabled={!draft.trim()}>
          <SendHorizontal className="h-4 w-4" />
        </button>
      </form>
      <figcaption className="lm2-channel-note">A demo channel. Type something and see what happens.</figcaption>
    </figure>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Inside Lumina — one frame, four tabs of real product footage
 * ------------------------------------------------------------------------------------------- */

const TABS = [
  {
    id: "talk",
    label: "Talk",
    title: "Servers, channels and voice rooms",
    body: "Text channels with replies, threads, polls and reactions. Voice and video rooms with screen sharing. Everything syncs across your phone and computer as it happens.",
    facts: ["Voice and video with screen sharing", "Threads, polls, custom emoji", "Bots, including existing Discord bots"],
  },
  {
    id: "watch",
    label: "Watch",
    title: "A short-video feed, built in",
    body: "A vertical For You feed lives inside the app, next to your communities. Every upload is reviewed by staff before anyone sees it.",
    facts: ["For You and Following", "Likes, comments, stitch and duet", "Recommendations you can switch off"],
  },
  {
    id: "earn",
    label: "Get paid",
    title: "Creators keep 90%",
    body: "Memberships, tips and gifts, with every cent shown in a ledger you can check. Earnings build up safely until payouts open.",
    facts: ["90% of memberships to the creator", "Tips on videos and in chat", "A share of the daily ad pool"],
  },
  {
    id: "yours",
    label: "Make it yours",
    title: "Seven complete themes",
    body: "Not just dark mode. Seven full palettes, light and dark, restyle every screen. Pick one in settings, or right here from the top corner.",
    facts: ["Nebula, Midnight, Moss, Daylight", "Carbon, Slate, Parchment", "Text size and reduced motion"],
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

function Inside() {
  const [tab, setTab] = useState<TabId>("talk");
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <section className="lm2-inside" id="inside">
      <div className="lm2-wrap">
        <h2 className="lm2-h2">Inside Lumina</h2>
        <div role="tablist" aria-label="What you can do in Lumina" className="lm2-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="inside-panel"
              className="lm2-tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id="inside-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="lm2-inside-grid">
          <div className="lm2-inside-copy">
            <h3 className="lm2-h3">{current.title}</h3>
            <p>{current.body}</p>
            <ul className="lm2-facts">
              {current.facts.map((f) => (
                <li key={f}>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
          <div className="lm2-inside-media">
            <InsideMedia tab={tab} />
          </div>
        </div>
      </div>
    </section>
  );
}

function FootageVideo({ webm, mp4, poster, label, phone = false }: { webm: string; mp4: string; poster: string; label: string; phone?: boolean }) {
  const ref = useInViewVideo();
  return (
    <div className={phone ? "lm2-phone" : "lm2-screen"}>
      <video ref={ref} muted loop playsInline preload="metadata" poster={poster} aria-label={label}>
        <source src={webm} type="video/webm" />
        <source src={mp4} type="video/mp4" />
      </video>
    </div>
  );
}

function InsideMedia({ tab }: { tab: TabId }) {
  if (tab === "talk") {
    return (
      <FootageVideo
        webm="/screens/motion/chat-desktop.webm"
        mp4="/screens/motion/chat-desktop.mp4"
        poster="/screens/app-chat.png"
        label="A Lumina server, recorded from the running app"
      />
    );
  }
  if (tab === "watch") {
    return (
      <FootageVideo
        webm="/screens/motion/feed-mobile.webm"
        mp4="/screens/motion/feed-mobile.mp4"
        poster="/screens/app-mobile-feed.png"
        label="Scrolling the For You feed on a phone"
        phone
      />
    );
  }
  if (tab === "earn") {
    return (
      <div className="lm2-screen">
        <img src="/screens/app-studio.png" alt="Creator Studio: earnings, payouts and membership tiers" loading="lazy" />
      </div>
    );
  }
  return (
    <div className="lm2-themes">
      {[
        ["/screens/app-chat.png", "Nebula"],
        ["/screens/app-chat-midnight.png", "Midnight"],
        ["/screens/app-chat-moss.png", "Moss"],
        ["/screens/app-chat-daylight.png", "Daylight"],
      ].map(([src, name]) => (
        <figure key={name}>
          <img src={src} alt={`Lumina in the ${name} theme`} loading="lazy" />
          <figcaption translate="no">{name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * The promise — the one light band on the page
 * ------------------------------------------------------------------------------------------- */

const PROMISES = [
  "Your data is never sold or used to target ads",
  "No advertising sold against your conversations",
  "No engagement algorithm you can't switch off",
  "Export or delete your account whenever you want",
];

function Promise() {
  return (
    <section className="lm2-paper">
      <div className="lm2-wrap lm2-paper-grid">
        <div>
          <h2 className="lm2-h2 lm2-ink">Run by people, not a platform.</h2>
          <p className="lm2-paper-body">
            Lumina is built and hosted by Badger Studios, a small independent studio. We earn when
            communities and creators do well, not by measuring you for advertisers.
          </p>
          <ul className="lm2-promises">
            {PROMISES.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <div className="lm2-ninety">
          <span className="lm2-ninety-num">90%</span>
          <span className="lm2-ninety-text">of every membership payment goes to the creator.</span>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Get the app
 * ------------------------------------------------------------------------------------------- */

function Apps() {
  return (
    <section className="lm2-apps" id="apps">
      <div className="lm2-wrap">
        <h2 className="lm2-h2">Get Lumina</h2>
        <p className="lm2-apps-lede">One account on every device. Conversations stay in sync as they happen.</p>
        <ul className="lm2-app-list">
          <li>
            <Smartphone className="lm2-app-icon" aria-hidden="true" />
            <div className="lm2-app-name">
              Android
              <span>From Google Play, with automatic updates and notifications.</span>
            </div>
            <div className="lm2-app-actions">
              <PlayStoreBadge />
              <a href="/api/download/android" className="lm2-textlink">
                Or download the APK
              </a>
            </div>
          </li>
          <li>
            <Monitor className="lm2-app-icon" aria-hidden="true" />
            <div className="lm2-app-name">
              Windows
              <span>An installer, or a portable version that runs without installing.</span>
            </div>
            <div className="lm2-app-actions">
              <a href="/downloads/lumina-windows-setup.exe" className="lm2-btn lm2-btn-quiet">
                Download for Windows
              </a>
              <a href="/downloads/lumina-windows.zip" className="lm2-textlink">
                Portable zip
              </a>
            </div>
          </li>
          <li>
            <Monitor className="lm2-app-icon" aria-hidden="true" />
            <div className="lm2-app-name">
              Linux
              <span>An AppImage. Make it executable and run it.</span>
            </div>
            <div className="lm2-app-actions">
              <a href="/api/download/desktop" className="lm2-btn lm2-btn-quiet">
                Download AppImage
              </a>
            </div>
          </li>
          <li>
            <Globe className="lm2-app-icon" aria-hidden="true" />
            <div className="lm2-app-name">
              Web and iPhone
              <span>Use it in any browser. On iPhone, add it to your Home Screen from Safari.</span>
            </div>
            <div className="lm2-app-actions">
              <Link to="/register" className="lm2-btn lm2-btn-quiet">
                Open in your browser
              </Link>
            </div>
          </li>
        </ul>
        <p className="lm2-fine">
          Switching from the APK to Google Play? Uninstall the APK first; the two can't update each
          other. <Link to="/install">Install help</Link>
        </p>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="lm2-closing">
      <div className="lm2-wrap">
        <h2 className="lm2-display lm2-display-sm">Bring your people.</h2>
        <p className="lm2-lede">Make a server in under a minute, then send one link to invite everyone.</p>
        <div className="lm2-cta-row">
          <Link to="/register" className="lm2-btn lm2-btn-primary">
            Create your account
          </Link>
          <Link to="/login" className="lm2-btn lm2-btn-quiet">
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
