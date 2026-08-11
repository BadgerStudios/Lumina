import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, Send, X } from "lucide-react";
import { ClientEvents } from "@lumina/shared";
import { getSocket } from "../../socket/socketClient";

const TYPING_THROTTLE_MS = 2500;

export function Composer({
  placeholder,
  onSend,
  onSendWithAttachments,
  typingChannelId,
  replyTo,
  onCancelReply,
}: {
  placeholder: string;
  onSend: (content: string, replyToId: string | null) => Promise<void>;
  onSendWithAttachments?: (content: string, files: File[], replyToId: string | null) => Promise<void>;
  typingChannelId?: string;
  replyTo?: { id: string; authorLabel: string } | null;
  onCancelReply?: () => void;
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastTypingSentAt = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function notifyTyping() {
    if (!typingChannelId) return;
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAt.current = now;
    getSocket().emit(ClientEvents.TYPING_START, { channelId: typingChannelId });
  }

  function stopTyping() {
    if (!typingChannelId) return;
    lastTypingSentAt.current = 0;
    getSocket().emit(ClientEvents.TYPING_STOP, { channelId: typingChannelId });
  }

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed && files.length === 0) return;
    setSending(true);
    setError(null);
    stopTyping();
    try {
      if (files.length > 0 && onSendWithAttachments) {
        await onSendWithAttachments(trimmed, files, replyTo?.id ?? null);
      } else {
        await onSend(trimmed, replyTo?.id ?? null);
      }
      setValue("");
      setFiles([]);
      onCancelReply?.();
    } catch (e) {
      // Previously an unhandled rejection with zero user-visible feedback (e.g. a slowmode
      // rejection, or any other server-side send failure) — the message just silently never
      // sent. Surfaced inline instead, matching how every other mutation error in this app
      // (role assignment, friend requests, etc.) is shown.
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="shrink-0 px-4 pb-6 pt-1">
      {replyTo ? (
        <div className="mb-1 flex items-center justify-between rounded-t-lg bg-base-600 px-3 py-1.5 text-xs text-signal-dim">
          <span>
            Replying to <span className="font-semibold">{replyTo.authorLabel}</span>
          </span>
          <button onClick={onCancelReply} className="text-signal-dim hover:text-signal">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {files.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-2 rounded-t-lg bg-base-600 px-3 py-2">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-1 rounded bg-base-500 px-2 py-1 text-xs text-signal">
              {f.name}
              <button onClick={() => setFiles((fs) => fs.filter((_, idx) => idx !== i))} className="text-signal-dim hover:text-signal">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {error ? <p className="mb-1 px-1 text-xs text-dnd">{error}</p> : null}

      <div className="flex items-end gap-2 rounded-lg bg-base-600 px-3 py-2.5">
        {onSendWithAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])])}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mb-0.5 shrink-0 text-signal-dim hover:text-signal"
              title="Upload a file"
            >
              <Plus size={22} />
            </button>
          </>
        )}
        <textarea
          aria-label={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            notifyTyping();
          }}
          onKeyDown={handleKeyDown}
          onBlur={stopTyping}
          placeholder={placeholder}
          rows={1}
          className="max-h-40 flex-1 resize-none bg-transparent py-1 text-sm text-signal outline-none placeholder:text-signal-faint"
        />
        <button
          onClick={() => void submit()}
          disabled={sending || (!value.trim() && files.length === 0)}
          className="mb-0.5 shrink-0 text-signal-dim hover:text-signal disabled:opacity-40"
          title="Send"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
