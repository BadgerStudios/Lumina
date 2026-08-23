import { useState } from "react";
import { Link } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { SiteThemeMenu } from "../SiteThemeMenu";

/**
 * Shared chrome for the public marketing surfaces (landing + features), so the header — brand,
 * nav links, theme picker, and the Sign in / Get started buttons — is defined once and identical
 * on every page a logged-out visitor sees, rather than diverging per route as it did before.
 *
 * The brand mark is the real logo asset (/icons/logo-128.png), the same one every auth and invite
 * screen already uses — not a per-page redrawn glyph.
 */

export function SiteMark({ className = "h-8 w-8" }: { className?: string }) {
  return <img src="/icons/logo-128.png" alt="" aria-hidden="true" className={`${className} rounded-xl`} />;
}

const NAV_LINKS: Array<{ label: string; to: string; hash?: boolean }> = [
  { label: "Features", to: "/features" },
  { label: "Apps", to: "/#apps" },
  { label: "Developers", to: "/developers" },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 border-b border-hairline/70 bg-base-900/70 backdrop-blur-xl">
      <nav className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
        <Link to="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <SiteMark />
          <span className="font-display text-lg font-bold tracking-tight text-signal">Lumina</span>
        </Link>

        <div className="ml-4 hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.label}
              to={l.to}
              className="rounded-full px-3 py-1.5 text-sm text-signal-dim transition hover:bg-base-800 hover:text-signal"
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <SiteThemeMenu />
          {/* The login button, top-right, always visible — even on the narrowest screens, since
              signing in is the one thing a returning visitor came to do. */}
          <Link
            to="/login"
            className="rounded-full border border-hairline bg-base-800/60 px-4 py-1.5 text-sm font-medium text-signal transition hover:border-accent hover:bg-base-800"
          >
            Sign in
          </Link>
          <Link
            to="/register"
            className="hidden rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-accent/20 transition hover:bg-accent-hover sm:block"
          >
            Get started
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Menu"
            className="rounded-full border border-hairline bg-base-800/60 p-2 text-signal-dim transition hover:text-signal md:hidden"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-hairline/70 bg-base-900/95 px-5 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-signal-dim transition hover:bg-base-800 hover:text-signal"
              >
                {l.label}
              </Link>
            ))}
            <Link
              to="/register"
              onClick={() => setOpen(false)}
              className="mt-1 rounded-lg bg-accent px-3 py-2 text-center text-sm font-medium text-white"
            >
              Get started
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

const FOOTER_COLS: Array<{ heading: string; links: Array<{ label: string; to: string; external?: boolean }> }> = [
  {
    heading: "Product",
    links: [
      { label: "Features", to: "/features" },
      { label: "For You feed", to: "/register" },
      { label: "Developers", to: "/developers" },
    ],
  },
  {
    heading: "Apps",
    links: [
      { label: "Android", to: "/downloads/lumina.apk", external: true },
      { label: "Windows", to: "/downloads/lumina-windows.zip", external: true },
      { label: "Linux desktop", to: "/downloads/lumina-desktop.AppImage", external: true },
      { label: "Install guide", to: "/install" },
    ],
  },
  {
    heading: "Account",
    links: [
      { label: "Sign in", to: "/login" },
      { label: "Create account", to: "/register" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", to: "/privacy" },
      { label: "Terms", to: "/terms" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-base-900">
      <div className="mx-auto max-w-6xl px-5 py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-1">
            <div className="flex items-center gap-2.5">
              <SiteMark />
              <span className="font-display text-base font-bold text-signal">Lumina</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-signal-faint">
              A community platform for chat, voice, video and a short-video feed — hosted and run
              by Badger Studios.
            </p>
          </div>
          {FOOTER_COLS.map((col) => (
            <div key={col.heading}>
              <h4 className="text-xs font-bold uppercase tracking-widest text-signal-faint">{col.heading}</h4>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) =>
                  l.external ? (
                    <li key={l.label}>
                      <a href={l.to} className="text-sm text-signal-dim transition hover:text-signal">
                        {l.label}
                      </a>
                    </li>
                  ) : (
                    <li key={l.label}>
                      <Link to={l.to} className="text-sm text-signal-dim transition hover:text-signal">
                        {l.label}
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-hairline pt-6 sm:flex-row">
          <p className="text-xs text-signal-faint">
            © {new Date().getFullYear()} Lumina. The flame mascot and design are property of Badger Studios LLC. All rights reserved.
          </p>
          <p className="text-xs text-signal-faint">Built for people, not a platform.</p>
        </div>
      </div>
    </footer>
  );
}
