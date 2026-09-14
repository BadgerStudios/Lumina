import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Bookmark, BellRing, Trash2 } from "lucide-react";
import { useSavedMessages, useUnsaveMessage, useSaveMessage, type SavedMessage } from "../queries/keep";
import { UserAvatar } from "../components/common/UserAvatar";
import { relativeTime } from "../lib/relativeTime";

/**
 * Everything you kept.
 *
 * Ordered newest-first and grouped by nothing: a saved list is a shelf, not a filing system, and
 * the reason people abandon bookmark features is that organising them becomes a second job. The
 * note and the reminder do that work instead — they are why you kept it, written at the moment you
 * knew.
 */
export function SavedRoute() {
  const { data, isLoading } = useSavedMessages();
  const unsave = useUnsaveMessage();

  return (
    <div className="lx-pane flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0 bg-base-900">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline bg-base-800 px-4 py-3">
        <Bookmark className="h-5 w-5 shrink-0 text-accent" />
        <h1 className="font-display text-lg text-signal">Saved</h1>
        {data && data.saved.length > 0 && (
          <span className="ml-auto font-mono text-xs text-signal-faint">{data.saved.length}</span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
          </div>
        ) : !data || data.saved.length === 0 ? (
          <div className="mx-auto max-w-sm py-16 text-center">
            <Bookmark className="mx-auto mb-3 h-10 w-10 text-signal-faint" aria-hidden="true" />
            <p className="text-sm text-signal">Nothing saved yet</p>
            <p className="mt-1 text-xs text-signal-faint">
              Save a message from its hover actions to keep it here — with a note to yourself, or a
              reminder to come back to it.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-2">
            {data.saved.map((s) => (
              <SavedCard key={s.id} saved={s} onRemove={() => unsave.mutate({ messageId: s.message.id })} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SavedCard({
  saved,
  onRemove,
}: {
  saved: SavedMessage;
  onRemove: () => void;
}) {
  const save = useSaveMessage();
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(saved.note ?? "");
  const author = saved.message.author;

  return (
    <div className="rounded-xl border border-hairline bg-base-800 p-3">
      <div className="flex items-start gap-2.5">
        <UserAvatar
          avatarUrl={author?.avatarUrl ?? null}
          name={author?.displayName ?? author?.username ?? "Unknown"}
          size={28}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-signal">
              {author?.displayName ?? author?.username ?? "Unknown"}
            </span>
            <span className="text-xs text-signal-faint">{saved.message.location}</span>
            <span className="text-xs text-signal-faint">· {relativeTime(saved.message.createdAt)}</span>
          </div>
          {saved.message.deleted ? (
            // The author retracted it after it was saved. Keeping the copy would quietly defeat
            // that, so the row survives for the note's sake and the words do not.
            <p className="mt-0.5 text-sm italic text-signal-faint">This message was deleted.</p>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-signal-dim">
              {saved.message.content}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove from saved"
          className="shrink-0 text-signal-faint hover:text-flare"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {saved.remindAt && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-accent">
          <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          Reminder {relativeTime(saved.remindAt)}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        {editingNote ? (
          <>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              autoFocus
              placeholder="Why did you keep this?"
              className="min-w-0 flex-1 rounded-lg border border-hairline bg-base-700 px-2 py-1 text-xs text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() =>
                save.mutate(
                  { messageId: saved.message.id, note },
                  { onSuccess: () => setEditingNote(false) },
                )
              }
              className="shrink-0 rounded-lg bg-accent px-2 py-1 text-xs font-medium text-white"
            >
              Save
            </button>
          </>
        ) : saved.note ? (
          <button
            type="button"
            onClick={() => setEditingNote(true)}
            className="min-w-0 flex-1 truncate rounded bg-base-900 px-2 py-1 text-left text-xs text-signal-dim"
          >
            {saved.note}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEditingNote(true)}
            className="text-xs text-signal-faint hover:text-signal"
          >
            Add a note
          </button>
        )}
        {saved.message.channelId && (
          <Link
            to={`/channels/${saved.message.channelId}`}
            className="ml-auto shrink-0 text-xs text-accent hover:underline"
          >
            Jump
          </Link>
        )}
      </div>
    </div>
  );
}
