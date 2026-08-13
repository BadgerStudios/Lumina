import { useRef, useState } from "react";
import { Music, Trash2 } from "lucide-react";
import { EmojiSettingsPanel } from "./EmojiSettingsPanel";
import { resolveAssetUrl } from "../../lib/apiClient";
import {
  useDeleteSound,
  useDeleteSticker,
  useSounds,
  useStickers,
  useUploadSound,
  useUploadSticker,
} from "../../queries/expressions";

/**
 * Emoji, stickers and soundboard clips in one place.
 *
 * They are one tab because they are one permission (MANAGE_EMOJI — see
 * modules/stickers/routes.ts for why no new permission bit was minted) and one job: uploading small
 * assets to a server's shared palette. Three separate tabs for three lists of the same shape would
 * be three places to look for the same thing.
 */
export function ExpressionsSettingsPanel({ serverId }: { serverId: string }) {
  return (
    <div className="space-y-8">
      <EmojiSettingsPanel serverId={serverId} />
      <hr className="border-hairline" />
      <StickersSection serverId={serverId} />
      <hr className="border-hairline" />
      <SoundsSection serverId={serverId} />
    </div>
  );
}

/** Filename → a sensible default name, so bulk-uploading a pack does not mean typing 30 names. */
function deriveName(fileName: string, fallback: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .slice(0, 32);
  return base.length >= 2 ? base : fallback;
}

function StickersSection({ serverId }: { serverId: string }) {
  const { data: stickers, isLoading } = useStickers(serverId);
  const upload = useUploadSticker(serverId);
  const remove = useDeleteSticker(serverId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; name: string; description: string } | null>(null);

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold text-signal">Stickers</h3>
      <p className="mb-4 text-sm leading-relaxed text-signal-dim">
        Images sent on their own, from the sticker button in the composer. Unlike emoji they aren&apos;t
        typed as <code className="text-signal">:name:</code>, so spaces in names are fine.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared straight away so picking the same file twice still fires a change event —
          // and the File is read out of the list first, because clearing empties it.
          e.target.value = "";
          if (file) setPending({ file, name: deriveName(file.name, "sticker"), description: "" });
        }}
      />

      {pending ? (
        <div className="mb-4 rounded-xl border border-hairline bg-base-800/60 p-4">
          <div className="flex items-start gap-3">
            <img src={URL.createObjectURL(pending.file)} alt="" className="h-16 w-16 rounded object-contain" />
            <div className="flex-1 space-y-2">
              <input
                value={pending.name}
                onChange={(e) => setPending({ ...pending, name: e.target.value })}
                aria-label="Sticker name"
                placeholder="Name"
                className="w-full rounded-lg border border-hairline bg-base-900 px-2.5 py-1.5 text-sm text-signal focus:border-accent focus:outline-none"
              />
              <input
                value={pending.description}
                onChange={(e) => setPending({ ...pending, description: e.target.value })}
                aria-label="Sticker description"
                placeholder="Description (optional)"
                className="w-full rounded-lg border border-hairline bg-base-900 px-2.5 py-1.5 text-sm text-signal focus:border-accent focus:outline-none"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setPending(null)} className="rounded-lg px-3 py-1.5 text-sm text-signal-dim hover:text-signal">
              Cancel
            </button>
            <button
              disabled={upload.isPending || pending.name.trim().length < 2}
              onClick={() =>
                upload.mutate(
                  { name: pending.name.trim(), description: pending.description.trim() || undefined, file: pending.file },
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
          onClick={() => fileRef.current?.click()}
          className="mb-4 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Upload sticker
        </button>
      )}

      {isLoading ? (
        <p className="text-sm text-signal-dim">Loading…</p>
      ) : !stickers?.length ? (
        <p className="text-sm text-signal-dim">No stickers yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {stickers.map((s) => (
              <div key={s.id} className="group relative rounded-lg border border-hairline p-2">
                <img src={resolveAssetUrl(s.imageUrl)} alt={s.name} className="mx-auto h-16 w-16 object-contain" />
                <p className="mt-1 truncate text-center text-xs text-signal-dim">{s.name}</p>
                <button
                  onClick={() => remove.mutate(s.id)}
                  aria-label={`Delete sticker ${s.name}`}
                  className="absolute right-1 top-1 rounded bg-base-900/80 p-1 text-signal-faint opacity-0 hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <p className="pt-2 text-xs text-signal-faint">{stickers.length} of 50 used</p>
        </>
      )}
    </section>
  );
}

function SoundsSection({ serverId }: { serverId: string }) {
  const { data: sounds, isLoading } = useSounds(serverId);
  const upload = useUploadSound(serverId);
  const remove = useDeleteSound(serverId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; name: string; emoji: string } | null>(null);

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold text-signal">Soundboard</h3>
      <p className="mb-4 text-sm leading-relaxed text-signal-dim">
        Short clips anyone in a voice channel can play for everyone in it. Up to 5 seconds and 2MB —
        the length is read from the file itself, not from what the uploader claims.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) setPending({ file, name: deriveName(file.name, "sound"), emoji: "" });
        }}
      />

      {pending ? (
        <div className="mb-4 rounded-xl border border-hairline bg-base-800/60 p-4">
          <div className="flex items-center gap-2">
            <input
              value={pending.emoji}
              onChange={(e) => setPending({ ...pending, emoji: e.target.value })}
              aria-label="Sound emoji"
              placeholder="🙂"
              className="w-14 rounded-lg border border-hairline bg-base-900 px-2 py-1.5 text-center text-sm text-signal focus:border-accent focus:outline-none"
            />
            <input
              value={pending.name}
              onChange={(e) => setPending({ ...pending, name: e.target.value })}
              aria-label="Sound name"
              placeholder="Name"
              className="flex-1 rounded-lg border border-hairline bg-base-900 px-2.5 py-1.5 text-sm text-signal focus:border-accent focus:outline-none"
            />
          </div>
          {/* A preview before uploading, because a clip is the one asset type you cannot judge by
              looking at it — and the server will reject it for length after the upload otherwise. */}
          <audio controls src={URL.createObjectURL(pending.file)} className="mt-3 w-full" />
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setPending(null)} className="rounded-lg px-3 py-1.5 text-sm text-signal-dim hover:text-signal">
              Cancel
            </button>
            <button
              disabled={upload.isPending || pending.name.trim().length < 2}
              onClick={() =>
                upload.mutate(
                  { name: pending.name.trim(), emoji: pending.emoji.trim() || undefined, file: pending.file },
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
          onClick={() => fileRef.current?.click()}
          className="mb-4 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Upload sound
        </button>
      )}

      {isLoading ? (
        <p className="text-sm text-signal-dim">Loading…</p>
      ) : !sounds?.length ? (
        <p className="text-sm text-signal-dim">No sounds yet.</p>
      ) : (
        <>
          <div className="space-y-1">
            {sounds.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-base-700/50">
                <span className="w-5 shrink-0 text-center">
                  {s.emoji || <Music className="mx-auto h-4 w-4 text-signal-faint" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-signal">{s.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-signal-faint">
                  {(s.durationMs / 1000).toFixed(1)}s
                </span>
                <audio controls preload="none" src={resolveAssetUrl(s.audioUrl)} className="h-7 w-40 shrink-0" />
                <button
                  onClick={() => remove.mutate(s.id)}
                  aria-label={`Delete sound ${s.name}`}
                  className="shrink-0 rounded p-1.5 text-signal-faint hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <p className="pt-2 text-xs text-signal-faint">{sounds.length} of 40 used</p>
        </>
      )}
    </section>
  );
}
