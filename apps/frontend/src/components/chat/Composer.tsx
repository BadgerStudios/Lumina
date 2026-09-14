import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { BarChart3, EyeOff, Mic, MoreHorizontal, Plus, Send, Square, Sticker as StickerIcon, Upload, X } from "lucide-react";
import { ClientEvents, MAX_MESSAGE_LENGTH } from "@lumina/shared";
import type { MemberDTO } from "@lumina/shared";
import { getSocket } from "../../socket/socketClient";
import { StickerGrid } from "./StickerPicker";
import { EmojiPicker } from "./EmojiPicker";
import { MentionPalette, findMentionQuery } from "./MentionPalette";
import { useMembers } from "../../queries/members";
import { ICON } from "../common/Icon";
import { PollBuilder, type PollDraft } from "./PollBuilder";
import { SlashCommandPalette, parseInvocation } from "./SlashCommandPalette";
import { useServerCommands, useInvokeCommand } from "../../queries/interactions";
import type { RichSendPayload } from "../../queries/messages";
import type { SlashCommandDTO } from "@lumina/shared";

const TYPING_THROTTLE_MS = 2500;

/**
 * The composer's overflow menu.
 *
 * Send, emoji and attach stay on the bar because they are what people reach for constantly.
 * Everything else was competing with them for the same strip of space beside a one-line text
 * field, which made the box you are supposed to type in the smallest thing in its own row.
 *
 * Stickers appear as a SUBMENU rather than as an item that opens a second popover: the grid needs
 * a search box and its own scroll area, and Radix has `Sub` for exactly this. Nesting a second
 * DropdownMenu.Root inside a menu instead would mean juggling two open states and a close that
 * races the open.
 */
