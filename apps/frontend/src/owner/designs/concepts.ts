/**
 * UI redesign concepts.
 *
 * Each concept is a complete design system — palette, shape, density, typography — not a colour
 * swap. They are rendered as working mock app shells in DesignLab.tsx rather than as flat images,
 * so what you're judging is the real layout at a real size, and the winner can be adopted by
 * lifting its tokens rather than reinterpreting a picture.
 *
 * These are deliberately different from each other in STRUCTURE, not just paint: the point of the
 * exercise is deciding how the app should be organised, and three variations on the same three-column
 * Discord layout would not answer that.
 */

export interface DesignConcept {
  key: string;
  name: string;
  tagline: string;
  /** The structural argument this concept is making, in plain language. */
  rationale: string;
  /** What you give up by choosing it. Every design trades something away. */
  tradeoff: string;
  layout: "three-column" | "unified-rail" | "workspace";
  tokens: {
    bg: string;
    surface: string;
    surfaceAlt: string;
    line: string;
    text: string;
    textDim: string;
    textFaint: string;
    accent: string;
    accent2: string;
    good: string;
    warn: string;
    bad: string;
    radius: string;
    radiusLg: string;
    /** Vertical rhythm for list rows — the single biggest lever on how dense the app feels. */
    rowPadding: string;
    fontDisplay: string;
    fontBody: string;
    shadow: string;
  };
}

export const CONCEPTS: DesignConcept[] = [
  {
    key: "aurora",
    name: "Aurora",
    tagline: "Soft, spacious, unmistakably ours",
    rationale:
      "Keeps the familiar three-column shape but replaces Discord's flat grey slabs with layered translucent surfaces, a violet-to-cyan accent, and much more breathing room. Channels and members become soft pills rather than dense rows. The bet: people already know where things are, so change how it feels rather than where it lives.",
    tradeoff:
      "Roughly 20% fewer channels and messages visible per screen. On a laptop that costs you a scroll; on a phone it costs more.",
    layout: "three-column",
    tokens: {
      bg: "#0a0714",
      surface: "#150f26",
      surfaceAlt: "#1e1636",
      line: "#2e2350",
      text: "#f2eefc",
      textDim: "#b3a8d4",
      textFaint: "#7a6fa0",
      accent: "#8b5cf6",
      accent2: "#22d3ee",
      good: "#34d399",
      warn: "#fbbf24",
      bad: "#fb7185",
      radius: "12px",
      radiusLg: "20px",
      rowPadding: "10px 12px",
      fontDisplay: '"Unbounded", system-ui, sans-serif',
      fontBody: '"Hanken Grotesk", system-ui, sans-serif',
      shadow: "0 8px 32px -8px rgba(0,0,0,0.6)",
    },
  },
  {
    key: "console",
    name: "Console",
    tagline: "Dense, fast, built for people who live here",
    rationale:
      "Collapses the server rail and channel list into one navigation column, freeing a whole column of width for content. Sharp corners, tight rows, monospace for anything machine-generated. Roughly 40% more messages on screen than today. The bet: your heaviest users are in this app all day and want throughput, not comfort.",
    tradeoff:
      "Genuinely less friendly to a first-time user, and the merged navigation means switching servers and switching channels stop being visually distinct actions.",
    layout: "unified-rail",
    tokens: {
      bg: "#08090c",
      surface: "#0e1014",
      surfaceAlt: "#151920",
      line: "#22272f",
      text: "#e6edf3",
      textDim: "#9aa4b2",
      textFaint: "#5f6b7a",
      accent: "#3b82f6",
      accent2: "#10b981",
      good: "#10b981",
      warn: "#f59e0b",
      bad: "#ef4444",
      radius: "4px",
      radiusLg: "6px",
      rowPadding: "4px 8px",
      fontDisplay: '"IBM Plex Mono", ui-monospace, monospace',
      fontBody: '"Inter", system-ui, sans-serif',
      shadow: "none",
    },
  },
  {
    key: "atlas",
    name: "Atlas",
    tagline: "Workspace-first, light by default",
    rationale:
      "Abandons the chat-app shape for a workspace one: a slim icon rail, a contextual sidebar that changes with what you're doing, and a content area that hosts chat, the video feed, or a document equally well. Light theme leads. The bet: you're not building a chat app — you're building a platform where chat is one surface among several, and the layout should stop implying otherwise.",
    tradeoff:
      "The biggest departure and the most work: nearly every screen needs rethinking, and existing users lose the muscle memory they carried over from Discord.",
    layout: "workspace",
    tokens: {
      bg: "#f7f7fb",
      surface: "#ffffff",
      surfaceAlt: "#f0f0f7",
      line: "#e2e2ee",
      text: "#16141f",
      textDim: "#57536b",
      textFaint: "#8b87a3",
      accent: "#5b4bf5",
      accent2: "#f59e0b",
      good: "#059669",
      warn: "#d97706",
      bad: "#dc2626",
      radius: "10px",
      radiusLg: "16px",
      rowPadding: "8px 12px",
      fontDisplay: '"Unbounded", system-ui, sans-serif',
      fontBody: '"Hanken Grotesk", system-ui, sans-serif',
      shadow: "0 1px 3px rgba(20,18,35,0.08), 0 8px 24px -12px rgba(20,18,35,0.12)",
    },
  },
];

export function conceptStyle(c: DesignConcept): React.CSSProperties {
  const t = c.tokens;
  return {
    // Exposed as custom properties so the mock's markup can be one shared component across all
    // three concepts — the difference between them is entirely in these values, which is also the
    // proof that adopting a concept means adopting its tokens, not rewriting the app.
    ["--d-bg" as string]: t.bg,
    ["--d-surface" as string]: t.surface,
    ["--d-surface-alt" as string]: t.surfaceAlt,
    ["--d-line" as string]: t.line,
    ["--d-text" as string]: t.text,
    ["--d-text-dim" as string]: t.textDim,
    ["--d-text-faint" as string]: t.textFaint,
    ["--d-accent" as string]: t.accent,
    ["--d-accent-2" as string]: t.accent2,
    ["--d-good" as string]: t.good,
    ["--d-warn" as string]: t.warn,
    ["--d-bad" as string]: t.bad,
    ["--d-radius" as string]: t.radius,
    ["--d-radius-lg" as string]: t.radiusLg,
    ["--d-row-pad" as string]: t.rowPadding,
    ["--d-font-display" as string]: t.fontDisplay,
    ["--d-font-body" as string]: t.fontBody,
    ["--d-shadow" as string]: t.shadow,
  };
}
