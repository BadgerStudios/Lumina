import { useState } from "react";
import { X, Sparkles, Copy, Check } from "lucide-react";
import { useFriendSuggestions, useDismissSuggestion } from "../../queries/friends";
import { UserAvatar } from "../common/UserAvatar";
import { FriendActionButton } from "../common/FriendActionButton";
import { toast } from "../../store/toastStore";
import { cn } from "../../lib/cn";

/**
 * "People you may know".
 *
 * The empty state here is not an afterthought — on a small instance it is what most people will
 * see, and it does the actual work. A ranking function cannot manufacture a social graph out of a
 * few dozen accounts, so when there is genuinely nothing to suggest the right answer is to help
 * someone invite a person they already know, not to pad the list with strangers. A panel of
 * plausible-looking strangers is how this kind of feature loses trust permanently.
 */
export function SuggestionsPanel({ className }: { className?: string }) {
  const { data, isLoading } = useFriendSuggestions();
  const dismiss = useDismissSuggestion();
  const [copied, setCopied] = useState(false);

  // Nothing at all while loading: a skeleton that resolves to an empty state is worse than never
  // having drawn the section, because it implies something was there and vanished.
  if (isLoading) return null;

  const suggestions = data?.suggestions ?? [];

  if (suggestions.length === 0) {
    return (
      <section className={cn("rounded-lg border border-hairline bg-base-800 p-4", className)}>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-signal">
          <Sparkles size={15} className="text-accent" /> People you may know
        </h2>
        <p className="mt-2 text-sm text-signal-dim">
          Nothing to suggest yet — suggestions come from mutual friends, shared servers and group
          chats, so they fill in as you connect with people.
        </p>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.origin);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              toast.error("Couldn't copy the link — you can copy it from the address bar.");
            }
          }}
          className="mt-3 flex items-center gap-1.5 rounded bg-base-700 px-3 py-1.5 text-sm font-medium text-signal hover:bg-base-600"
        >
          {copied ? <Check size={14} className="text-online" /> : <Copy size={14} />}
          {copied ? "Link copied" : "Invite someone to Lumina"}
        </button>
      </section>
    );
  }

  return (
    <section className={cn("rounded-lg border border-hairline bg-base-800 p-3", className)}>
      <h2 className="flex items-center gap-1.5 px-1 text-sm font-semibold text-signal">
        <Sparkles size={15} className="text-accent" /> People you may know
      </h2>
      <div className="mt-2 flex flex-col gap-0.5">
        {suggestions.map((s) => (
          <div key={s.user.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-600">
            <UserAvatar
              avatarUrl={s.user.avatarUrl}
              name={s.user.displayName ?? s.user.username}
              size={36}
              presence={s.user.presence}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-signal">
                {s.user.displayName ?? s.user.username}
              </div>
              {/* The reason is the whole reason anyone acts on a suggestion. Composed server-side
                  so the privacy rules live in one place — mutual friends are counted, never named. */}
              <div className="truncate text-xs text-signal-faint">{s.reason}</div>
            </div>
            <FriendActionButton
              userId={s.user.id}
              username={s.user.username}
              isBot={s.user.isBot}
              variant="icon"
            />
            <button
              onClick={() => dismiss.mutate(s.user.id)}
              aria-label={`Dismiss suggestion for ${s.user.username}`}
              title="Not interested"
              // Always visible below md: the Android build is a touch WebView with no hover state
              // at all, so a hover-revealed control there is simply unreachable.
              className="shrink-0 rounded p-1.5 text-signal-faint hover:bg-base-500 hover:text-signal focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
