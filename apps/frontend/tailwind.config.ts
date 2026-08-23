import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/**
 * A CSS-variable colour that still supports Tailwind's `/opacity` modifier.
 *
 * Declaring these as the bare string "var(--x)" silently breaks every `bg-base-900/80`-style
 * class: Tailwind can only inject an alpha into a colour it can parse, so with an opaque
 * `var()` it emits nothing at all and the utility vanishes. 37 such classes existed across the
 * app — translucent overlays, sticky headers and tinted status pills — all rendering with no
 * background whatsoever. color-mix keeps one source of truth per colour (the theme variable)
 * while giving Tailwind something it can apply an alpha to.
 */
const themed =
  (name: string) =>
  ({ opacityValue }: { opacityValue?: string }) => {
    if (opacityValue === undefined) return `var(--${name})`;
    // opacityValue is NOT always a number. For a utility with no `/opacity` modifier Tailwind
    // still calls this, passing the literal string "var(--tw-bg-opacity)" — so `Number(...) * 100`
    // yields NaN, the declaration is invalid, and the colour disappears entirely. calc() defers
    // the arithmetic to the browser and is correct for both a numeric literal and a CSS variable.
    return `color-mix(in srgb, var(--${name}) calc(${opacityValue} * 100%), transparent)`;
  };

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    /**
     * `md` is the layout breakpoint — it is what decides between the three-column desktop shell and
     * the single-column mobile one, across ~60 usages in nine layout components.
     *
     * It used to be width-only, and that is wrong for a phone in landscape. An iPhone rotated to
     * landscape is 844×390: wider than 768, so it crossed the breakpoint and got the full desktop
     * layout — server rail, channel sidebar, header, message list, composer and member list — in
     * 390px of height. Less vertical room than the same phone has in portrait, spent on more
     * chrome.
     *
     * Requiring BOTH dimensions fixes every one of those usages at once, without editing them.
     * 500px separates cleanly: the tallest phone in landscape is around 430px (iPhone Pro Max), the
     * shortest tablet in landscape is around 768px (iPad mini), and a laptop is 700px+.
     *
     * `sm` and `lg` stay width-only on purpose — they tune padding and type scale, where height is
     * irrelevant.
     */
    screens: {
      sm: "640px",
      md: { raw: "(min-width: 768px) and (min-height: 500px)" },
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    extend: {
      colors: {
        // Semantic names kept identical to the pre-redesign palette so every existing
        // component class (bg-base-900, text-accent, etc.) keeps working unchanged — only
        // the values now come from CSS custom properties (see src/index.css :root /
        // :root[data-theme] blocks), which is what actually re-themes the whole app.
        base: {
          950: themed("base-950"),
          900: themed("base-900"),
          800: themed("base-800"),
          700: themed("base-700"),
          600: themed("base-600"),
          500: themed("base-500"),
          400: themed("base-400"),
        },
        accent: {
          DEFAULT: themed("accent"),
          hover: themed("accent-hover"),
        },
        // Theme-aware text tiers (near-black-on-light / near-white-on-dark, see index.css) —
        // use these instead of Tailwind's literal text-white/text-gray-*, which don't flip
        // with the theme and go invisible in light mode against the light `base-*` surfaces.
        signal: {
          DEFAULT: themed("signal"),
          dim: themed("signal-dim"),
          faint: themed("signal-faint"),
        },
        online: themed("online"),
        idle: themed("idle"),
        dnd: themed("dnd"),
        offline: themed("offline"),
        // These four were used in 186 places across 21 files and defined in index.css as CSS
        // variables, but never declared here — so Tailwind generated nothing for
        // `border-hairline`, `text-amber`, `text-pulse` or `text-flare` and every one of them
        // was silently inert. Borders fell back to currentColor (inheriting the text colour
        // instead of a faint rule) and the status colours rendered as plain body text.
        hairline: themed("hairline"),
        amber: themed("amber"),
        pulse: themed("pulse"),
        flare: themed("flare"),
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      /**
       * `max-md:` — the exact complement of the `md` query above.
       *
       * Tailwind only generates `max-*` variants automatically for min-width screens; a `raw`
       * screen gets none, so the ten existing `max-md:` usages would have silently produced no CSS
       * at all. Declaring it by hand keeps `md:` and `max-md:` true opposites, which is what every
       * call site already assumes.
       */
      addVariant("max-md", "@media (max-width: 767.98px), (max-height: 499.98px)");

      /** Height-only escapes, for the cases where a layout needs to shed vertical chrome. */
      addVariant("short", "@media (max-height: 499.98px)");
      addVariant("tall", "@media (min-height: 900px)");
    }),
  ],
} satisfies Config;
