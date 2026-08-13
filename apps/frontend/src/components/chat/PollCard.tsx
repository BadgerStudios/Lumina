import { useEffect, useState } from "react";
import { BarChart3, Check } from "lucide-react";
import type { PollDTO } from "@lumina/shared";
import { useVotePoll } from "../../queries/polls";
import { cn } from "../../lib/cn";

/**
 * A poll inside a message.
 *
 * Results are always visible, including before you vote. Hiding them until you have voted is a
 * common choice and the wrong one here: it turns a casual "what do people think" into a gate, and
 * the numbers are not secret — anyone can vote, look, and retract.
 */
export function PollCard({ poll, currentUserId }: { poll: PollDTO; currentUserId: string | undefined }) {
  // Local copy so a vote lands instantly. The authoritative version arrives seconds later over
  // POLL_VOTE_UPDATE, and the effect below adopts it — including when someone *else* votes, which
  // is the case a purely-optimistic local state would never see.
  const [live, setLive] = useState(poll);
  useEffect(() => setLive(poll), [poll]);

  const vote = useVotePoll();
  const closed = live.closed;

  async function pick(optionId: string) {
    if (closed || !currentUserId) return;
    const previous = live;
    // Optimistic, and it has to model retraction as well as casting: clicking your current choice
    // takes the vote away, which a naive "add one to the option I clicked" would get backwards.
    setLive(applyLocalVote(previous, optionId));
    try {
      setLive(await vote.mutateAsync({ pollId: live.id, optionId }));
    } catch {
      setLive(previous);
    }
  }

  return (
    <div className="mt-1 max-w-md rounded-lg border border-base-500 bg-base-700/60 p-3">
      <div className="flex items-start gap-2">
        <BarChart3 size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-semibold text-signal">{live.question}</p>
          <p className="mt-0.5 text-[11px] text-signal-faint">
            {live.allowMultiple ? "Pick as many as you like" : "Pick one"}
            {closed ? " · Closed" : live.expiresAt ? ` · Closes ${new Date(live.expiresAt).toLocaleString()}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {live.options.map((option) => {
          // Guarding the divide rather than letting 0/0 render as NaN%, which is what an
          // unvoted poll would otherwise show on every option.
          const share = live.totalVotes > 0 ? Math.round((option.votes / live.totalVotes) * 100) : 0;
          return (
            <button
              key={option.id}
              type="button"
              disabled={closed || !currentUserId}
              onClick={() => void pick(option.id)}
              aria-pressed={option.votedByMe}
              className={cn(
                "relative overflow-hidden rounded border px-2.5 py-1.5 text-left text-sm transition",
                option.votedByMe ? "border-accent text-signal" : "border-base-500 text-signal-dim",
                !closed && currentUserId ? "hover:border-signal-dim" : "cursor-default",
              )}
            >
              {/* The fill is a sibling behind the text rather than a background gradient so the
                  label stays readable at any share, and aria-hidden because the percentage is
                  already announced as text. */}
              <span
                aria-hidden
                className={cn("absolute inset-y-0 left-0 transition-all", option.votedByMe ? "bg-accent/25" : "bg-base-500/40")}
                style={{ width: `${share}%` }}
              />
              <span className="relative flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  {option.votedByMe ? <Check size={13} className="shrink-0 text-accent" /> : null}
                  <span className="truncate">{option.label}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-signal-faint">
                  {share}% · {option.votes}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-signal-faint">
        {live.totalVotes} {live.totalVotes === 1 ? "vote" : "votes"}
        {!closed && currentUserId ? " · click your choice again to take it back" : ""}
      </p>
    </div>
  );
}

/**
 * The same rules the server applies, mirrored locally so the optimistic update matches what comes
 * back: clicking a chosen option retracts it, and in a single-select poll a new choice replaces the
 * old one rather than adding to it.
 */
function applyLocalVote(poll: PollDTO, optionId: string): PollDTO {
  const target = poll.options.find((o) => o.id === optionId);
  if (!target) return poll;
  const retracting = target.votedByMe;

  const options = poll.options.map((o) => {
    if (o.id === optionId) {
      return { ...o, votedByMe: !retracting, votes: o.votes + (retracting ? -1 : 1) };
    }
    if (!retracting && !poll.allowMultiple && o.votedByMe) {
      return { ...o, votedByMe: false, votes: Math.max(0, o.votes - 1) };
    }
    return o;
  });

  return { ...poll, options, totalVotes: options.reduce((sum, o) => sum + o.votes, 0) };
}
