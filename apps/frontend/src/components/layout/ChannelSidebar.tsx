import { APP_HOME } from "../../lib/platform";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Hash,
  Volume2,
  ChevronDown,
  ChevronUp,
  Plus,
  Settings,
  Mic,
  MicOff,
  Headphones,
  PhoneOff,
  Video,
  VideoOff,
  ScreenShare,
  ScreenShareOff,
  UserPlus,
  LogOut,
  Bell,
  MessagesSquare,
} from "lucide-react";
import { useState } from "react";
import { useChannels, useReorderChannels } from "../../queries/channels";
import { useServer, useLeaveServer } from "../../queries/servers";
import { useMembers } from "../../queries/members";
import { useRoles } from "../../queries/roles";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { useVoiceStore } from "../../store/voiceStore";
import { SoundboardButton } from "../voice/SoundboardButton";
import { useVoiceRoster } from "../../queries/voice";
import { can } from "../../lib/permissions";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";
import { SignalPanel } from "./SignalPanel";
import { useThreads } from "../../queries/threads";
import { useMinecraftStatus } from "../../queries/game";
import { useActiveSelectionStore } from "../../store/activeSelectionStore";
import type { ChannelDTO } from "@lumina/shared";

/**
 * Active threads under the channel you are currently in.
 *
 * Only for the active channel, and only when there are any — a permanent list under every channel
 * would double the sidebar's height on a busy server for something most people are not looking at.
 * This exists because the alternative discovery path (scroll the channel until you find the
 * message a thread hangs off) is not a discovery path at all.
 */
function ThreadList({ channelId }: { channelId: string }) {
  const { data: threads } = useThreads(channelId, false);
  const openThreadId = useActiveSelectionStore((s) => s.openThreadId);
  const setOpenThread = useActiveSelectionStore((s) => s.setOpenThread);
  if (!threads?.length) return null;

  return (
    <div className="mb-1 ml-5 flex flex-col gap-px border-l border-base-600 pl-2">
      {threads.map((t) => (
        <button
          key={t.id}
          onClick={() => setOpenThread(t.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs",
            openThreadId === t.id ? "bg-accent/15 font-semibold text-signal" : "text-signal-dim hover:bg-base-700/60 hover:text-signal",
          )}
        >
          <MessagesSquare size={12} className="shrink-0 text-signal-faint" />
          <span className="min-w-0 flex-1 truncate">{t.name}</span>
          {t.messageCount > 0 && <span className="shrink-0 text-signal-faint">{t.messageCount}</span>}
        </button>
      ))}
    </div>
  );
}


/** Live "who's on the block server" chip. Renders nothing unless the community configured an
 * address, so the other 99% of servers pay zero pings and zero pixels. */
