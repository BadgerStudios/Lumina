import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { resolveAssetUrl } from "../../lib/apiClient";
import {
  useCustomEmojis,
  useDeleteEmoji,
  useRenameEmoji,
  useUploadEmoji,
} from "../../queries/emoji";

/**
 * Custom emoji management, for the server settings modal.
 *
 * The name is derived from the filename on pick (`blob-cat.png` → `blob_cat`) because that is what
 * people expect and it makes bulk-uploading a pack bearable — but it stays editable before upload,
 * since the derived name is a guess.
 */
export function EmojiSettingsPanel({ serverId }: { serverId: string }) {
  const { data: emojis, isLoading } = useCustomEmojis(serverId);
  const upload = useUploadEmoji(serverId);
  const rename = useRenameEmoji(serverId);
  const remove = useDeleteEmoji(serverId);

  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; name: string } | null>(null);

  function onPick(file: File | undefined) {
    if (!file) return;
    const derived = file.name
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    setPending({ file, name: derived.length >= 2 ? derived : "emoji" });
  }

  return (
    <div>
      <div className="mb-4">
        <p className="text-sm leading-relaxed text-signal-dim">
          Upload images to use as <code className="text-signal">:name:</code> in messages and as
          reactions. Names are unique within this server, so they can&apos;t clash with another
          server&apos;s.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          // Reset so picking the same file twice still fires a change event.
          e.target.value = "";
        }}
      />

      {pending ? (
        <div className="mb-5 rounded-xl border border-hairline bg-base-800/60 p-4">
          <div className="flex items-center gap-3">
            <img
              src={URL.createObjectURL(pending.file)}
              alt=""
              className="h-12 w-12 rounded object-contain"
            />
            <div className="flex-1">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-signal-faint">
                Name
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-signal-faint">:</span>
                <input
                  value={pending.name}
                  onChange={(e) => setPending({ ...pending, name: e.target.value })}
                  className="w-full rounded-lg border border-hairline bg-base-900 px-2.5 py-1.5 text-sm text-signal focus:border-accent focus:outline-none"
                />
                <span className="text-sm text-signal-faint">:</span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded-lg px-3 py-1.5 text-sm text-signal-dim hover:text-signal"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={upload.isPending}
              onClick={() =>
                upload.mutate(
                  { name: pending.name, file: pending.file },
                  { onSuccess: () => setPending(null) },
                )
              }
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {upload.isPending ? "Uploading…" : "Upload"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mb-5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Upload emoji
        </button>
      )}

      {isLoading ? (
        <p className="text-sm text-signal-dim">Loading…</p>
      ) : !emojis?.length ? (
        <p className="text-sm text-signal-dim">No custom emoji yet.</p>
      ) : (
        <div className="space-y-1">
          {emojis.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-base-700/50"
            >
              {/* resolveAssetUrl, not the raw path: on mobile/desktop the WebView's origin shares
                  nothing with the API's, so a root-relative path resolves against the wrong host. */}
              <img src={resolveAssetUrl(e.imageUrl)} alt="" className="h-8 w-8 shrink-0 object-contain" />
              <input
                defaultValue={e.name}
                onBlur={(ev) => {
                  const next = ev.target.value.trim().toLowerCase();
                  if (next && next !== e.name) rename.mutate({ id: e.id, name: next });
                }}
                className="flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm text-signal hover:border-hairline focus:border-accent focus:bg-base-900 focus:outline-none"
              />
              {e.animated && (
                <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-accent">
                  GIF
                </span>
              )}
              <button
                type="button"
                onClick={() => remove.mutate(e.id)}
                title={`Delete :${e.name}:`}
                className="shrink-0 rounded p-1.5 text-signal-faint hover:bg-danger/15 hover:text-danger"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <p className="pt-2 text-xs text-signal-faint">
            {emojis.length} of 100 used
          </p>
        </div>
      )}
    </div>
  );
}
