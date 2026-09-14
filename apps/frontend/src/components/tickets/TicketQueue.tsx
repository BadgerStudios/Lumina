import { useState } from "react";
import {
  Loader2,
  Flag,
  LifeBuoy,
  Cpu,
  MessageSquare,
  Clapperboard,
  Image as ImageIcon,
  User as UserIcon,
  Lock,
  Send,
  Check,
  X,
} from "lucide-react";
import {
  useTicketQueue,
  useTicket,
  useClaimTicket,
  useReleaseTicket,
  useReplyToTicket,
  useCompleteTicket,
  type TicketCard as Card,
  type TicketCategory,
  type TicketKind,
  type QueueStatus,
} from "../../queries/tickets";
import { UserAvatar } from "../common/UserAvatar";
import { useAuthStore } from "../../store/authStore";
import { relativeTime } from "../../lib/relativeTime";
import { cn } from "../../lib/cn";

/**
 * The moderator queue, and the one place a ticket is worked.
 *
 * Used by BOTH the staff suite and the owner console. That is the point: moderation used to be
 * three surfaces that did not know about each other — video reports had a queue, user and message
 * reports had routes and no UI at all, images had neither, and support requests had nowhere to go.
 * Two implementations would mean two standards and two paths into the same audit trail, so there is
 * one component and the two places that show it differ only in what they pass here.
 */

const CATEGORY_META: Record<TicketCategory, { label: string; icon: typeof Flag; className: string }> = {
  USER_REPORT: { label: "User report", icon: Flag, className: "text-flare" },
  SYSTEM_FLAGGED: { label: "System flagged", icon: Cpu, className: "text-amber" },
  CUSTOMER_SUPPORT: { label: "Support", icon: LifeBuoy, className: "text-accent" },
};

const KIND_ICON: Record<TicketKind, typeof Flag> = {
  message: MessageSquare,
  video: Clapperboard,
  image: ImageIcon,
  user: UserIcon,
  support: LifeBuoy,
};

const TABS: Array<{ key: TicketCategory | "ALL"; label: string }> = [
  { key: "ALL", label: "Everything" },
  { key: "USER_REPORT", label: "Reports" },
  { key: "CUSTOMER_SUPPORT", label: "Support" },
  { key: "SYSTEM_FLAGGED", label: "System" },
];

