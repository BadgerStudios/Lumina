import { useState } from "react";
import { Megaphone, Send, Trash2 } from "lucide-react";
import { useConfirm } from "../components/common/ConfirmDialog";
import { useMotdHistory, usePublishMotd, useRetireMotd } from "../queries/motd";
import { relativeTime } from "../lib/relativeTime";

const MAX_BODY = 1000;

/**
 * Compose the message of the day.
 *
 * The only channel that reaches every member unprompted, so the panel is built to make that weight
 * obvious rather than to make posting fast: what is live now sits above the composer, the history
 * of what was said before sits below it, and publishing replaces rather than appends — there is one
 * notice at a time, by design.
 */
export function OwnerMotdPanel() {
  const { data, isLoading } = useMotdHistory();
  const publish = usePublishMotd();
  const retire = useRetireMotd();
  const { confirm } = useConfirm();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const motds = data?.motds ?? [];
  const live = motds.find((m) => m.active) ?? null;
  const past = motds.filter((m) => !m.active);
  const remaining = MAX_BODY - body.length;

  const submit = async () => {
    if (!body.trim()) return;
    if (
      live &&
      !(await confirm({
        title: "Replace the current notice?",
        description: "The one showing now comes down and everyone sees the new one on their next load.",
        confirmText: "Publish",
      }))
    )
      return;
    await publish.mutateAsync({ title: title.trim() || null, body: body.trim() });
    setTitle("");
    setBody("");
  };

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase text-signal-dim">
          <Megaphone size={13} /> Showing now
        </h2>
        <div className="rounded-xl bg-[var(--oc-panel)] p-4 ring-1 ring-[var(--oc-line)]">
          {isLoading ? (
            <p className="text-sm text-signal-faint">Loading…</p>
          ) : live ? (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                {live.title && <p className="font-semibold text-signal">{live.title}</p>}
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-signal-dim">{live.body}</p>
                <p className="mt-2 text-xs text-signal-faint">
                  Published {relativeTime(live.publishedAt)}
                  {live.author ? ` by ${live.author.name}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Take this notice down?",
                      description: "Nobody sees a message of the day until you publish another.",
                      confirmText: "Take it down",
                      danger: true,
                    }))
                  )
                    return;
                  retire.mutate();
                }}
                disabled={retire.isPending}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-signal-dim transition hover:bg-dnd/15 hover:text-dnd disabled:opacity-60"
              >
                <Trash2 size={12} /> Take down
              </button>
            </div>
          ) : (
            <p className="text-sm text-signal-faint">
              Nothing is showing. Members see no notice until you publish one.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase text-signal-dim">
          {live ? "Replace it" : "Write one"}
        </h2>
        <div className="flex flex-col gap-2 rounded-xl bg-[var(--oc-panel)] p-4 ring-1 ring-[var(--oc-line)]">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, 80))}
            placeholder="Heading (optional)"
            className="rounded-lg border border-[var(--oc-line)] bg-[var(--oc-bg)] px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY))}
            rows={5}
            placeholder="What everyone should know today."
            className="resize-none rounded-lg border border-[var(--oc-line)] bg-[var(--oc-bg)] px-3 py-2 text-sm leading-relaxed text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-signal-faint">
              Shown once to each member on their first load of the day.
              {/* Only once it is worth knowing about. A counter that is always on screen reads as a
                  limit you are fighting rather than one you will never reach. */}
              {remaining < 200 ? ` · ${remaining} characters left` : ""}
            </p>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!body.trim() || publish.isPending}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              <Send size={13} /> {live ? "Replace" : "Publish"}
            </button>
          </div>
        </div>
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold uppercase text-signal-dim">Previously</h2>
          <div className="flex flex-col gap-1.5">
            {past.map((m) => (
              <div key={m.id} className="rounded-lg bg-[var(--oc-panel)] px-3 py-2 ring-1 ring-[var(--oc-line)]">
                {m.title && <p className="text-sm font-medium text-signal">{m.title}</p>}
                <p className="truncate text-xs text-signal-dim">{m.body}</p>
                <p className="mt-1 text-xs text-signal-faint">
                  {relativeTime(m.publishedAt)}
                  {m.author ? ` · ${m.author.name}` : ""}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