function ComposerOverflow({
  serverId,
  rich,
  canRecord,
  onRecord,
  onPoll,
  onSpoiler,
  onSticker,
}: {
  serverId?: string;
  /** Rich sends (stickers, polls) are only available where the caller supports them. */
  rich: boolean;
  canRecord: boolean;
  onRecord: () => void;
  onPoll: () => void;
  onSpoiler: () => void;
  onSticker: (stickerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stickersOpen, setStickersOpen] = useState(false);

  const item =
    "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none " +
    "data-[highlighted]:bg-base-600";

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setStickersOpen(false);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal"
          title="More"
          aria-label="More composer options"
        >
          <MoreHorizontal size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={8}
          className="z-50 w-52 rounded-lg border border-base-500 bg-base-700 p-1 shadow-lg"
        >
          {canRecord ? (
            <DropdownMenu.Item className={item} onSelect={onRecord}>
              <Mic size={16} className="shrink-0 text-signal-dim" />
              Voice message
            </DropdownMenu.Item>
          ) : null}

          {serverId && rich ? (
            <DropdownMenu.Sub open={stickersOpen} onOpenChange={setStickersOpen}>
              <DropdownMenu.SubTrigger className={item}>
                <StickerIcon size={16} className="shrink-0 text-signal-dim" />
                Sticker
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  sideOffset={8}
                  className="z-50 w-72 rounded-lg border border-base-500 bg-base-700 p-2 shadow-lg"
                >
                  <StickerGrid
                    serverId={serverId}
                    active={stickersOpen}
                    onPick={(id) => {
                      onSticker(id);
                      setOpen(false);
                    }}
                  />
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ) : null}

          {rich ? (
            <DropdownMenu.Item className={item} onSelect={onPoll}>
              <BarChart3 size={16} className="shrink-0 text-signal-dim" />
              Poll
            </DropdownMenu.Item>
          ) : null}

          <DropdownMenu.Item className={item} onSelect={onSpoiler}>
            <EyeOff size={16} className="shrink-0 text-signal-dim" />
            Spoiler
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

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
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Escape closes the suggestion list for THIS `@…` token without closing it for the next one.
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child element the pointer crosses, so a plain boolean
  // flickers. Counting depth means the overlay only clears when the pointer truly leaves.
  const dragDepth = useRef(0);
  const lastTypingSentAt = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Voice messages: record with MediaRecorder, then send the clip straight through the existing
  // attachment path (uploads already accept audio; MessageItem renders audio/* as an <audio> player).
  async function toggleRecord() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (blob.size > 0 && onSendWithAttachments) {
          const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : "webm";
          const file = new File([blob], `voice-message-${Date.now()}.${ext}`, { type });
          try {
            await onSendWithAttachments("", [file], replyTo?.id ?? null);
          } catch {
            setError("Couldn't send the voice message.");
          }
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError("A microphone is needed to record a voice message.");
    }
  }

  const { data: commands } = useServerCommands(serverId);
  const invokeCommand = useInvokeCommand();

  // The palette is open only while the text is a lone `/word` with no space yet — once an argument
  // is being typed, the list has served its purpose and would only be in the way.
  const slashQuery = /^\/([a-z0-9_-]*)$/i.exec(value)?.[1];
  const paletteOpen = slashQuery !== undefined && (commands?.length ?? 0) > 0;

  // ---- @-mention autocomplete --------------------------------------------------------------
  // Typing a mention meant knowing the exact username by heart and spelling it right, since a
  // near-miss silently sends as plain text and nobody is notified. Matched on username, display
  // name and nickname, so the name you see on screen is a name you can find.
  const { data: members } = useMembers(serverId);
  const mention = paletteOpen ? null : findMentionQuery(value, caret);
  const mentionMatches: MemberDTO[] = (() => {
    if (!mention || !members) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((m) => {
        const nick = m.nickname?.toLowerCase() ?? "";
        const display = m.user.displayName?.toLowerCase() ?? "";
        const uname = m.user.username.toLowerCase();
        return uname.includes(q) || display.includes(q) || nick.includes(q);
      })
      .slice(0, 8);
  })();
  const mentionOpen = mention !== null && mentionMatches.length > 0 && mention.start !== dismissedMentionStart;

  function pickMention(member: MemberDTO) {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const insert = `@${member.user.username} `;
    setValue(before + insert + after);
    const pos = before.length + insert.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
      setCaret(pos);
    });
    setMentionIndex(0);
  }

  /** Inserts text at the caret (or over the selection) — what the emoji picker hands back. */
  function insertAtCaret(text: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    setValue(value.slice(0, start) + text + value.slice(end));
    const pos = start + text.length;
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
      setCaret(pos);
    });
  }

  function syncCaret() {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }

  /** A screenshot in the clipboard is an attachment, not text. */
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onSendWithAttachments) return;
    const pasted = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null);
    if (pasted.length > 0) {
      e.preventDefault();
      setFiles((fs) => [...fs, ...pasted]);
    }
  }

  function handleDrop(e: DragEvent) {
    if (!onSendWithAttachments) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length > 0) setFiles((fs) => [...fs, ...dropped]);
  }

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
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => i + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // Both complete a mention here, unlike the slash palette where Enter is left alone to
        // send: an `@…` mid-sentence is far more often an unfinished mention than a real word.
        e.preventDefault();
        const picked = mentionMatches[mentionIndex % mentionMatches.length];
        if (picked) pickMention(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionIndex(0);
        if (mention) setDismissedMentionStart(mention.start);
        return;
      }
    }
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
    <div
      className="relative shrink-0 px-3 pb-3 pt-1"
      onDragEnter={(e) => {
        if (!onSendWithAttachments || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (onSendWithAttachments) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="lm-pop pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-1 rounded-pane border-2 border-dashed border-accent bg-base-900/80 text-sm font-medium text-accent">
          <Upload size={ICON.md} />
          Drop files to attach
        </div>
      )}

      {mentionOpen ? (
        <MentionPalette matches={mentionMatches} activeIndex={mentionIndex} onPick={pickMention} />
      ) : null}

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
            {/* Starting a recording lives in the overflow menu, but STOPPING one cannot:
                a control you need in order to end something already happening must be on
                screen, not two interactions away behind a menu. So this appears only while
                recording, and is the one button that comes back out. */}
            {recording ? (
              <button
                onClick={toggleRecord}
                className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-dnd/20 text-dnd transition"
                title="Stop and send voice message"
                aria-label="Stop and send voice message"
              >
                <Square size={16} />
              </button>
            ) : null}
          </>
        )}
        <textarea
          ref={textareaRef}
          aria-label={placeholder}
          value={value}
          onChange={(e) => {
            // Refuse the keystroke rather than let them type a message the server rejects.
            if (e.target.value.length > MAX_MESSAGE_LENGTH) return;
            setValue(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setError(null);
            setCommandIndex(0);
            setMentionIndex(0);
            // Editing the text re-arms a suggestion list that Escape had closed.
            setDismissedMentionStart(null);
            notifyTyping();
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={handlePaste}
          onBlur={stopTyping}
          placeholder={placeholder}
          rows={1}
          className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
        />
        {/* Emoji stays out here. Everything else people reach for occasionally — a sticker, a
            poll, a spoiler, a voice message — is behind the overflow, because seven controls
            around a one-line text field is a lot of surface for a box you are meant to type in. */}
        <EmojiPicker serverId={serverId} onPick={insertAtCaret} />
        <ComposerOverflow
          serverId={serverId}
          rich={Boolean(onSendRich)}
          canRecord={Boolean(onSendRich) && !recording}
          onRecord={() => void toggleRecord()}
          onPoll={() => setBuildingPoll((b) => !b)}
          onSpoiler={wrapSelectionInSpoiler}
          onSticker={(id) => void sendSticker(id)}
        />
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