export function TicketQueue({ status = "ACTIVE" }: { status?: QueueStatus }) {
  const [tab, setTab] = useState<TicketCategory | "ALL">("ALL");
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useTicketQueue({
    status,
    category: tab === "ALL" ? undefined : tab,
    mine,
  });

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => {
          const count =
            t.key === "ALL" ? data?.counts.open : data?.counts.byCategory?.[t.key] ?? 0;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors",
                tab === t.key ? "bg-accent text-white" : "bg-base-700 text-signal-dim hover:text-signal",
              )}
            >
              {t.label}
              {count !== undefined && count > 0 && (
                <span className="font-mono text-xs">{count > 99 ? "99+" : count}</span>
              )}
            </button>
          );
        })}
        {/* Only shown when the queue is open work — "claimed by me" is meaningless in an archive. */}
        {status !== "CLOSED" && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-signal-dim">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Only mine
            {data && data.counts.mine > 0 ? <span className="font-mono">{data.counts.mine}</span> : null}
          </label>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
        </div>
      ) : !data || data.tickets.length === 0 ? (
        <p className="rounded-xl border border-hairline bg-base-800 p-6 text-center text-sm text-signal-faint">
          {status === "CLOSED" ? "Nothing has been closed yet." : "Nothing waiting. The queue is clear."}
        </p>
      ) : (
        <div className="space-y-2">
          {data.tickets.map((ticket) => (
            <TicketRow
              key={ticket.ref}
              ticket={ticket}
              expanded={open === ticket.ref}
              onToggle={() => setOpen(open === ticket.ref ? null : ticket.ref)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One ticket as a card.
 *
 * The avatar is the anchor, because every one of these is ultimately about a person — who reported
 * it, or who asked for help. The category chip is next to the subject rather than tucked in a
 * corner: which of the three kinds this is changes how you read everything else on the card.
 */
function TicketRow({
  ticket,
  expanded,
  onToggle,
}: {
  ticket: Card;
  expanded: boolean;
  onToggle: () => void;
}) {
  const me = useAuthStore((s) => s.user);
  const meta = CATEGORY_META[ticket.category];
  const KindIcon = KIND_ICON[ticket.kind];
  const claim = useClaimTicket();
  const release = useReleaseTicket();
  const claimedByMe = ticket.assignedTo?.id === me?.id;
  const claimedByOther = Boolean(ticket.assignedTo) && !claimedByMe;
  const closed = ["COMPLETED", "RESOLVED", "DISMISSED"].includes(ticket.status);

  return (
    <div
      className={cn(
        "rounded-xl border bg-base-800",
        expanded ? "border-accent/50" : "border-hairline",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-expanded={expanded}
      >
        <UserAvatar
          avatarUrl={ticket.person?.avatarUrl ?? null}
          name={ticket.person?.displayName ?? ticket.person?.username ?? "Lumina"}
          size={36}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("flex items-center gap-1 text-[0.65rem] font-bold uppercase", meta.className)}>
              <meta.icon className="h-3 w-3" aria-hidden="true" />
              {meta.label}
            </span>
            <span className="flex items-center gap-1 text-[0.65rem] uppercase text-signal-faint">
              <KindIcon className="h-3 w-3" aria-hidden="true" />
              {ticket.kind}
            </span>
            {closed && (
              <span className="text-[0.65rem] uppercase text-signal-faint">{ticket.status.toLowerCase()}</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-sm text-signal">{ticket.subject}</span>
          <span className="mt-0.5 block truncate text-xs text-signal-faint">
            {ticket.person ? `${ticket.person.displayName ?? ticket.person.username}` : "Raised by Lumina"}
            {ticket.about ? ` · about ${ticket.about.displayName ?? ticket.about.username}` : ""}
            {" · "}
            {relativeTime(ticket.createdAt)}
            {ticket.replyCount > 0 ? ` · ${ticket.replyCount} repl${ticket.replyCount === 1 ? "y" : "ies"}` : ""}
          </span>
        </span>
        {ticket.assignedTo && (
          <span className="shrink-0" title={`Claimed by ${ticket.assignedTo.displayName ?? ticket.assignedTo.username}`}>
            <UserAvatar
              avatarUrl={ticket.assignedTo.avatarUrl}
              name={ticket.assignedTo.displayName ?? ticket.assignedTo.username}
              size={22}
            />
          </span>
        )}
      </button>

      {!expanded && !closed && (
        <div className="flex gap-2 border-t border-hairline px-3 py-2">
          {claimedByMe ? (
            <button
              type="button"
              onClick={() => release.mutate({ ref: ticket.ref })}
              disabled={release.isPending}
              className="rounded-lg bg-base-600 px-3 py-1 text-xs text-signal disabled:opacity-50"
            >
              Release
            </button>
          ) : (
            <button
              type="button"
              onClick={() => claim.mutate({ ref: ticket.ref })}
              disabled={claim.isPending || claimedByOther}
              title={claimedByOther ? "Someone else is already on this" : undefined}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {claimedByOther ? `Claimed by ${ticket.assignedTo?.displayName ?? ticket.assignedTo?.username}` : "Claim"}
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="rounded-lg bg-base-600 px-3 py-1 text-xs text-signal"
          >
            Open
          </button>
        </div>
      )}

      {expanded && <TicketConversation refId={ticket.ref} onClose={onToggle} />}
    </div>
  );
}

/**
 * Both sides of a ticket, and the decision at the end of it.
 *
 * Staff messages sit right and the reporter's sit left, the way any conversation is read. Internal
 * notes are marked and tinted because the difference between "the reporter will see this" and "only
 * we will" is the one mistake on this screen that cannot be taken back.
 */
export function TicketConversation({ refId, onClose }: { refId: string; onClose?: () => void }) {
  const { data, isLoading } = useTicket(refId);
  const me = useAuthStore((s) => s.user);
  const reply = useReplyToTicket();
  const claim = useClaimTicket();
  const complete = useCompleteTicket();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [closing, setClosing] = useState<"COMPLETED" | "DISMISSED" | null>(null);
  const [note, setNote] = useState("");

  if (isLoading || !data) {
    return (
      <div className="flex justify-center border-t border-hairline py-8">
        <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
      </div>
    );
  }

  const closed = ["COMPLETED", "RESOLVED", "DISMISSED"].includes(data.status);
  const claimedByMe = data.assignedTo?.id === me?.id;

  return (
    <div className="border-t border-hairline p-3">
      {data.detail && (
        <p className="mb-3 rounded-lg bg-base-900 p-2 text-sm text-signal-dim">{data.detail}</p>
      )}

      <div className="mb-3 space-y-2">
        {data.messages.length === 0 ? (
          <p className="text-xs text-signal-faint">Nothing said yet.</p>
        ) : (
          data.messages.map((m) => (
            <div key={m.id} className={cn("flex gap-2", m.fromStaff ? "flex-row-reverse" : "")}>
              <UserAvatar
                avatarUrl={m.author?.avatarUrl ?? null}
                name={m.author?.displayName ?? m.author?.username ?? "Lumina"}
                size={24}
              />
              <div
                className={cn(
                  "max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm",
                  m.internal
                    ? "border border-amber/40 bg-amber/10 text-signal-dim"
                    : m.fromStaff
                      ? "bg-accent/20 text-signal"
                      : "bg-base-900 text-signal",
                )}
              >
                <div className="mb-0.5 flex items-center gap-1.5 text-[0.6rem] uppercase text-signal-faint">
                  {m.internal && <Lock className="h-2.5 w-2.5" aria-hidden="true" />}
                  {m.internal ? "Internal note" : m.author?.displayName ?? m.author?.username ?? "Lumina"}
                  <span>· {relativeTime(m.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            </div>
          ))
        )}
      </div>

      {!closed && (
        <>
          {!claimedByMe && !data.assignedTo && (
            <button
              type="button"
              onClick={() => claim.mutate({ ref: refId })}
              disabled={claim.isPending}
              className="mb-2 w-full rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Claim this ticket to reply
            </button>
          )}

          <div className="space-y-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={internal ? "A note for other staff…" : "Reply to them…"}
              className="w-full rounded-lg border border-hairline bg-base-700 p-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-signal-dim">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber"
                />
                <Lock className="h-3 w-3" aria-hidden="true" />
                Internal note
              </label>
              <button
                type="button"
                disabled={!body.trim() || reply.isPending}
                onClick={() =>
                  reply.mutate(
                    { ref: refId, body: body.trim(), internal },
                    { onSuccess: () => setBody("") },
                  )
                }
                className="ml-auto flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                Send
              </button>
            </div>
          </div>

          {closing ? (
            <div className="mt-3 space-y-2 rounded-lg border border-hairline p-2">
              <p className="text-xs text-signal-dim">
                {closing === "COMPLETED"
                  ? "What was done? This is sent back to whoever filed it."
                  : "Why is this being dismissed? This is sent back to whoever filed it."}
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                autoFocus
                className="w-full rounded-lg border border-hairline bg-base-700 p-2 text-sm text-signal focus:border-accent focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setClosing(null)}
                  className="flex-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!note.trim() || complete.isPending}
                  onClick={() =>
                    complete.mutate(
                      { ref: refId, outcome: closing, note: note.trim() },
                      { onSuccess: () => { setClosing(null); setNote(""); onClose?.(); } },
                    )
                  }
                  className="flex-1 rounded-lg bg-pulse px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setClosing("COMPLETED")}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal hover:bg-pulse hover:text-black"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Resolve
              </button>
              <button
                type="button"
                onClick={() => setClosing("DISMISSED")}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal hover:bg-flare hover:text-white"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Dismiss
              </button>
            </div>
          )}
        </>
      )}

      {closed && data.resolutionNote && (
        <p className="rounded-lg bg-base-900 p-2 text-xs text-signal-faint">
          Closed as {data.status.toLowerCase()}: {data.resolutionNote}
        </p>
      )}
    </div>
  );
}
