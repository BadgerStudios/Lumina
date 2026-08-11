import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { UserPlus, Check, X, MessageCircle, UserMinus, ShieldOff, ShieldCheck } from "lucide-react";
import {
  useFriends,
  useFriendRequests,
  useSendFriendRequest,
  useRespondToFriendRequest,
  useRemoveFriend,
  useBlockedUsers,
  useBlockUser,
  useUnblockUser,
} from "../../queries/friends";
import { useCreateDM } from "../../queries/dms";
import { UserAvatar } from "../common/UserAvatar";
import { ApiError } from "../../lib/apiClient";
import { reportError } from "../../store/toastStore";
import { cn } from "../../lib/cn";
import { UserSearchInput } from "../common/UserSearchInput";
import { SuggestionsPanel } from "./SuggestionsPanel";

type Tab = "all" | "pending" | "suggested" | "blocked" | "add";

/** Rendered by FriendsRoute.tsx (top-level /friends route) — mirrors DMRoute.tsx's layout
 * (DMSidebar + main pane), same as every other primary content area in the app. */
export function FriendsPane() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<Tab>(
    initialTab === "pending" || initialTab === "blocked" || initialTab === "add" || initialTab === "suggested"
      ? initialTab
      : "all",
  );
  const { data: friends } = useFriends();
  const { data: requests } = useFriendRequests();
  const { data: blocked } = useBlockedUsers(tab === "blocked");
  const sendRequest = useSendFriendRequest();
  const respond = useRespondToFriendRequest();
  const removeFriend = useRemoveFriend();
  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const createDM = useCreateDM();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  const pendingCount = requests?.incoming.length ?? 0;

  // Takes the name explicitly rather than reading it from state: the typeahead calls this in the
  // same tick as setUsername, and React state has not updated by then — reading `username` here
  // would send the PREVIOUS selection (or an empty string on the first pick).
  async function handleSend(name?: string) {
    const target = (name ?? username).trim();
    if (!target) return;
    try {
      await sendRequest.mutateAsync(target);
      setSendResult({ ok: true, message: `Friend request sent to ${target}.` });
      setUsername("");
    } catch (e) {
      setSendResult({ ok: false, message: e instanceof ApiError ? e.message : "Failed to send friend request." });
    }
  }

  async function openDM(userId: string) {
    try {
      const convo = await createDM.mutateAsync({ participantIds: [userId] });
      navigate(`/dm/${convo.id}`);
    } catch (e) {
      reportError(e, "Couldn't open a conversation with them.");
    }
  }

  function handleBlock(username: string, label: string) {
    if (confirm(`Block ${label}? They won't be able to friend or message you.`)) blockUser.mutate(username);
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "all", label: "All Friends" },
    { key: "pending", label: pendingCount > 0 ? `Pending — ${pendingCount}` : "Pending" },
    { key: "suggested", label: "Suggested" },
    { key: "blocked", label: "Blocked" },
    { key: "add", label: "Add Friend" },
  ];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-base-700">
      {/* Scrolls sideways rather than wrapping. Five tabs do not fit across a 390px phone, and the
          previous fixed row both clipped "Add Friend" off the right edge and broke "All Friends"
          onto two lines inside a row with a fixed height. `shrink-0` + `whitespace-nowrap` on each
          button is what actually stops the wrap — without them flex compresses them instead. */}
      <div className="scrollbar-none flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-base-900/60 px-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium",
              tab === t.key ? "bg-base-600 text-signal" : "text-signal-dim hover:bg-base-700 hover:text-signal",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Capped and centred: at full desktop width a friend row stretched ~1200px, stranding the
          message/remove/block buttons at the far right of the screen with an ocean of empty space
          between them and the name they act on. */}
      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-4">
        {tab === "all" && (
          <div className="flex flex-col gap-1">
            {friends?.length ? (
              friends.map((f) => (
                <div key={f.user.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-600">
                  <UserAvatar avatarUrl={f.user.avatarUrl} name={f.user.displayName ?? f.user.username} size={36} presence={f.user.presence} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-signal">{f.user.displayName ?? f.user.username}</div>
                    <div className="truncate text-xs text-signal-faint">@{f.user.username}</div>
                  </div>
                  <button onClick={() => void openDM(f.user.id)} className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-500 hover:text-signal" title="Message">
                    <MessageCircle size={16} />
                  </button>
                  <button
                    onClick={() => confirm(`Remove ${f.user.displayName ?? f.user.username} as a friend?`) && removeFriend.mutate(f.user.id)}
                    className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-500 hover:text-dnd"
                    title="Remove friend"
                  >
                    <UserMinus size={16} />
                  </button>
                  <button
                    onClick={() => handleBlock(f.user.username, f.user.displayName ?? f.user.username)}
                    className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-500 hover:text-dnd"
                    title="Block"
                  >
                    <ShieldOff size={16} />
                  </button>
                </div>
              ))
            ) : (
              <p className="text-sm text-signal-faint">No friends yet — add one from the "Add Friend" tab.</p>
            )}
          </div>
        )}

        {tab === "pending" && (
          <div className="flex flex-col gap-4">
            <div>
              <span className="text-xs font-bold uppercase text-signal-dim">Incoming</span>
              <div className="mt-1.5 flex flex-col gap-1">
                {requests?.incoming.length ? (
                  requests.incoming.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-600">
                      <UserAvatar avatarUrl={r.requester.avatarUrl} name={r.requester.displayName ?? r.requester.username} size={32} />
                      <span className="min-w-0 flex-1 truncate text-sm text-signal">{r.requester.displayName ?? r.requester.username}</span>
                      <button onClick={() => respond.mutate({ requestId: r.id, accept: true })} className="shrink-0 rounded p-1.5 text-online hover:bg-base-500" title="Accept">
                        <Check size={16} />
                      </button>
                      <button onClick={() => respond.mutate({ requestId: r.id, accept: false })} className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-500 hover:text-dnd" title="Decline">
                        <X size={16} />
                      </button>
                      <button
                        onClick={() => handleBlock(r.requester.username, r.requester.displayName ?? r.requester.username)}
                        className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-500 hover:text-dnd"
                        title="Block"
                      >
                        <ShieldOff size={16} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-signal-faint">No incoming requests.</p>
                )}
              </div>
            </div>
            <div>
              <span className="text-xs font-bold uppercase text-signal-dim">Outgoing</span>
              <div className="mt-1.5 flex flex-col gap-1">
                {requests?.outgoing.length ? (
                  requests.outgoing.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-600">
                      <UserAvatar avatarUrl={r.addressee.avatarUrl} name={r.addressee.displayName ?? r.addressee.username} size={32} />
                      <span className="min-w-0 flex-1 truncate text-sm text-signal">{r.addressee.displayName ?? r.addressee.username}</span>
                      <button onClick={() => respond.mutate({ requestId: r.id, accept: false })} className="shrink-0 text-xs text-signal-faint hover:text-dnd hover:underline">
                        Cancel
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-signal-faint">No outgoing requests.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "suggested" && <SuggestionsPanel />}

        {tab === "blocked" && (
          <div className="flex flex-col gap-1">
            {blocked?.length ? (
              blocked.map((b) => (
                <div key={b.user.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-600">
                  <UserAvatar avatarUrl={b.user.avatarUrl} name={b.user.displayName ?? b.user.username} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-signal">{b.user.displayName ?? b.user.username}</div>
                    <div className="truncate text-xs text-signal-faint">@{b.user.username}</div>
                  </div>
                  <button
                    onClick={() => unblockUser.mutate(b.user.id)}
                    className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-signal-dim hover:bg-base-500 hover:text-signal"
                    title="Unblock"
                  >
                    <ShieldCheck size={14} /> Unblock
                  </button>
                </div>
              ))
            ) : (
              <p className="text-sm text-signal-faint">No blocked users.</p>
            )}
          </div>
        )}

        {tab === "add" && (
          <div className="max-w-sm">
            <span className="text-xs font-bold uppercase text-signal-dim">Add a friend</span>
            {/* Typeahead rather than an exact-username box: previously you had to already know
                someone's username character-for-character, with a failed request as the only
                feedback that you'd got it wrong. */}
            <div className="mt-1.5">
              <UserSearchInput
                placeholder="Search by name or username…"
                onSelect={(user) => {
                  setUsername(user.username);
                  setSendResult(null);
                  void handleSend(user.username);
                }}
              />
            </div>
            {sendResult ? (
              <p className={cn("mt-2 text-sm", sendResult.ok ? "text-online" : "text-dnd")}>{sendResult.message}</p>
            ) : null}
            {/* Searching by name assumes you already know who you're looking for. This is the
                answer for when you don't. */}
            <SuggestionsPanel className="mt-5" />
          </div>
        )}
      </div>
    </div>
  );
}
