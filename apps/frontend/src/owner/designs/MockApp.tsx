import { Hash, Volume2, Search, Plus, Send, Bell, Clapperboard, MessageSquare, Users, Home, Settings } from "lucide-react";
import type { DesignConcept } from "./concepts";
import { conceptStyle } from "./concepts";

/**
 * A working mock of the real app, rendered in a given concept's tokens.
 *
 * One markup tree serves all three concepts — everything that differs between them lives in CSS
 * custom properties, apart from the layout switch below. That is the honest way to preview a design
 * system: if a concept can't be expressed as tokens over this markup, it isn't a theme, it's a
 * rewrite, and you should know that before choosing it.
 *
 * Content is fixed sample data rather than live, so the three previews are directly comparable and
 * a quiet afternoon in the real app doesn't make a design look empty.
 */

const CHANNELS = [
  { name: "announcements", type: "text", unread: 0 },
  { name: "general", type: "text", unread: 12, active: true },
  { name: "design", type: "text", unread: 3 },
  { name: "engineering", type: "text", unread: 0 },
  { name: "Lounge", type: "voice", unread: 0 },
];

const MESSAGES = [
  { author: "Mira", initials: "MI", time: "14:02", text: "Pushed the new upload flow — worth a look before we ship.", color: "#8b5cf6" },
  { author: "Dev", initials: "DE", time: "14:04", text: "Nice. Does it handle the 100MB case?", color: "#22d3ee" },
  { author: "Mira", initials: "MI", time: "14:05", text: "Streams straight to disk now, so memory stays flat regardless of size.", color: "#8b5cf6" },
  { author: "Sam", initials: "SA", time: "14:11", text: "Feed's looking good on mobile too.", color: "#34d399" },
];

const MEMBERS = [
  { name: "Mira", initials: "MI", status: "#34d399", color: "#8b5cf6" },
  { name: "Dev", initials: "DE", status: "#34d399", color: "#22d3ee" },
  { name: "Sam", initials: "SA", status: "#fbbf24", color: "#34d399" },
  { name: "Alex", initials: "AL", status: "#6b7280", color: "#fb7185" },
];

export function MockApp({ concept, compact = false }: { concept: DesignConcept; compact?: boolean }) {
  return (
    <div
      style={{
        ...conceptStyle(concept),
        background: "var(--d-bg)",
        color: "var(--d-text)",
        fontFamily: "var(--d-font-body)",
      }}
      className="flex h-full w-full overflow-hidden text-sm"
    >
      {concept.layout === "three-column" && <ThreeColumn compact={compact} />}
      {concept.layout === "unified-rail" && <UnifiedRail compact={compact} />}
      {concept.layout === "workspace" && <Workspace compact={compact} />}
    </div>
  );
}

/* ---------------- shared pieces ---------------- */

function Avatar({ initials, color, size = 32 }: { initials: string; color: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
    >
      {initials}
    </span>
  );
}

