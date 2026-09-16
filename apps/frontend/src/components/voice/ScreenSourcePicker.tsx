import { Monitor, AppWindow } from "lucide-react";
import { Modal } from "../modals/Modal";
import { useScreenPickerStore } from "../../store/screenPickerStore";
import type { DesktopScreenSource } from "../../lib/desktopShell";

/**
 * The desktop app's "what do you want to share?" picker. A browser shows its own; Electron has
 * none, so without this the desktop app could not share a screen at all. Mounted once in AppShell
 * and driven by screenPickerStore, which voiceStore awaits.
 */
export function ScreenSourcePicker() {
  const request = useScreenPickerStore((s) => s.request);
  const settle = useScreenPickerStore((s) => s.settle);
  const screens = request?.sources.filter((s) => s.kind === "screen") ?? [];
  const windows = request?.sources.filter((s) => s.kind === "window") ?? [];

  return (
    <Modal open={request != null} onOpenChange={(open) => !open && settle(null)} title="Share your screen" width="max-w-2xl">
      {screens.length > 0 && <SourceGroup label="Screens" sources={screens} onPick={settle} />}
      {windows.length > 0 && <SourceGroup label="Windows" sources={windows} onPick={settle} />}
      <div className="mt-4 flex justify-end">
        <button onClick={() => settle(null)} className="lx-focus rounded-lg px-3 py-1.5 text-sm text-signal-dim hover:bg-base-600 hover:text-signal">
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function SourceGroup({ label, sources, onPick }: { label: string; sources: DesktopScreenSource[]; onPick: (id: string) => void }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold text-signal-dim">{label}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {sources.map((s) => (
          <button
            key={s.id}
            onClick={() => onPick(s.id)}
            className="lx-focus group flex flex-col gap-1.5 rounded-lg border border-hairline p-2 text-left transition hover:border-accent"
            data-screen-source={s.id}
          >
            <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-base-900">
              {s.thumbnail ? (
                <img src={s.thumbnail} alt="" className="h-full w-full object-contain" />
              ) : s.kind === "screen" ? (
                <Monitor size={28} className="text-signal-faint" />
              ) : (
                <AppWindow size={28} className="text-signal-faint" />
              )}
            </div>
            <span className="truncate text-xs text-signal group-hover:text-signal">{s.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
