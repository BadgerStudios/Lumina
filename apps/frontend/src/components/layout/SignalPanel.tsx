import { useNavigate } from "react-router-dom";
import { BellOff } from "lucide-react";
import { useUnread } from "../../queries/readState";
import { useChannels } from "../../queries/channels";
import { useSignalStore } from "../../store/signalStore";
import { useUIStore } from "../../store/uiStore";

/** Pinned above the channel category list (per the approved design pitch's "Signal" block) —
 * names exactly which channel has unread activity instead of Discord's generic inbox, with a
 * one-click (client-side-only, see store/signalStore.ts) mute right on the row. */
export function SignalPanel({ serverId }: { serverId: string }) {
  const { data: unread } = useUnread(serverId);
  const { data: channels } = useChannels(serverId);
  const isHidden = useSignalStore((s) => s.isHidden);
  const muteChannel = useSignalStore((s) => s.muteChannel);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const navigate = useNavigate();

  const rows = (unread ?? [])
    .filter((u) => !isHidden(u.channelId, u.unreadCount))
    .map((u) => ({ ...u, channel: channels?.find((c) => c.id === u.channelId) }))
    .filter((u): u is typeof u & { channel: NonNullable<(typeof u)["channel"]> } => !!u.channel);

  if (rows.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-aurora-dim bg-grad-soft px-2.5 pb-1 pt-2" style={{ borderColor: "var(--aurora-dim)" }}>
      <div className="mb-1 flex items-center gap-1.5 px-0.5 font-mono text-[0.62rem] uppercase tracking-widest" style={{ color: "var(--aurora)" }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--aurora)", boxShadow: "0 0 8px 1px var(--aurora)" }} />
        Signal
      </div>
      <div className="flex flex-col pb-1">
        {rows.map((u) => (
          <div
            key={u.channelId}
            role="button"
            onClick={() => {
              navigate(`/channels/${serverId}/${u.channelId}`);
              closeMobileDrawer();
            }}
            className="group flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-base-600"
          >
            <span className="truncate font-semibold text-signal">#{u.channel.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-signal-dim">{u.unreadCount} new</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                muteChannel(u.channelId, u.unreadCount);
              }}
              title={`Mute #${u.channel.name}`}
              className="shrink-0 text-signal-faint opacity-0 hover:text-dnd group-hover:opacity-100"
            >
              <BellOff size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
