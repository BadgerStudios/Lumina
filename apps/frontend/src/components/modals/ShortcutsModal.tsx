import { useEffect, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import type { Keybinds } from "../../store/uiStore";

/**
 * Keyboard-shortcuts cheat sheet.
 *
 * The app grew a handful of real shortcuts — the command palette, the voice keybinds
 * (UserSettingsModal.tsx's Voice & Video section, checked in AppShell.tsx), and the composer's
 * send/newline/cancel keys — but nowhere listed them, so they were discoverable only by accident.
 * This is that list.
 *
 * The way in is `?` (Shift+/), registered here rather than in AppShell for the same reason
 * CommandPalette owns Ctrl/Cmd-K: the component that owns the state owns the way in. It opens
 * through the shared modal system (uiStore `openModal`), so it stacks and dismisses like every
 * other modal. It can also be opened from anywhere with `openModalWith("shortcuts")`.
 */

/** Same mapping as UserSettingsModal.tsx's KeybindRow, kept local — a keyboard `code` like "KeyM"
 * or "ControlLeft" is not what anyone calls the key. */
function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const named: Record<string, string> = {
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    Space: "Space",
    Backquote: "`",
  };
  return named[code] ?? code;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-row border border-hairline bg-base-800 px-1.5 py-0.5 font-mono text-micro font-semibold text-signal-dim">
      {children}
    </kbd>
  );
}

/** One row: the human description on the left, the key(s) on the right. `keys` is a list of chords;
 * chords are joined with "then", and within a chord the parts are joined with "+". */
function Row({ label, keys }: { label: string; keys: string[][] }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0 text-sm text-signal-dim">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {keys.map((chord, ci) => (
          <span key={ci} className="flex items-center gap-1">
            {ci > 0 ? <span className="px-0.5 text-micro text-signal-faint">or</span> : null}
            {chord.map((k, ki) => (
              <span key={ki} className="flex items-center gap-1">
                {ki > 0 ? <span className="text-signal-faint">+</span> : null}
                <Kbd>{k}</Kbd>
              </span>
            ))}
          </span>
        ))}
      </span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="lx-eyebrow mb-1 text-signal-faint">{title}</div>
      <div className="divide-y divide-hairline">{children}</div>
    </div>
  );
}

export function ShortcutsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const closeModal = useUIStore((s) => s.closeModal);
  const keybinds = useUIStore((s) => s.keybinds) as Keybinds;
  const open = openModal === "shortcuts";

  // Global `?` shortcut, mirroring CommandPalette's ownership of Ctrl/Cmd-K. Ignored while typing
  // in a field (a "?" belongs in the message, not here), and only fires when nothing else is
  // stacked over it, so it never steals the key from another open modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      const current = useUIStore.getState().openModal;
      if (current === "shortcuts") {
        e.preventDefault();
        useUIStore.getState().closeModal();
      } else if (current === null) {
        e.preventDefault();
        useUIStore.getState().openModalWith("shortcuts");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Modal open={open} onOpenChange={(o) => (o ? openModalWith("shortcuts") : closeModal())} title="Keyboard shortcuts" width="max-w-md">
      <div className="flex flex-col gap-5">
        <Group title="Navigation">
          <Row label="Jump to anything" keys={[[MOD, "K"]]} />
          <Row label="Show this cheat sheet" keys={[["?"]]} />
        </Group>

        <Group title="Voice">
          <Row label="Toggle mute" keys={[[keyLabel(keybinds.toggleMute)]]} />
          <Row label="Toggle deafen" keys={[[keyLabel(keybinds.toggleDeafen)]]} />
          <Row label="Push to talk (hold)" keys={[[keyLabel(keybinds.pushToTalk)]]} />
        </Group>
        <p className="-mt-3 text-micro text-signal-faint">
          Voice keys work while you&apos;re in a voice channel. Rebind them under Settings &rarr; Voice &amp; Video.
        </p>

        <Group title="Messages">
          <Row label="Send message" keys={[["Enter"]]} />
          <Row label="New line" keys={[["Shift", "Enter"]]} />
          <Row label="Save / cancel an edit" keys={[["Enter"], ["Esc"]]} />
          <Row label="Complete a slash command" keys={[["Tab"]]} />
        </Group>
      </div>
    </Modal>
  );
}
