import { FONT_SCALES, PUSH_KINDS, PUSH_KIND_LABELS, type UserPreferencesDTO } from "@lumina/shared";
import { usePreferencesStore } from "../../store/preferencesStore";
import { cn } from "../../lib/cn";

/**
 * The account-level switches that shape the app everywhere — synced through preferencesStore, so
 * a phone and a desktop agree. Each row says what changes in the words a person would use.
 */

function Row({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-signal">{label}</span>
        <span className="block text-xs leading-relaxed text-signal-dim">{description}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
    </label>
  );
}

function Heading({ children }: { children: string }) {
  return <span className="mb-1 block text-xs font-bold uppercase text-signal-dim">{children}</span>;
}

export function ChatSection() {
  const chat = usePreferencesStore((s) => s.prefs.chat);
  const update = usePreferencesStore((s) => s.update);
  const set = (patch: Partial<UserPreferencesDTO["chat"]>) => void update({ chat: patch });
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Heading>Sending</Heading>
        <Row
          label="Enter sends the message"
          description="On: Enter sends, Shift+Enter makes a new line. Off: Enter makes a new line, Ctrl+Enter (⌘+Enter on Mac) sends."
          checked={chat.sendWithEnter}
          onChange={(v) => set({ sendWithEnter: v })}
        />
      </div>
      <div>
        <Heading>What shows in the timeline</Heading>
        <Row
          label="Show images, video and audio inline"
          description="Off: every attachment is a link you open on purpose. Handy on a metered connection or in a shared space."
          checked={chat.showMedia}
          onChange={(v) => set({ showMedia: v })}
        />
        <Row
          label="Show link previews"
          description="Cards under messages that contain a link."
          checked={chat.showLinkPreviews}
          onChange={(v) => set({ showLinkPreviews: v })}
        />
        <Row
          label="Show join and leave lines"
          description="The space's announcements when someone arrives or goes."
          checked={chat.showJoinLeaveLines}
          onChange={(v) => set({ showJoinLeaveLines: v })}
        />
      </div>
      <div>
        <Heading>Time</Heading>
        <Row label="24-hour clock" description="Timestamps as 14:05 rather than 2:05 PM." checked={chat.use24hClock} onChange={(v) => set({ use24hClock: v })} />
      </div>
    </div>
  );
}

export function AccessibilitySection() {
  const a11y = usePreferencesStore((s) => s.prefs.accessibility);
  const update = usePreferencesStore((s) => s.update);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Heading>Motion</Heading>
        <Row
          label="Reduce motion"
          description="Entrances become plain fades and loops stop. Follows your device setting when off."
          checked={a11y.reducedMotion}
          onChange={(v) => void update({ accessibility: { reducedMotion: v } })}
        />
      </div>
      <div>
        <Heading>Text size</Heading>
        <p className="mb-2 text-xs text-signal-dim">Scales every piece of text in the app. Your device's own text size still applies on top.</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Text size">
          {FONT_SCALES.map((scale) => (
            <button
              key={scale}
              type="button"
              role="radio"
              aria-checked={a11y.fontScale === scale}
              onClick={() => void update({ accessibility: { fontScale: scale } })}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-sm",
                a11y.fontScale === scale ? "border-accent bg-accent/15 text-signal" : "border-hairline text-signal-dim hover:text-signal",
              )}
            >
              {scale}%
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-signal" style={{ fontSize: `${a11y.fontScale}%` }}>
          The quick brown fox jumps over the lazy dog.
        </p>
      </div>
    </div>
  );
}

/** Which kinds of push may ring at all. Sits inside the Notifications section under the push switch. */
export function PushKindToggles() {
  const push = usePreferencesStore((s) => s.prefs.notifications.push);
  const update = usePreferencesStore((s) => s.update);
  return (
    <div className="mt-6">
      <Heading>What may send a push</Heading>
      <p className="mb-1 text-xs text-signal-dim">Each kind has its own tone, set on your phone. Turned off here, it stays silent on every device.</p>
      {PUSH_KINDS.map((kind) => (
        <Row
          key={kind}
          label={PUSH_KIND_LABELS[kind]}
          description={PUSH_KIND_DESCRIPTIONS[kind]}
          checked={push[kind]}
          onChange={(v) => void update({ notifications: { push: { [kind]: v } } })}
        />
      ))}
    </div>
  );
}

const PUSH_KIND_DESCRIPTIONS: Record<(typeof PUSH_KINDS)[number], string> = {
  message: "New messages in rooms you follow.",
  direct: "Direct messages and group chats.",
  mention: "Someone mentions you by name.",
  channel: "@everyone and @here in a room.",
};
