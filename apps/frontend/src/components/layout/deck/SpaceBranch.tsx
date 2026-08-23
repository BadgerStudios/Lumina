import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bell,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  Gamepad2,
  LogOut,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  Settings,
  Trophy,
  UserPlus,
  Video,
} from "lucide-react";
import { APP_HOME } from "../../../lib/platform";
import { useChannels, useReorderChannels } from "../../../queries/channels";
import { useServer, useLeaveServer } from "../../../queries/servers";
import { useMembers } from "../../../queries/members";
import { useRoles } from "../../../queries/roles";
import { useThreads } from "../../../queries/threads";
import { useMinecraftStatus } from "../../../queries/game";
import { useVoiceRoster } from "../../../queries/voice";
import { useUnread } from "../../../queries/readState";
import { useUIStore } from "../../../store/uiStore";
import { useAuthStore } from "../../../store/authStore";
import { useVoiceStore } from "../../../store/voiceStore";
import { useActiveSelectionStore } from "../../../store/activeSelectionStore";
import { can } from "../../../lib/permissions";
import { UserAvatar } from "../../common/UserAvatar";
import { cn } from "../../../lib/cn";
import { SignalPanel } from "../SignalPanel";
import type { ChannelDTO } from "@lumina/shared";

/**
 * The rooms inside one space, rendered inline under it in the nav deck.
 *
 * Everything here was previously the whole 240px ChannelSidebar column. The behaviour is carried
 * over intact — categories, keyboard-free reordering, live voice rosters, per-channel threads, the
 * community's game-server chip — but it now hangs off a branch line under the space it belongs to
 * instead of being a separate column whose contents silently changed when you clicked an icon.
 */

/** Active threads under the channel you are currently in — only for the active channel, and only
 * when there are any. A permanent list under every channel would double the deck's height on a
 * busy space for something most people are not looking at. */
function ThreadList({ channelId }: { channelId: string }) {
  const { data: threads } = useThreads(channelId, false);
  const openThreadId = useActiveSelectionStore((s) => s.openThreadId);
  const setOpenThread = useActiveSelectionStore((s) => s.setOpenThread);
  if (!threads?.length) return null;

  return (
    <div className="lx-branch my-0.5 flex flex-col gap-px">
      {threads.map((t) => (
        <button
          key={t.id}
          onClick={() => setOpenThread(t.id)}
          data-active={openThreadId === t.id}
          className="lx-row lx-focus py-1 text-xs"
        >
          <MessagesSquare size={11} className="shrink-0 text-signal-faint" />
          <span className="min-w-0 flex-1 truncate">{t.name}</span>
          {t.messageCount > 0 && <span className="shrink-0 font-mono text-[0.6rem] text-signal-faint">{t.messageCount}</span>}
        </button>
      ))}
    </div>
  );
}

/** Live "who's on the block server" chip. Renders nothing unless the community configured an
 * address, so the other 99% of spaces pay zero pings and zero pixels. */
function MinecraftStatusChip({ serverId, configured }: { serverId: string; configured: boolean }) {
  const { data } = useMinecraftStatus(serverId, configured);
  if (!configured || !data?.configured) return null;
  return (
    <div className="my-1 flex items-center gap-1.5 rounded-lg border border-hairline bg-base-900/50 px-2 py-1 text-[11px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", data.online ? "bg-online" : "bg-signal-faint")} />
      <span className="min-w-0 flex-1 truncate text-signal-dim">{data.host}</span>
      <span className="shrink-0 font-mono text-signal-faint">
        {data.online ? `${data.playersOnline ?? 0}/${data.playersMax ?? "?"}` : "off"}
      </span>
    </div>
  );
}