function MessageList({ dense }: { dense?: boolean }) {
  return (
    <div className="flex-1 space-y-3 overflow-hidden p-4" style={{ gap: dense ? 4 : undefined }}>
      {MESSAGES.map((m, i) => (
        <div key={i} className={dense ? "flex gap-2" : "flex gap-3"}>
          <Avatar initials={m.initials} color={m.color} size={dense ? 22 : 34} />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold" style={{ fontSize: dense ? 12 : 14 }}>
                {m.author}
              </span>
              <span style={{ color: "var(--d-text-faint)", fontSize: dense ? 10 : 11 }}>{m.time}</span>
            </div>
            <p style={{ color: "var(--d-text-dim)", fontSize: dense ? 12 : 14, lineHeight: dense ? 1.35 : 1.5 }}>
              {m.text}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Composer() {
  return (
    <div className="p-3">
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{
          background: "var(--d-surface-alt)",
          borderRadius: "var(--d-radius-lg)",
          border: "1px solid var(--d-line)",
        }}
      >
        <Plus className="h-4 w-4" style={{ color: "var(--d-text-faint)" }} />
        <span className="flex-1" style={{ color: "var(--d-text-faint)" }}>
          Message #general
        </span>
        <Send className="h-4 w-4" style={{ color: "var(--d-accent)" }} />
      </div>
    </div>
  );
}

function ChannelRow({ ch, dense }: { ch: (typeof CHANNELS)[number]; dense?: boolean }) {
  const active = "active" in ch && ch.active;
  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: "var(--d-row-pad)",
        borderRadius: "var(--d-radius)",
        background: active ? "var(--d-surface-alt)" : "transparent",
        color: active ? "var(--d-text)" : "var(--d-text-dim)",
        fontWeight: active ? 600 : 400,
        fontSize: dense ? 12 : 14,
      }}
    >
      {ch.type === "voice" ? <Volume2 className="h-3.5 w-3.5 shrink-0" /> : <Hash className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{ch.name}</span>
      {ch.unread > 0 && (
        <span
          className="rounded-full px-1.5 text-[10px] font-bold text-white"
          style={{ background: "var(--d-bad)" }}
        >
          {ch.unread}
        </span>
      )}
    </div>
  );
}

/* ---------------- layout: three column (Aurora) ---------------- */

function ThreeColumn({ compact }: { compact?: boolean }) {
  return (
    <>
      <nav
        className="flex w-[68px] shrink-0 flex-col items-center gap-2 py-3"
        style={{ background: "var(--d-surface)" }}
      >
        {["LU", "DS", "AR"].map((s, i) => (
          <span
            key={s}
            className="flex h-11 w-11 items-center justify-center text-xs font-bold text-white"
            style={{
              borderRadius: i === 0 ? "var(--d-radius-lg)" : "999px",
              background: i === 0 ? "linear-gradient(135deg,var(--d-accent),var(--d-accent-2))" : "var(--d-surface-alt)",
              color: i === 0 ? "#fff" : "var(--d-text-dim)",
            }}
          >
            {s}
          </span>
        ))}
        <span className="mt-1 h-px w-7" style={{ background: "var(--d-line)" }} />
        <span
          className="flex h-11 w-11 items-center justify-center"
          style={{ borderRadius: "999px", background: "var(--d-surface-alt)", color: "var(--d-accent-2)" }}
        >
          <Clapperboard className="h-5 w-5" />
        </span>
      </nav>

      <aside className="flex w-56 shrink-0 flex-col" style={{ background: "var(--d-surface)" }}>
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--d-line)" }}>
          <p className="font-semibold" style={{ fontFamily: "var(--d-font-display)" }}>
            Lumina HQ
          </p>
        </div>
        <div className="flex-1 space-y-0.5 p-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--d-text-faint)" }}>
            Text
          </p>
          {CHANNELS.map((c) => (
            <ChannelRow key={c.name} ch={c} />
          ))}
        </div>
        <div className="flex items-center gap-2 p-2" style={{ borderTop: "1px solid var(--d-line)" }}>
          <Avatar initials="LB" color="var(--d-accent)" size={28} />
          <span className="min-w-0 flex-1 truncate text-xs">Lucidbadger1</span>
          <Settings className="h-4 w-4" style={{ color: "var(--d-text-faint)" }} />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: "1px solid var(--d-line)" }}
        >
          <Hash className="h-4 w-4" style={{ color: "var(--d-text-faint)" }} />
          <span className="font-semibold">general</span>
          <span className="ml-auto flex items-center gap-3" style={{ color: "var(--d-text-faint)" }}>
            <Bell className="h-4 w-4" />
            <Search className="h-4 w-4" />
          </span>
        </header>
        <MessageList />
        <Composer />
      </main>

      {!compact && (
        <aside className="w-48 shrink-0 p-3" style={{ background: "var(--d-surface)" }}>
          <p className="pb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--d-text-faint)" }}>
            Online — 3
          </p>
          <div className="space-y-1">
            {MEMBERS.map((m) => (
              <div key={m.name} className="flex items-center gap-2" style={{ padding: "var(--d-row-pad)" }}>
                <span className="relative">
                  <Avatar initials={m.initials} color={m.color} size={26} />
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full"
                    style={{ background: m.status, border: "2px solid var(--d-surface)" }}
                  />
                </span>
                <span className="truncate text-xs" style={{ color: "var(--d-text-dim)" }}>
                  {m.name}
                </span>
              </div>
            ))}
          </div>
        </aside>
      )}
    </>
  );
}

/* ---------------- layout: unified rail (Console) ---------------- */

