import { useState } from "react";
import { Loader2, LifeBuoy, Send, ChevronLeft } from "lucide-react";
import {
  useMyTickets,
  useMyTicket,
  useOpenSupportTicket,
  useReplyToMyTicket,
} from "../../queries/tickets";
import { UserAvatar } from "../common/UserAvatar";
import { relativeTime } from "../../lib/relativeTime";
import { cn } from "../../lib/cn";

/**
 * Asking Lumina for help, and reading what came back.
 *
 * Support previously had nowhere to go, so people raised it as a report about themselves — which
 * put someone asking a billing question into the moderation queue as a reported account. A support
 * ticket is its own category now, lands in the same queue moderators already work, and carries a
 * conversation so the answer arrives where the question was asked rather than by email.
 *
 * Internal notes between staff are filtered out server-side, not here: what a person can read is
 * not a decision the client should be trusted with.
 */
export function SupportSection() {
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const { data, isLoading } = useMyTickets();

  if (openRef) return <SupportThread refId={openRef} onBack={() => setOpenRef(null)} />;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Support</span>
        <p className="mb-2 text-sm text-signal-faint">
          Ask us anything — billing, a problem with your account, or something that looks broken.
          Replies arrive here.
        </p>
        {composing ? (
          <NewTicket onDone={() => setComposing(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            <LifeBuoy className="h-4 w-4" aria-hidden="true" />
            Open a support ticket
          </button>
        )}
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Your tickets</span>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : !data || data.tickets.length === 0 ? (
          <p className="mt-2 text-sm text-signal-faint">
            Nothing yet — anything you open or report shows up here with its answer.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {data.tickets.map((t) => {
              const closed = ["COMPLETED", "RESOLVED", "DISMISSED"].includes(t.status);
              return (
                <button
                  key={t.ref}
                  type="button"
                  onClick={() => setOpenRef(t.ref)}
                  className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-base-800 p-2.5 text-left hover:border-accent/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-signal">{t.subject}</span>
                    <span className="block truncate text-xs text-signal-faint">
                      {relativeTime(t.createdAt)}
                      {t.replyCount > 0 ? ` · ${t.replyCount} repl${t.replyCount === 1 ? "y" : "ies"}` : ""}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase",
                      closed ? "bg-base-700 text-signal-faint" : "bg-accent/20 text-accent",
                    )}
                  >
                    {closed ? "Closed" : "Open"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function NewTicket({ onDone }: { onDone: () => void }) {
  const open = useOpenSupportTicket();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-base-800 p-3">
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value.slice(0, 200))}
        placeholder="What's it about?"
        autoFocus
        className="w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="Tell us what happened. Anything you can add about when it started helps."
        className="w-full rounded-lg border border-hairline bg-base-700 p-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!subject.trim() || !body.trim() || open.isPending}
          onClick={() =>
            open.mutate({ subject: subject.trim(), body: body.trim() }, { onSuccess: onDone })
          }
          className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {open.isPending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function SupportThread({ refId, onBack }: { refId: string; onBack: () => void }) {
  const { data, isLoading } = useMyTicket(refId);
  const reply = useReplyToMyTicket();
  const [body, setBody] = useState("");

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
      </div>
    );
  }

  const closed = ["COMPLETED", "RESOLVED", "DISMISSED"].includes(data.status);

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start text-sm text-signal-dim hover:text-signal"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Back
      </button>

      <div>
        <h3 className="text-sm font-medium text-signal">{data.subject}</h3>
        <p className="text-xs text-signal-faint">Opened {relativeTime(data.createdAt)}</p>
      </div>

      <div className="space-y-2">
        {data.messages.map((m) => (
          <div key={m.id} className={cn("flex gap-2", m.fromStaff ? "" : "flex-row-reverse")}>
            <UserAvatar
              avatarUrl={m.author?.avatarUrl ?? null}
              name={m.author?.displayName ?? m.author?.username ?? "Lumina"}
              size={24}
            />
            <div
              className={cn(
                "max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm",
                m.fromStaff ? "bg-base-800 text-signal" : "bg-accent/20 text-signal",
              )}
            >
              <div className="mb-0.5 text-[0.6rem] uppercase text-signal-faint">
                {m.fromStaff ? "Lumina support" : "You"} · {relativeTime(m.createdAt)}
              </div>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
            </div>
          </div>
        ))}
      </div>

      {closed ? (
        <p className="rounded-lg bg-base-800 p-2 text-xs text-signal-faint">
          This ticket is closed. Open a new one if you still need help.
        </p>
      ) : (
        <div className="space-y-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="Reply…"
            className="w-full rounded-lg border border-hairline bg-base-700 p-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            disabled={!body.trim() || reply.isPending}
            onClick={() =>
              reply.mutate({ ref: refId, body: body.trim() }, { onSuccess: () => setBody("") })
            }
            className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Send
          </button>
        </div>
      )}
    </div>
  );
}
