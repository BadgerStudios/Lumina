import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useChannels } from "../../queries/channels";
import { useNotificationSettings, useSetNotificationOverride, type NotificationLevel } from "../../queries/notifications";
import { cn } from "../../lib/cn";

const LEVEL_OPTIONS: Array<{ value: NotificationLevel; label: string }> = [
  { value: "ALL", label: "All messages" },
  { value: "MENTIONS", label: "Only @mentions" },
  { value: "NONE", label: "Nothing" },
];

function LevelSelect({ value, onChange, disabled }: { value: NotificationLevel; onChange: (v: NotificationLevel) => void; disabled?: boolean }) {
  return (
    <select
      aria-label="Notification level"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as NotificationLevel)}
      className="rounded bg-base-700 px-2 py-1 text-xs text-signal outline-none ring-1 ring-base-500 disabled:opacity-50"
    >
      {LEVEL_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Previously only a single global Web Push on/off toggle existed (UserSettingsModal.tsx's
 * Notifications section) — no way to mute one noisy server or channel without turning push off
 * everywhere. Precedence: channel override -> server override -> global default (ALL), computed
 * server-side in modules/notifications/service.ts's getEffectiveNotificationLevel. */
export function NotificationSettingsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "notificationSettings" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";

  const { data: overrides } = useNotificationSettings(open ? serverId : undefined);
  const { data: channels } = useChannels(open ? serverId : undefined);
  const setOverride = useSetNotificationOverride(serverId);

  const serverLevel = overrides?.find((o) => o.channelId === null)?.level ?? "ALL";
  const textChannels = (channels ?? []).filter((c) => c.type === "TEXT");

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Notification Settings" width="max-w-lg">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 rounded-lg bg-base-900 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-signal">This server</p>
            <p className="text-xs text-signal-dim">Default for every channel unless overridden below.</p>
          </div>
          <LevelSelect value={serverLevel} onChange={(level) => setOverride.mutate({ channelId: null, level })} />
        </div>

        <div>
          <span className="text-xs font-bold uppercase text-signal-dim">Channel overrides</span>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {textChannels.map((c) => {
              const override = overrides?.find((o) => o.channelId === c.id);
              return (
                <div key={c.id} className={cn("flex items-center justify-between gap-3 rounded px-2 py-1.5", "hover:bg-base-700")}>
                  <span className="min-w-0 flex-1 truncate text-sm text-signal-dim"># {c.name}</span>
                  <LevelSelect
                    value={override?.level ?? serverLevel}
                    onChange={(level) => setOverride.mutate({ channelId: c.id, level })}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
