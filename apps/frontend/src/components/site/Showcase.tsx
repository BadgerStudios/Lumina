import type { ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * Presentation primitives for the marketing site's screenshot showcases. These wrap REAL,
 * current-UI screenshots (public/screens/app-*.png, captured from the running app against seeded
 * demo content — never a real user's data) in browser/phone chrome so they read as product, not
 * as loose images floating on the page.
 */

/** A macOS-style browser window around a screenshot. `glow` adds an accent halo behind it. */
export function BrowserFrame({
  src,
  alt,
  url = "lumina.badgerstudios.net",
  className = "",
  glow = false,
}: {
  src: string;
  alt: string;
  url?: string;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      {glow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] opacity-60 blur-3xl"
          style={{ background: "radial-gradient(closest-side, color-mix(in srgb, var(--accent) 40%, transparent), transparent)" }}
        />
      )}
      <div className="overflow-hidden rounded-xl border border-hairline bg-base-800 shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-hairline bg-base-700 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-flare" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber" />
          <span className="h-2.5 w-2.5 rounded-full bg-pulse" />
          <span className="ml-3 truncate font-mono text-[11px] text-signal-faint">{url}</span>
        </div>
        <img src={src} alt={alt} loading="lazy" className="block w-full" />
      </div>
    </div>
  );
}

/** A phone bezel around a mobile screenshot. No notch overlay — the captured screenshots already
 * include the app's own top bar, and a faux notch drawn over it just clipped the real header and
 * read as a rendering glitch. The rounded bezel alone reads as a phone. */
export function PhoneFrame({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[2.2rem] border-[7px] border-base-600 bg-base-900 shadow-2xl ${className}`}>
      <img src={src} alt={alt} loading="lazy" className="block w-full rounded-[1.5rem]" />
    </div>
  );
}

/** An alternating feature row: copy + checklist on one side, a framed screenshot on the other. */
export function ShowcaseRow({
  eyebrow,
  title,
  body,
  points,
  children,
  reverse = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  points?: string[];
  children: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 lg:grid-cols-2 lg:gap-16">
      <div className={reverse ? "lg:order-2" : ""}>
        <p className="font-mono text-xs uppercase tracking-widest text-accent">{eyebrow}</p>
        <h3 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-signal sm:text-4xl">{title}</h3>
        <p className="mt-4 text-base leading-relaxed text-signal-dim">{body}</p>
        {points && (
          <ul className="mt-6 space-y-3">
            {points.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                  <Check className="h-3.5 w-3.5" />
                </span>
                <span className="text-sm text-signal-dim">{p}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={reverse ? "lg:order-1" : ""}>{children}</div>
    </div>
  );
}