function MinecraftStatusChip({ serverId, configured }: { serverId: string; configured: boolean }) {
  const { data } = useMinecraftStatus(serverId, configured);
  if (!configured || !data?.configured) return null;
  return (
    <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-lg bg-base-700/60 px-2 py-1 text-[11px]">
      <span className={cn("size-1.5 shrink-0 rounded-full", data.online ? "bg-online" : "bg-signal-faint")} />
      <span className="min-w-0 flex-1 truncate text-signal-dim">{data.host}</span>
      <span className="shrink-0 text-signal-faint">
        {data.online ? `${data.playersOnline ?? 0}/${data.playersMax ?? "?"} online` : "offline"}
      </span>
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  serverId,
  canManageChannels,
  onMoveUp,
  onMoveDown,
}: {
  channel: ChannelDTO;
  active: boolean;
  serverId: string;
  canManageChannels: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const navigate = useNavigate();
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const openModalWith = useUIStore((s) => s.openModalWith);
  return (
    <div
      className={cn(
        "group flex w-full items-center rounded-xl text-sm font-medium transition-colors",
        active
          ? "bg-accent/15 font-semibold text-signal"
          : "text-signal-dim hover:bg-base-700/60 hover:text-signal",
      )}
    >
      <button
        onClick={() => {
          navigate(`/channels/${serverId}/${channel.id}`);
          closeMobileDrawer();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
      >
        <Hash size={18} className="shrink-0 font-mono text-signal-faint" />
        <span className="truncate">{channel.name}</span>
      </button>
      {canManageChannels && (onMoveUp || onMoveDown) && (
        // Revealed on hover with the settings cog, so an ordinary member's sidebar is unchanged.
        <span className="mr-0.5 flex shrink-0 flex-col opacity-0 group-hover:opacity-100 max-md:opacity-100">
          <button
            onClick={onMoveUp}
            disabled={!onMoveUp}
            title="Move up"
            aria-label={`Move ${channel.name} up`}
            className="rounded px-1 leading-none text-signal-faint hover:text-signal disabled:opacity-30"
          >
            <ChevronUp size={11} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={!onMoveDown}
            title="Move down"
            aria-label={`Move ${channel.name} down`}
            className="rounded px-1 leading-none text-signal-faint hover:text-signal disabled:opacity-30"
          >
            <ChevronDown size={11} />
          </button>
        </span>
      )}
      {canManageChannels && (
        <button
          onClick={() => openModalWith("channelSettings", { serverId, channelId: channel.id })}
          title="Channel settings"
          className="mr-1 shrink-0 rounded p-1 text-signal-faint opacity-0 hover:bg-base-500 hover:text-signal group-hover:opacity-100 max-md:opacity-100"
        >
          <Settings size={13} />
        </button>
      )}
    </div>
  );
}

/** Shows connected participants for EVERY voice channel, not just the one you're in — backed by
 * voiceStore's `roster` (server-wide VOICE_ROSTER_UPDATE broadcasts + an initial REST snapshot,
 * see queries/voice.ts). While you're actively connected, the richer `participants` state (with
 * live `speaking`/mute indicators from the real WebRTC signaling) is shown instead for anyone
 * also in the call, since it's more detailed than the roster snapshot. */
function VoiceChannelRow({ channel, serverId }: { channel: ChannelDTO; serverId: string }) {
  const user = useAuthStore((s) => s.user);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const connecting = useVoiceStore((s) => s.connecting);
  const participants = useVoiceStore((s) => s.participants);
  const roster = useVoiceStore((s) => s.roster[channel.id]);
  const muted = useVoiceStore((s) => s.muted);
  const join = useVoiceStore((s) => s.join);
  const leave = useVoiceStore((s) => s.leave);
  const isConnected = voiceChannelId === channel.id;
  const participantList = Object.values(participants);
  const showRoster = !isConnected && roster && roster.length > 0;

  return (
    <div>
      <button
        onClick={() => (isConnected ? leave() : void join(serverId, channel.id))}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-left text-sm font-medium transition-colors",
          isConnected ? "text-online" : "text-signal-dim hover:bg-base-600 hover:text-signal",
        )}
      >
        <Volume2 size={18} className="shrink-0" />
        <span className="truncate">{channel.name}</span>
        {connecting && isConnected ? <span className="ml-auto text-[10px] text-signal-faint">Connecting…</span> : null}
        {!isConnected && roster && roster.length > 0 ? (
          <span className="ml-auto text-[10px] text-signal-faint">{roster.length}</span>
        ) : null}
      </button>
      {isConnected && (
        <div className="ml-6 flex flex-col gap-1 py-1">
          {user && (
            <div className="flex items-center gap-1.5 text-xs text-signal-dim">
              <UserAvatar avatarUrl={user.avatarUrl} name={user.displayName ?? user.username} size={20} />
              <span className="truncate">{user.displayName ?? user.username}</span>
              {muted ? <MicOff size={11} className="shrink-0 text-dnd" /> : null}
            </div>
          )}
          {participantList.map((p) => (
            <div
              key={p.socketId}
              className={cn("flex items-center gap-1.5 rounded text-xs text-signal-dim", p.speaking && "ring-2 ring-online")}
            >
              <UserAvatar avatarUrl={p.user.avatarUrl} name={p.user.displayName ?? p.user.username} size={20} />
              <span className="truncate">{p.user.displayName ?? p.user.username}</span>
            </div>
          ))}
        </div>
      )}
      {showRoster && (
        <div className="ml-6 flex flex-col gap-1 py-1">
          {roster.map((p) => (
            <div key={p.socketId} className="flex items-center gap-1.5 text-xs text-signal-dim">
              <UserAvatar avatarUrl={p.user.avatarUrl} name={p.user.displayName ?? p.user.username} size={20} />
              <span className="truncate">{p.user.displayName ?? p.user.username}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChannelSidebar({ serverId, activeChannelId }: { serverId: string; activeChannelId: string | undefined }) {
  const navigate = useNavigate();
  const { data: server } = useServer(serverId);
  const { data: channels } = useChannels(serverId);
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);
  useVoiceRoster(serverId);
  const user = useAuthStore((s) => s.user);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const micMode = useVoiceStore((s) => s.micMode);
  const transmitting = useVoiceStore((s) => s.transmitting);
  /** Push-to-talk and voice activity both gate the mic behind something other than the mute
   * button; open-mic does not, and its indicator should stay exactly as it was. */
  const gatedMic = micMode !== "open";
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const videoSource = useVoiceStore((s) => s.videoSource);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
  const leaveVoice = useVoiceStore((s) => s.leave);
  const connectedVoiceChannel = channels?.find((c) => c.id === voiceChannelId);

  const me = members?.find((m) => m.userId === user?.id);
  const canManageChannels = can("MANAGE_CHANNELS", { userId: user?.id, server, member: me, roles });
  const reorder = useReorderChannels(serverId);
  const isOwner = server?.ownerId === user?.id;
  const leaveServer = useLeaveServer(serverId);
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const isMobileOpen = mobileDrawer === "channels";

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
   * Moves a channel one place within its own sibling list.
   *
   * Up/down buttons rather than drag-and-drop, deliberately. `PATCH /servers/:id/channels/reorder`
   * has existed and been enforced since it was written with **nothing calling it** — channels
   * simply could not be reordered. Drag-and-drop is the nicer interaction and a much larger piece
   * of work (pointer sensors, a drop indicator, keyboard equivalents for accessibility, and it is
   * awkward on a phone, which is where half this app is used). Two buttons make the feature exist
   * today and remain the accessible fallback if dragging is added later.
   *
   * The whole sibling list is sent with fresh positions rather than just the moved pair, so the
   * server never has to infer intent from a partial ordering.
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
      <VoiceChannelRow key={c.id} channel={c} serverId={serverId} />
    ) : (
      <div key={c.id}>
        <ChannelRow
          channel={c}
          active={c.id === activeChannelId}
          serverId={serverId}
          canManageChannels={canManageChannels}
          onMoveUp={index > 0 ? () => moveChannel(c, -1) : undefined}
          onMoveDown={index < list.length - 1 ? () => moveChannel(c, 1) : undefined}
        />
        {c.id === activeChannelId && c.type === "TEXT" && <ThreadList channelId={c.id} />}
      </div>
    );
  }

  return (
    <>
      {isMobileOpen && (
        <div className="mobile-drawer-backdrop fixed inset-0 z-30 md:hidden" onClick={closeMobileDrawer} />
      )}
      <div
        className={cn(
          "h-full w-60 shrink-0 flex-col bg-base-800 md:flex",
          isMobileOpen ? "fixed inset-y-0 left-[72px] z-40 flex shadow-2xl" : "hidden",
        )}
      >
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex h-12 shrink-0 items-center justify-between border-b border-base-900/60 px-4 font-semibold text-signal shadow-sm hover:bg-base-600">
            <span className="truncate">{server?.name ?? "Loading…"}</span>
            <ChevronDown size={18} className="shrink-0 text-signal-dim" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className="z-50 w-56 rounded-md bg-base-600 p-1.5 shadow-lg">
            <DropdownMenu.Item
              onSelect={() => openModalWith("invite", { serverId })}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
            >
              <UserPlus size={16} /> Invite People
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => openModalWith("serverSettings", { serverId })}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
            >
              <Settings size={16} /> Server Settings
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => openModalWith("notificationSettings", { serverId })}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
            >
              <Bell size={16} /> Notification Settings
            </DropdownMenu.Item>
            {canManageChannels && (
              <DropdownMenu.Item
                onSelect={() => openModalWith("createChannel", { serverId })}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
              >
                <Plus size={16} /> Create Channel
              </DropdownMenu.Item>
            )}
            {!isOwner && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-base-900/60" />
                <DropdownMenu.Item
                  onSelect={() => {
                    if (confirm(`Leave "${server?.name}"?`)) leaveServer.mutate(undefined, { onSuccess: () => navigate(APP_HOME) });
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-dnd outline-none hover:bg-base-500"
                >
                  <LogOut size={16} /> Leave Server
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <MinecraftStatusChip serverId={serverId} configured={Boolean(server?.minecraftHost)} />

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <SignalPanel serverId={serverId} />

        <div className="mb-1 flex flex-col gap-0.5">{topLevel.map(renderChannel)}</div>

        {categories.map((cat) => {
          const kids = (byParent.get(cat.id) ?? []).sort((a, b) => a.position - b.position);
          const collapsed = collapsedCategories[cat.id];
          return (
            <div key={cat.id} className="mt-3">
              <button
                onClick={() => setCollapsedCategories((s) => ({ ...s, [cat.id]: !s[cat.id] }))}
                className="flex w-full items-center gap-1 px-1 py-1 text-xs font-bold uppercase tracking-wide text-signal-dim hover:text-signal"
              >
                <ChevronDown size={12} className={cn("transition-transform", collapsed && "-rotate-90")} />
                {cat.name}
              </button>
              {!collapsed && <div className="mt-0.5 flex flex-col gap-0.5">{kids.map(renderChannel)}</div>}
            </div>
          );
        })}

        {canManageChannels && (
          <button
            onClick={() => openModalWith("createChannel", { serverId })}
            className="mt-3 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm font-medium text-signal-dim hover:bg-base-600 hover:text-signal"
          >
            <Plus size={16} /> Add channel
          </button>
        )}
      </div>

      {connectedVoiceChannel && (
        <div className="flex h-11 shrink-0 items-center gap-1.5 bg-base-900 px-3 text-xs">
          <Volume2 size={14} className="shrink-0 text-online" />
          <span className="min-w-0 flex-1 truncate text-signal">Voice Connected — {connectedVoiceChannel.name}</span>
          <button
            onClick={() => void toggleCamera()}
            className={cn("shrink-0", videoSource === "camera" ? "text-online" : "text-signal-dim hover:text-signal")}
            title={videoSource === "camera" ? "Turn off camera" : "Turn on camera"}
          >
            {videoSource === "camera" ? <Video size={15} /> : <VideoOff size={15} />}
          </button>
          <button
            onClick={() => void toggleScreenShare()}
            className={cn("shrink-0", videoSource === "screen" ? "text-online" : "text-signal-dim hover:text-signal")}
            title={videoSource === "screen" ? "Stop screen share" : "Share screen"}
          >
            {videoSource === "screen" ? <ScreenShare size={15} /> : <ScreenShareOff size={15} />}
          </button>
          <SoundboardButton serverId={serverId} />
          <button onClick={() => leaveVoice()} className="shrink-0 text-signal-dim hover:text-dnd" title="Disconnect">
            <PhoneOff size={15} />
          </button>
        </div>
      )}

      {user && (
        <div className="flex h-[52px] shrink-0 items-center gap-2 bg-base-900 px-2">
          <UserAvatar avatarUrl={user.avatarUrl} name={user.displayName ?? user.username} size={32} presence={user.presence} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-signal">{user.displayName ?? user.username}</div>
            <div className="truncate text-xs text-signal-dim">{user.statusText ?? `@${user.username}`}</div>
          </div>
          <button
            onClick={toggleMute}
            disabled={!connectedVoiceChannel}
            className={cn(
              "rounded p-1.5 hover:bg-base-600",
              voiceMuted ? "text-dnd" : "text-signal-dim hover:text-signal",
              // In push-to-talk or voice-activity mode the gate, not the mute button, decides
              // whether audio is going out — so the button has to show the gate. Without this
              // there is no feedback anywhere that push-to-talk is working, and the honest
              // reading of a plain mic icon is "you are being heard", which is wrong most of
              // the time in these modes.
              !voiceMuted && gatedMic && (transmitting ? "text-online" : "text-signal-faint"),
              !connectedVoiceChannel && "opacity-40",
            )}
            title={
              !connectedVoiceChannel
                ? "Join a voice channel to mute"
                : voiceMuted
                  ? "Unmute"
                  : gatedMic
                    ? transmitting
                      ? "Transmitting"
                      : micMode === "ptt"
                        ? "Hold your push-to-talk key to speak"
                        : "Waiting for you to speak"
                    : "Mute"
            }
          >
            {voiceMuted ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
          <button
            onClick={toggleDeafen}
            disabled={!connectedVoiceChannel}
            className={cn("rounded p-1.5 hover:bg-base-600", voiceDeafened ? "text-dnd" : "text-signal-dim hover:text-signal", !connectedVoiceChannel && "opacity-40")}
            title={connectedVoiceChannel ? (voiceDeafened ? "Undeafen" : "Deafen") : "Join a voice channel to deafen"}
          >
            <Headphones size={17} />
          </button>
          <button
            onClick={() => openModalWith("userSettings")}
            className="rounded p-1.5 text-signal-dim hover:bg-base-600 hover:text-signal"
            title="User Settings"
          >
            <Settings size={17} />
          </button>
        </div>
      )}
      </div>
    </>
  );
}