function TextRoomRow({
  channel,
  active,
  unread,
  serverId,
  canManageChannels,
  onMoveUp,
  onMoveDown,
}: {
  channel: ChannelDTO;
  active: boolean;
  unread: boolean;
  serverId: string;
  canManageChannels: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const navigate = useNavigate();
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const openModalWith = useUIStore((s) => s.openModalWith);
  return (
    <div className="group relative flex items-center">
      <button
        onClick={() => {
          navigate(`/channels/${serverId}/${channel.id}`);
          closeMobileDrawer();
        }}
        data-active={active}
        data-unread={unread}
        className="lx-row lx-focus text-sm"
      >
        <span className="lx-mark" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        {unread && <span className="sr-only">(unread)</span>}
      </button>
      {canManageChannels && (
        <span className="absolute right-1 hidden items-center gap-0.5 group-hover:flex max-md:flex">
          {(onMoveUp || onMoveDown) && (
            <span className="flex flex-col">
              <button
                onClick={onMoveUp}
                disabled={!onMoveUp}
                title="Move up"
                aria-label={`Move ${channel.name} up`}
                className="rounded px-0.5 leading-none text-signal-faint hover:text-signal disabled:opacity-30"
              >
                <ChevronUp size={10} />
              </button>
              <button
                onClick={onMoveDown}
                disabled={!onMoveDown}
                title="Move down"
                aria-label={`Move ${channel.name} down`}
                className="rounded px-0.5 leading-none text-signal-faint hover:text-signal disabled:opacity-30"
              >
                <ChevronDown size={10} />
              </button>
            </span>
          )}
          <button
            onClick={() => openModalWith("channelSettings", { serverId, channelId: channel.id })}
            title={`${channel.name} settings`}
            className="rounded p-1 text-signal-faint hover:text-signal"
          >
            <Settings size={12} />
          </button>
        </span>
      )}
    </div>
  );
}

/** LIVE pill for a screen broadcast, plain camera glyph for video — the roster carries which. */
function StreamBadge({ kind }: { kind?: "screen" | "camera" | null }) {
  if (kind === "screen") {
    return (
      <span className="shrink-0 rounded bg-flare px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wide text-white">
        Live
      </span>
    );
  }
  if (kind === "camera") return <Video size={10} className="shrink-0 text-online" />;
  return null;
}

/** Shows connected participants for EVERY voice room, not just the one you're in — backed by
 * voiceStore's server-wide roster. While you're actually connected, the richer live `participants`
 * state (with speaking/mute indicators from the real WebRTC signaling) is shown instead. */
function VoiceRoomRow({ channel, serverId }: { channel: ChannelDTO; serverId: string }) {
  const user = useAuthStore((s) => s.user);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const connecting = useVoiceStore((s) => s.connecting);
  const videoSource = useVoiceStore((s) => s.videoSource);
  const participants = useVoiceStore((s) => s.participants);
  const roster = useVoiceStore((s) => s.roster[channel.id]);
  const join = useVoiceStore((s) => s.join);
  const leave = useVoiceStore((s) => s.leave);
  const isConnected = voiceChannelId === channel.id;
  const participantList = Object.values(participants);
  const occupied = (roster?.length ?? 0) > 0;
  const showRoster = !isConnected && occupied;

  return (
    <div>
      <button
        onClick={() => (isConnected ? leave() : void join(serverId, channel.id))}
        data-active={isConnected}
        data-live={occupied || isConnected}
        className="lx-row lx-focus text-sm"
      >
        <span className="lx-mark lx-mark--voice" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        {connecting && isConnected ? (
          <span className="shrink-0 font-mono text-[0.6rem] text-signal-faint">…</span>
        ) : null}
        {roster?.some((p) => p.streaming === "screen") ? (
          <span className="shrink-0 rounded bg-flare px-1 py-px font-mono text-[8px] font-bold uppercase tracking-wide text-white">
            Live
          </span>
        ) : null}
        {!isConnected && occupied ? (
          <span className="shrink-0 font-mono text-[0.6rem] text-signal-faint">{roster!.length}</span>
        ) : null}
      </button>
      {isConnected && (
        <div className="lx-branch my-0.5 flex flex-col gap-1">
          {user && (
            <div className="flex items-center gap-1.5 px-1 text-xs text-signal-dim">
              <UserAvatar avatarUrl={user.avatarUrl} name={user.displayName ?? user.username} size={18} />
              <span className="min-w-0 flex-1 truncate">{user.displayName ?? user.username}</span>
              <StreamBadge kind={videoSource} />
            </div>
          )}
          {participantList.map((p) => (
            <div
              key={p.socketId}
              className={cn(
                "flex items-center gap-1.5 rounded px-1 text-xs text-signal-dim",
                p.speaking && "ring-1 ring-online",
              )}
            >
              <UserAvatar avatarUrl={p.user.avatarUrl} name={p.user.displayName ?? p.user.username} size={18} />
              <span className="min-w-0 flex-1 truncate">{p.user.displayName ?? p.user.username}</span>
              <StreamBadge kind={roster?.find((r) => r.socketId === p.socketId)?.streaming} />
            </div>
          ))}
        </div>
      )}
      {showRoster && (
        <div className="lx-branch my-0.5 flex flex-col gap-1">
          {roster!.map((p) => (
            <div key={p.socketId} className="flex items-center gap-1.5 px-1 text-xs text-signal-dim">
              <UserAvatar avatarUrl={p.user.avatarUrl} name={p.user.displayName ?? p.user.username} size={18} />
              <span className="min-w-0 flex-1 truncate">{p.user.displayName ?? p.user.username}</span>
              <StreamBadge kind={p.streaming} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The space's overflow menu — invites, settings, leaderboard, events, games, notifications,
 * channel creation, leave. Lives on the space's own row in the deck rather than behind a header
 * that only existed while that space's column was showing.
 *
 * The wrapper in NavDeck reveals this with OPACITY rather than `display`, and deliberately: a Radix
 * popover measures its trigger to place itself, and once the menu is open the pointer is on the
 * menu, so the row is no longer hovered. With `hidden group-hover:block` the trigger became
 * `display:none` at that exact moment, floating-ui re-solved against a zero-size anchor, and the
 * menu jumped to the top-left corner of the window. */
export function SpaceMenu({ serverId }: { serverId: string }) {
  const navigate = useNavigate();
  const { data: server } = useServer(serverId);
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);
  const user = useAuthStore((s) => s.user);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const me = members?.find((m) => m.userId === user?.id);
  const canManageChannels = can("MANAGE_CHANNELS", { userId: user?.id, server, member: me, roles });
  const isOwner = server?.ownerId === user?.id;
  const leaveServer = useLeaveServer(serverId);

  const item = "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-signal outline-none data-[highlighted]:bg-base-600";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          title="Space menu"
          aria-label="Space menu"
          onClick={(e) => e.stopPropagation()}
          // Not a target while invisible — an opacity-0 button is still clickable, and this one sits
          // on top of the space row it would otherwise steal taps from.
          className="pointer-events-none rounded p-1 text-signal-faint opacity-100 group-hover:pointer-events-auto data-[state=open]:pointer-events-auto hover:text-signal max-md:pointer-events-auto"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="lx-raised z-50 w-56 p-1.5">
          <DropdownMenu.Item onSelect={() => openModalWith("invite", { serverId })} className={item}>
            <UserPlus size={15} /> Invite people
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openModalWith("serverSettings", { serverId })} className={item}>
            <Settings size={15} /> Space settings
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openModalWith("leaderboard", { serverId })} className={item}>
            <Trophy size={15} /> Leaderboard
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openModalWith("serverEvents", { serverId })} className={item}>
            <CalendarDays size={15} /> Events
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openModalWith("game", { serverId })} className={item}>
            <Gamepad2 size={15} /> Games
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openModalWith("notificationSettings", { serverId })} className={item}>
            <Bell size={15} /> Notifications
          </DropdownMenu.Item>
          {canManageChannels && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <DropdownMenu.Item onSelect={() => openModalWith("createChannel", { serverId })} className={item}>
                <Plus size={15} /> Create room
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => openModalWith("createChannel", { serverId, initialType: "CATEGORY" })}
                className={item}
              >
                <FolderPlus size={15} /> Create group
              </DropdownMenu.Item>
            </>
          )}
          {!isOwner && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <DropdownMenu.Item
                onSelect={() => {
                  if (confirm(`Leave "${server?.name}"?`)) {
                    leaveServer.mutate(undefined, { onSuccess: () => navigate(APP_HOME) });
                  }
                }}
                className={cn(item, "text-flare")}
              >
                <LogOut size={15} /> Leave space
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function SpaceBranch({ serverId }: { serverId: string }) {
  const { channelId: routeChannelId } = useParams<{ channelId?: string }>();
  const { data: server } = useServer(serverId);
  const { data: channels } = useChannels(serverId);
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);
  useVoiceRoster(serverId);
  // Same query key the Signal block above already uses, so this is a cache read rather than a
  // second request. It answers a different question though: Signal lists the rooms with activity,
  // this marks them where they actually live in the tree.
  //
  // KNOWN GAP: there is no cross-space unread endpoint — `/servers/:id/unread` is per space — so a
  // COLLAPSED space cannot show that something happened inside it without one polling query per
  // space. Adding `GET /users/me/unread` (server -> count) is the right fix and is backend work.
  const { data: unread } = useUnread(serverId);
  const unreadChannelIds = new Set((unread ?? []).map((u) => u.channelId));
  const user = useAuthStore((s) => s.user);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const reorder = useReorderChannels(serverId);

  const me = members?.find((m) => m.userId === user?.id);
  const canManageChannels = can("MANAGE_CHANNELS", { userId: user?.id, server, member: me, roles });

  const categories = (channels ?? []).filter((c) => c.type === "CATEGORY").sort((a, b) => a.position - b.position);
  const topLevel = (channels ?? [])
    .filter((c) => (c.type === "TEXT" || c.type === "VOICE") && !c.parentId)
    .sort((a, b) => a.position - b.position);
  const byParent = new Map<string, ChannelDTO[]>();
  for (const c of channels ?? []) {
    if ((c.type === "TEXT" || c.type === "VOICE") && c.parentId) {
      const list = byParent.get(c.parentId) ?? [];
      list.push(c);
      byParent.set(c.parentId, list);
    }
  }

  /**
   * Moves a room one place within its own sibling list. Up/down buttons rather than
   * drag-and-drop: dragging is awkward on a phone, which is where half this app is used, and
   * these remain the accessible fallback if dragging is added later. The whole sibling list is
   * sent with fresh positions rather than just the moved pair, so the server never has to infer
   * intent from a partial ordering.
   */
  function moveChannel(channel: ChannelDTO, direction: -1 | 1) {
    const siblings = (channel.parentId ? (byParent.get(channel.parentId) ?? []) : topLevel)
      .filter((c) => c.type !== "CATEGORY")
      .sort((a, b) => a.position - b.position);

    const index = siblings.findIndex((c) => c.id === channel.id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= siblings.length) return;

    const reordered = [...siblings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    reorder.mutate(reordered.map((c, i) => ({ id: c.id, position: i })));
  }

  function renderChannel(c: ChannelDTO, index: number, list: ChannelDTO[]) {
    return c.type === "VOICE" ? (
      <VoiceRoomRow key={c.id} channel={c} serverId={serverId} />
    ) : (
      <div key={c.id}>
        <TextRoomRow
          channel={c}
          active={c.id === routeChannelId}
          unread={c.id !== routeChannelId && unreadChannelIds.has(c.id)}
          serverId={serverId}
          canManageChannels={canManageChannels}
          onMoveUp={index > 0 ? () => moveChannel(c, -1) : undefined}
          onMoveDown={index < list.length - 1 ? () => moveChannel(c, 1) : undefined}
        />
        {c.id === routeChannelId && c.type === "TEXT" && <ThreadList channelId={c.id} />}
      </div>
    );
  }

  return (
    <div className="lx-branch mt-0.5 pb-1">
      <SignalPanel serverId={serverId} />
      <MinecraftStatusChip serverId={serverId} configured={Boolean(server?.minecraftHost)} />

      <div className="flex flex-col gap-px">{topLevel.map(renderChannel)}</div>

      {categories.map((cat) => {
        const kids = (byParent.get(cat.id) ?? []).sort((a, b) => a.position - b.position);
        const collapsed = collapsedCategories[cat.id];
        return (
          <div key={cat.id} className="mt-2">
            <button
              onClick={() => setCollapsedCategories((s) => ({ ...s, [cat.id]: !s[cat.id] }))}
              className="lx-eyebrow lx-focus flex w-full items-center gap-1 px-1.5 py-1 hover:text-signal-dim"
            >
              <ChevronDown size={10} className={cn("transition-transform", collapsed && "-rotate-90")} />
              <span className="min-w-0 truncate">{cat.name}</span>
            </button>
            {!collapsed && <div className="mt-px flex flex-col gap-px">{kids.map(renderChannel)}</div>}
          </div>
        );
      })}

      {(channels?.length ?? 0) === 0 && (
        <p className="px-2 py-1.5 text-xs text-signal-faint">No rooms yet.</p>
      )}

      {canManageChannels && (
        <button onClick={() => openModalWith("createChannel", { serverId })} className="lx-row lx-focus mt-1.5 text-sm">
          <Plus size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Add a room</span>
        </button>
      )}

    </div>
  );
}
