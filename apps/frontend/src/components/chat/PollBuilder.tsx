import { useState } from "react";
import { Plus, X } from "lucide-react";

export interface PollDraft {
  question: string;
  options: string[];
  allowMultiple: boolean;
  durationHours: number | null;
}

const MAX_OPTIONS = 10;

const DURATIONS: Array<{ label: string; hours: number | null }> = [
  { label: "1 hour", hours: 1 },
  { label: "8 hours", hours: 8 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
  { label: "No limit", hours: null },
];

/**
 * Poll composition, shown inline above the composer rather than in a modal.
 *
 * Inline because a poll is a message: you frequently want to type something alongside it, and a
 * modal would put the composer behind an overlay while you did. The two option rows it opens with
 * are the minimum the server accepts, so the initial state is never one that cannot be sent.
 */
export function PollBuilder({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (draft: PollDraft) => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [durationHours, setDurationHours] = useState<number | null>(24);
  const [error, setError] = useState<string | null>(null);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  // Mirrors the server's rules exactly (modules/polls/service.ts) so the button is disabled for the
  // same reasons the API would refuse, rather than enabling a send that comes back as an error.
  const duplicate = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ready = question.trim().length > 0 && filled.length >= 2 && !duplicate;

  return (
    <div className="mb-1 rounded-t-lg border border-base-500 bg-base-600 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-signal">New poll</h3>
        <button onClick={onCancel} className="text-signal-dim hover:text-signal" aria-label="Cancel this poll">
          <X size={16} />
        </button>
      </div>

      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={300}
        placeholder="What do you want to ask?"
        aria-label="Poll question"
        className="mb-2 w-full rounded bg-base-700 px-2.5 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
      />

      <div className="flex flex-col gap-1.5">
        {options.map((option, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={option}
              onChange={(e) => setOptions((prev) => prev.map((o, idx) => (idx === i ? e.target.value : o)))}
              maxLength={100}
              placeholder={`Option ${i + 1}`}
              aria-label={`Poll option ${i + 1}`}
              className="flex-1 rounded bg-base-700 px-2.5 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
            />
            {/* Removal appears only past the two-option minimum, so the form can never be emptied
                into a state the server would reject. */}
            {options.length > 2 && (
              <button
                onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-signal-dim hover:text-dnd"
                aria-label={`Remove option ${i + 1}`}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {options.length < MAX_OPTIONS && (
        <button
          onClick={() => setOptions((prev) => [...prev, ""])}
          className="mt-1.5 flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Plus size={12} /> Add an option
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-signal-dim">
          <input type="checkbox" checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />
          Allow multiple answers
        </label>
        <label className="flex items-center gap-1.5 text-xs text-signal-dim">
          Closes after
          <select
            value={durationHours === null ? "none" : String(durationHours)}
            onChange={(e) => setDurationHours(e.target.value === "none" ? null : Number(e.target.value))}
            className="rounded bg-base-700 px-1.5 py-1 text-xs text-signal outline-none"
          >
            {DURATIONS.map((d) => (
              <option key={d.label} value={d.hours === null ? "none" : String(d.hours)}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {duplicate ? <p className="mt-2 text-xs text-dnd">Two options say the same thing.</p> : null}
      {error ? <p className="mt-2 text-xs text-dnd">{error}</p> : null}

      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-signal-dim hover:text-signal">
          Cancel
        </button>
        <button
          disabled={!ready}
          onClick={() => {
            if (!ready) {
              setError("A poll needs a question and two different options.");
              return;
            }
            onSubmit({ question: question.trim(), options: filled, allowMultiple, durationHours });
          }}
          className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          Attach poll
        </button>
      </div>
    </div>
  );
}
