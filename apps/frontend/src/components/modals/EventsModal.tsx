import { useState } from "react";
import { CalendarDays, MapPin, Volume2, Trash2, Plus } from "lucide-react";
import { Modal } from "./Modal";
import { cn } from "../../lib/cn";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { useServer } from "../../queries/servers";
import { useMembers } from "../../queries/members";
import { useRoles } from "../../queries/roles";
import { useChannels } from "../../queries/channels";
import { can } from "../../lib/permissions";
import { useServerEvents, useCreateEvent, useCancelEvent, useRsvp, type ServerEventDTO } from "../../queries/events";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

function EventCard({ event, serverId, canManage, viewerId }: {
  event: ServerEventDTO;
  serverId: string;
  canManage: boolean;
  viewerId: string | undefined;
}) {
  const rsvp = useRsvp(serverId);
  const cancel = useCancelEvent(serverId);
  const { data: channels } = useChannels(serverId);
  const channelName = event.channelId ? channels?.find((c) => c.id === event.channelId)?.name : null;
  const started = new Date(event.startsAt).getTime() <= Date.now();
  const cancelled = !!event.canceledAt;

  return (
    <div className={cn("rounded-xl bg-base-900 p-3 ring-1 ring-base-600", cancelled && "opacity-50")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            {cancelled ? "Cancelled" : started ? "Happening now" : formatWhen(event.startsAt)}
          </p>
          <p className="mt-0.5 truncate text-sm font-bold text-signal">{event.name}</p>
          {event.description ? <p className="mt-1 text-xs text-signal-dim">{event.description}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-signal-faint">
            {channelName ? (
              <span className="flex items-center gap-1"><Volume2 size={11} /> {channelName}</span>
            ) : event.location ? (
              <span className="flex items-center gap-1"><MapPin size={11} /> {event.location}</span>
            ) : null}
            <span>{event.goingCount} going{event.interestedCount > 0 ? ` · ${event.interestedCount} interested` : ""}</span>
            {event.creator ? <span>by {event.creator.displayName ?? event.creator.username}</span> : null}
          </div>
        </div>
        {(canManage || event.creator?.id === viewerId) && !cancelled ? (
          <button
            onClick={() => cancel.mutate(event.id)}
            title="Cancel event"
            className="shrink-0 text-signal-faint hover:text-dnd"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      {!cancelled && (
        <div className="mt-2 flex gap-1.5">
          {(["GOING", "INTERESTED"] as const).map((status) => (
            <button
              key={status}
              onClick={() => rsvp.mutate({ eventId: event.id, status: event.myRsvp === status ? null : status })}
              disabled={rsvp.isPending}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 transition-colors",
                event.myRsvp === status
                  ? "bg-accent text-white ring-accent"
                  : "bg-base-800 text-signal-dim ring-base-600 hover:text-signal",
              )}
            >
              {status === "GOING" ? "Going" : "Interested"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Scheduled events for one server: the upcoming list with RSVP, and creation for anyone holding
 * MANAGE_EVENTS / MANAGE_SERVER (or the event's own creator, for their own). RSVPs get an inbox
 * + push reminder ~30 minutes before start — the point of the whole feature.
 */
export function EventsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "serverEvents" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";

  const user = useAuthStore((s) => s.user);
  const { data: server } = useServer(open ? serverId : undefined);
  const { data: members } = useMembers(open ? serverId : undefined);
  const { data: roles } = useRoles(open ? serverId : undefined);
  const { data: channels } = useChannels(open ? serverId : undefined);
  const me = members?.find((m) => m.userId === user?.id);
  const canManage =
    can("MANAGE_EVENTS", { userId: user?.id, server, member: me, roles }) ||
    can("MANAGE_SERVER", { userId: user?.id, server, member: me, roles });

  const { data: events } = useServerEvents(open ? serverId : undefined);
  const createEvent = useCreateEvent(serverId);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [channelId, setChannelId] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const voiceChannels = (channels ?? []).filter((c) => c.type === "VOICE");
  const upcoming = (events ?? []).filter((e) => !e.canceledAt);
  const cancelledRecent = (events ?? []).filter((e) => e.canceledAt);

  const submit = async () => {
    setError(null);
    try {
      await createEvent.mutateAsync({
        name,
        description: description || null,
        channelId: channelId || null,
        location: channelId ? null : location || null,
        startsAt: new Date(startsAt).toISOString(),
      });
      setCreating(false);
      setName(""); setDescription(""); setStartsAt(""); setChannelId(""); setLocation("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the event.");
    }
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Events" width="max-w-lg">
      <div className="flex flex-col gap-3">
        {canManage && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            <Plus size={15} /> Schedule an event
          </button>
        )}

        {creating && (
          <div className="flex flex-col gap-2 rounded-xl bg-base-900 p-3 ring-1 ring-base-600">
            <input
              value={name} onChange={(e) => setName(e.target.value)} placeholder="Event name" maxLength={100}
              className="rounded bg-base-800 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
            />
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's happening? (optional)"
              rows={2} maxLength={1000}
              className="resize-none rounded bg-base-800 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
            />
            <input
              type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
              aria-label="Starts at"
              className="rounded bg-base-800 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
            />
            <select
              value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Voice channel"
              className="rounded bg-base-800 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
            >
              <option value="">Somewhere else…</option>
              {voiceChannels.map((c) => <option key={c.id} value={c.id}>🔊 {c.name}</option>)}
            </select>
            {!channelId && (
              <input
                value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (a link, a game, a place)" maxLength={200}
                className="rounded bg-base-800 px-2.5 py-1.5 text-sm text-signal ring-1 ring-base-600"
              />
            )}
            {error && <p className="text-xs text-dnd">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => void submit()}
                disabled={!name.trim() || !startsAt || createEvent.isPending}
                className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Create
              </button>
              <button onClick={() => setCreating(false)} className="rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {upcoming.map((e) => (
            <EventCard key={e.id} event={e} serverId={serverId} canManage={canManage} viewerId={user?.id} />
          ))}
          {cancelledRecent.map((e) => (
            <EventCard key={e.id} event={e} serverId={serverId} canManage={canManage} viewerId={user?.id} />
          ))}
          {events && events.length === 0 && !creating && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <CalendarDays size={28} className="text-signal-faint" />
              <p className="text-sm text-signal-faint">Nothing scheduled yet.</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
