import { useState } from "react";
import { X, Hash } from "lucide-react";
import { useTagSuggestions, normaliseTag, MAX_TAGS_PER_VIDEO } from "../../queries/tags";
import { cn } from "../../lib/cn";

/**
 * Tag entry with typeahead over tags that already exist.
 *
 * Suggesting existing tags is the whole point: free-text tagging with no suggestions produces
 * "gameplay", "game-play" and "gaming" as three separate tags nobody can browse. The server
 * normalises again on receipt, so what is shown here is a preview of what will be stored, never
 * the authority on it.
 */
export function TagPicker({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [input, setInput] = useState("");
  // Not the same thing as focus. The input keeps focus after a tag is committed, and an
  // absolutely-positioned list left open there covers the Upload button directly beneath it — so
  // the list closes on commit and only reopens when the user types or refocuses.
  const [open, setOpen] = useState(false);
  const full = tags.length >= MAX_TAGS_PER_VIDEO;
  const { data } = useTagSuggestions(input, open && !full);

  const add = (raw: string) => {
    const name = normaliseTag(raw);
    setInput("");
    setOpen(false);
    if (!name || full || tags.includes(name)) return;
    onChange([...tags, name]);
  };

  const suggestions = (data?.tags ?? []).filter((t) => !tags.includes(t.name)).slice(0, 6);
  const typed = normaliseTag(input);
  const canAddTyped = typed !== null && !tags.includes(typed) && !suggestions.some((s) => s.name === typed);

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full bg-base-600 py-1 pl-2 pr-1 text-xs text-signal"
            >
              #{tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                disabled={disabled}
                onClick={() => onChange(tags.filter((t) => t !== tag))}
                className="rounded-full p-0.5 text-signal-faint hover:text-signal disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={input}
          aria-label="Add a tag"
          disabled={disabled || full}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // A blur that fires before a suggestion's click would swallow the click, so the list is
          // only hidden after the browser has had a chance to deliver it.
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(input);
            } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          placeholder={full ? `Maximum ${MAX_TAGS_PER_VIDEO} tags` : "Add tags (press Enter)"}
          className="w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none disabled:opacity-50"
        />

        {open && !full && (suggestions.length > 0 || canAddTyped) && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-hairline bg-base-800 shadow-lg">
            {canAddTyped && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(input)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-signal hover:bg-base-700"
              >
                <Hash className="h-3.5 w-3.5 text-signal-faint" />
                Create <span className="font-medium">#{typed}</span>
              </button>
            )}
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(s.name)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-signal hover:bg-base-700"
              >
                <span className="flex items-center gap-2">
                  <Hash className="h-3.5 w-3.5 text-signal-faint" />
                  {s.name}
                </span>
                <span className="text-xs text-signal-faint">{s.useCount}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {input.trim() !== "" && typed === null && (
        <p className={cn("text-xs", "text-signal-faint")}>
          Tags are 2–30 characters, letters and numbers only, and can't be only digits.
        </p>
      )}
    </div>
  );
}
