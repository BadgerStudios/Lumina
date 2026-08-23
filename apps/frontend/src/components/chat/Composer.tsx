import { useRef, useState, type KeyboardEvent } from "react";
import { BarChart3, EyeOff, Plus, Send, X } from "lucide-react";
import { ClientEvents } from "@lumina/shared";
import { getSocket } from "../../socket/socketClient";
import { StickerPicker } from "./StickerPicker";
import { PollBuilder, type PollDraft } from "./PollBuilder";
import { SlashCommandPalette, parseInvocation } from "./SlashCommandPalette";
import { useServerCommands, useInvokeCommand } from "../../queries/interactions";
import type { RichSendPayload } from "../../queries/messages";
import type { SlashCommandDTO } from "@lumina/shared";

const TYPING_THROTTLE_MS = 2500;

export function Composer({
  placeholder,
  onSend,
  onSendWithAttachments,
  onSendRich,
  typingChannelId,
  serverId,
  dmConversationId,
  replyTo,
  onCancelReply,
}: {
  placeholder: string;
  onSend: (content: string, replyToId: string | null) => Promise<void>;
  onSendWithAttachments?: (content: string, files: File[], replyToId: string | null) => Promise<void>;
  /** Stickers and polls. Absent in surfaces that only accept plain text. */
  onSendRich?: (payload: RichSendPayload) => Promise<void>;
  typingChannelId?: string;
  serverId?: string;
  dmConversationId?: string;
  replyTo?: { id: string; authorLabel: string } | null;
  onCancelReply?: () => void;
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [poll, setPoll] = useState<PollDraft | null>(null);
  const [buildingPoll, setBuildingPoll] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const lastTypingSentAt = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: commands } = useServerCommands(serverId);
  const invokeCommand = useInvokeCommand();

  // The palette is open only while the text is a lone `/word` with no space yet — once an argument
  // is being typed, the list has served its purpose and would only be in the way.
  const slashQuery = /^\/([a-z0-9_-]*)$/i.exec(value)?.[1];
  const paletteOpen = slashQuery !== undefined && (commands?.length ?? 0) > 0;

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

  /**
   * Wraps the current selection in `||…||`.
   *
   * `||` is markdown nobody guesses — a button is the only way most people ever find out spoilers
   * exist. With nothing selected it inserts an empty pair and parks the caret in the middle, so the
   * button is also a usable "start a spoiler" rather than only a "hide what I already typed".
   */
  function wrapSelectionInSpoiler() {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const next = `${value.slice(0, start)}||${value.slice(start, end)}||${value.slice(end)}`;
    setValue(next);
    // The caret has to be restored after React has painted the new value, or it snaps to the end.
    requestAnimationFrame(() => {
      el.focus();
      const caret = start === end ? start + 2 : end + 4;
      el.setSelectionRange(caret, caret);
    });
  }

  /**
   * Runs a slash command instead of sending the text.
   *
   * Returns true when it handled the input. A `/word` that matches no known command deliberately
   * falls through and is sent as an ordinary message — refusing to send it would make the composer
   * reject perfectly normal text (a path, a date, an emoticon) on the grounds that a bot might
   * one day register something by that name.
   */
  async function tryRunCommand(text: string): Promise<boolean> {
    if (!text.startsWith("/") || !commands?.length) return false;
    const parsed = parseInvocation(text, commands);
    if (!parsed) return false;

    const result = await invokeCommand.mutateAsync({
      channelId: typingChannelId,
      dmConversationId,
      name: parsed.command.name,
      options: parsed.options,
    });
    if (result.timedOut) setError(result.timedOut);
    return true;
  }

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed && files.length === 0 && !poll) return;
    setSending(true);
    setError(null);
    stopTyping();
    try {
      if (await tryRunCommand(trimmed)) {
        setValue("");
      } else if (poll && onSendRich) {
        await onSendRich({
          content: trimmed,
          replyToId: replyTo?.id ?? null,
          poll: {
            question: poll.question,
            options: poll.options,
            allowMultiple: poll.allowMultiple,
            durationHours: poll.durationHours,
          },
        });
        setPoll(null);
        setValue("");
      } else if (files.length > 0 && onSendWithAttachments) {
        await onSendWithAttachments(trimmed, files, replyTo?.id ?? null);
        setValue("");
        setFiles([]);
      } else {
        await onSend(trimmed, replyTo?.id ?? null);
        setValue("");
      }
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

  async function sendSticker(stickerId: string) {
    if (!onSendRich) return;
    setError(null);
    try {
      // Sent immediately rather than staged next to the text: a sticker IS the message, so
      // making someone press Enter afterwards reads as the picker having failed.
      await onSendRich({ content: "", replyToId: replyTo?.id ?? null, stickerId });
      onCancelReply?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that sticker");
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (paletteOpen && commands) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIndex((i) => i + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Tab") {
        // Tab completes; Enter deliberately does not, so a genuine message that happens to start
        // with a slash can still be sent by pressing Enter as usual.
        e.preventDefault();
        const matches = commands.filter((c) => c.name.startsWith(slashQuery ?? ""));
        const picked: SlashCommandDTO | undefined = matches[commandIndex % Math.max(1, matches.length)];
        if (picked) setValue(`/${picked.name} `);
        return;
      }
      if (e.key === "Escape") {
        setValue("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      {paletteOpen && commands ? (
        <SlashCommandPalette
          commands={commands}
          query={slashQuery ?? ""}
          activeIndex={commandIndex}
          onPick={(command) => {
            setValue(`/${command.name} `);
            textareaRef.current?.focus();
          }}
        />
      ) : null}

      {buildingPoll ? (
        <PollBuilder
          onCancel={() => setBuildingPoll(false)}
          onSubmit={(draft) => {
            setPoll(draft);
            setBuildingPoll(false);
          }}
        />
      ) : null}

      {poll ? (
        <div className="mb-1 flex items-center justify-between rounded-xl border border-hairline bg-base-900/60 px-3 py-1.5 text-xs text-signal-dim">
          <span className="min-w-0 truncate">
            Poll attached: <span className="font-semibold text-signal">{poll.question}</span>
          </span>
          <button onClick={() => setPoll(null)} className="shrink-0 text-signal-dim hover:text-signal" aria-label="Remove the attached poll">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {replyTo ? (
        <div className="mb-1 flex items-center justify-between rounded-xl border border-hairline bg-base-900/60 px-3 py-1.5 text-xs text-signal-dim">
          <span>
            Replying to <span className="font-semibold">{replyTo.authorLabel}</span>
          </span>
          <button onClick={onCancelReply} className="text-signal-dim hover:text-signal">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {files.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-2 rounded-xl border border-hairline bg-base-900/60 px-3 py-2">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-1 rounded-lg border border-hairline bg-base-800 px-2 py-1 text-xs text-signal">
              {f.name}
              <button onClick={() => setFiles((fs) => fs.filter((_, idx) => idx !== i))} className="text-signal-dim hover:text-signal">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {error ? <p className="mb-1 px-1 text-xs text-flare">{error}</p> : null}

      <div className="flex items-end gap-1 rounded-2xl border border-hairline bg-base-900/50 px-2 py-1.5 transition focus-within:border-accent">
        {onSendWithAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])]);
                // Reset so picking the SAME file again (after removing or sending it) still fires
                // a change event — the native input suppresses it when the path doesn't change.
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal"
              title="Upload a file"
              aria-label="Upload a file"
            >
              <Plus size={19} />
            </button>
          </>
        )}
        <textarea
          ref={textareaRef}
          aria-label={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setCommandIndex(0);
            notifyTyping();
          }}
          onKeyDown={handleKeyDown}
          onBlur={stopTyping}
          placeholder={placeholder}
          rows={1}
          className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
        />
        {/* Stickers are server-scoped, so in a DM there is nothing to pick from and the control is
            absent rather than present and empty. */}
        {serverId && onSendRich ? <StickerPicker serverId={serverId} onPick={(id) => void sendSticker(id)} /> : null}
        {onSendRich ? (
          <button
            type="button"
            onClick={() => setBuildingPoll((b) => !b)}
            className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal"
            title="Attach a poll"
            aria-label="Attach a poll"
          >
            <BarChart3 size={17} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={wrapSelectionInSpoiler}
          className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal"
          title="Mark as a spoiler (||hidden||)"
          aria-label="Mark the selected text as a spoiler"
        >
          <EyeOff size={16} />
        </button>
        <button
          onClick={() => void submit()}
          disabled={sending || (!value.trim() && files.length === 0 && !poll)}
          className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-hover disabled:bg-transparent disabled:text-signal-faint"
          title="Send"
          aria-label="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