function UnifiedRail({ compact }: { compact?: boolean }) {
  return (
    <>
      <aside className="flex w-60 shrink-0 flex-col" style={{ background: "var(--d-surface)", borderRight: "1px solid var(--d-line)" }}>
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--d-line)" }}>
          <Search className="h-3.5 w-3.5" style={{ color: "var(--d-text-faint)" }} />
          <span className="text-xs" style={{ color: "var(--d-text-faint)", fontFamily: "var(--d-font-display)" }}>
            jump to…
          </span>
          <span className="ml-auto text-[10px]" style={{ color: "var(--d-text-faint)" }}>
            ⌘K
          </span>
        </div>

        {/* Servers and channels in one tree — the whole point of this concept is reclaiming the
            width a separate icon rail costs. */}
        <div className="flex-1 overflow-hidden py-1">
          {["LUMINA HQ", "DESIGN", "ARCHIVE"].map((server, si) => (
            <div key={server} className="mb-1">
              <p
                className="px-3 py-1 text-[10px] font-semibold tracking-wider"
                style={{ color: "var(--d-text-faint)", fontFamily: "var(--d-font-display)" }}
              >
                {server}
              </p>
              {(si === 0 ? CHANNELS : CHANNELS.slice(0, 2)).map((c) => (
                <div key={`${server}-${c.name}`} className="px-1">
                  <ChannelRow ch={si === 0 ? c : { ...c, active: false }} dense />
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--d-line)" }}>
          <Avatar initials="LB" color="var(--d-accent)" size={22} />
          <span className="min-w-0 flex-1 truncate text-xs">Lucidbadger1</span>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-2 px-3 py-1.5"
          style={{ borderBottom: "1px solid var(--d-line)", fontFamily: "var(--d-font-display)" }}
        >
          <span className="text-xs" style={{ color: "var(--d-text-faint)" }}>
            lumina-hq /
          </span>
          <span className="text-xs font-semibold">#general</span>
          <span className="ml-auto text-[10px]" style={{ color: "var(--d-text-faint)" }}>
            4 online · 12 unread
          </span>
        </header>
        <MessageList dense />
        <Composer />
      </main>

      {!compact && (
        <aside className="w-44 shrink-0 p-2" style={{ background: "var(--d-surface)", borderLeft: "1px solid var(--d-line)" }}>
          <p className="px-1 pb-1 text-[10px] font-semibold tracking-wider" style={{ color: "var(--d-text-faint)", fontFamily: "var(--d-font-display)" }}>
            MEMBERS
          </p>
          {MEMBERS.map((m) => (
            <div key={m.name} className="flex items-center gap-2" style={{ padding: "var(--d-row-pad)" }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.status }} />
              <span className="truncate text-xs" style={{ color: "var(--d-text-dim)" }}>
                {m.name}
              </span>
            </div>
          ))}
        </aside>
      )}
    </>
  );
}

/* ---------------- layout: workspace (Atlas) ---------------- */

function Workspace({ compact }: { compact?: boolean }) {
  const railItems = [
    { icon: Home, label: "Home", active: false },
    { icon: MessageSquare, label: "Chat", active: true },
    { icon: Clapperboard, label: "Feed", active: false },
    { icon: Users, label: "People", active: false },
  ];

  return (
    <>
      <nav
        className="flex w-16 shrink-0 flex-col items-center gap-1 py-3"
        style={{ background: "var(--d-surface)", borderRight: "1px solid var(--d-line)" }}
      >
        <span
          className="mb-2 flex h-9 w-9 items-center justify-center text-xs font-bold text-white"
          style={{ borderRadius: "var(--d-radius)", background: "var(--d-accent)" }}
        >
          LU
        </span>
        {railItems.map(({ icon: Icon, label, active }) => (
          <span
            key={label}
            className="flex w-full flex-col items-center gap-0.5 py-1.5"
            style={{ color: active ? "var(--d-accent)" : "var(--d-text-faint)" }}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[9px] font-medium">{label}</span>
          </span>
        ))}
      </nav>

      <aside className="flex w-60 shrink-0 flex-col" style={{ background: "var(--d-surface)", borderRight: "1px solid var(--d-line)" }}>
        <div className="p-3">
          <div
            className="flex items-center gap-2 px-2.5 py-1.5"
            style={{ background: "var(--d-surface-alt)", borderRadius: "var(--d-radius)" }}
          >
            <Search className="h-3.5 w-3.5" style={{ color: "var(--d-text-faint)" }} />
            <span className="text-xs" style={{ color: "var(--d-text-faint)" }}>
              Search everything
            </span>
          </div>
        </div>
        <div className="flex-1 space-y-0.5 px-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--d-text-faint)" }}>
            Lumina HQ
          </p>
          {CHANNELS.map((c) => (
            <ChannelRow key={c.name} ch={c} />
          ))}
        </div>
        <div className="flex items-center gap-2 p-3" style={{ borderTop: "1px solid var(--d-line)" }}>
          <Avatar initials="LB" color="var(--d-accent)" size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">Lucidbadger1</span>
            <span className="block truncate text-[10px]" style={{ color: "var(--d-text-faint)" }}>
              Master
            </span>
          </span>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--d-bg)" }}>
        <header className="flex items-center gap-2 px-5 py-4">
          <span>
            <span className="block text-lg font-semibold" style={{ fontFamily: "var(--d-font-display)" }}>
              general
            </span>
            <span className="block text-xs" style={{ color: "var(--d-text-faint)" }}>
              4 members · Lumina HQ
            </span>
          </span>
        </header>
        <div
          className="mx-4 mb-4 flex flex-1 flex-col overflow-hidden"
          style={{
            background: "var(--d-surface)",
            borderRadius: "var(--d-radius-lg)",
            border: "1px solid var(--d-line)",
            boxShadow: "var(--d-shadow)",
          }}
        >
          <MessageList />
          <Composer />
        </div>
      </main>

      {!compact && (
        <aside className="w-52 shrink-0 p-4" style={{ background: "var(--d-surface)", borderLeft: "1px solid var(--d-line)" }}>
          <p className="pb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--d-text-faint)" }}>
            In this channel
          </p>
          <div className="space-y-2">
            {MEMBERS.map((m) => (
              <div key={m.name} className="flex items-center gap-2">
                <Avatar initials={m.initials} color={m.color} size={28} />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{m.name}</span>
                  <span className="block text-[10px]" style={{ color: "var(--d-text-faint)" }}>
                    {m.status === "#34d399" ? "Online" : m.status === "#fbbf24" ? "Away" : "Offline"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </aside>
      )}
    </>
  );
}
