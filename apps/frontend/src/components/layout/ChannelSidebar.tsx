import { APP_HOME } from "../../lib/platform";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Hash,
  Volume2,
  ChevronDown,
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
} from "lucide-react";
import { useState } from "react";
import { useChannels } from "../../queries/channels";
import { useServer, useLeaveServer } from "../../queries/servers";
import { useMembers } from "../../queries/members";
import { useRoles } from "../../queries/roles";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { useVoiceStore } from "../../store/voiceStore";
import { useVoiceRoster } from "../../queries/voice";
import { can } from "../../lib/permissions";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";
import { SignalPanel } from "./SignalPanel";
import type { ChannelDTO } from "@lumina/shared";

function ChannelRow({
  channel,
  active,
  serverId,
  canManageChannels,
}: {
  channel: ChannelDTO;
  active: boolean;
  serverId: string;
  canManageChannels: boolean;
}) {
  const navigate = useNavigate();
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const openModalWith = useUIStore((s) => s.openModalWith);
  return (
    <div
      className={cn(
        "group flex w-full items-center rounded-md text-sm font-medium",
        active ? "bg-base-600 font-semibold text-signal" : "text-signal-dim hover:bg-base-600 hover:text-signal",
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
      {canManageChannels && (
        <button
          onClick={() => openModalWith("channelSettings", { serverId, channelId: channel.id })}
          title="Channel settings"
          className="mr-1 shrink-0 rounded p-1 text-signal-faint opacity-0 hover:bg-base-500 hover:text-signal group-hover:opacity-100"
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
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium",
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

  function renderChannel(c: ChannelDTO) {
    return c.type === "VOICE" ? (
      <VoiceChannelRow key={c.id} channel={c} serverId={serverId} />
    ) : (
      <ChannelRow key={c.id} channel={c} active={c.id === activeChannelId} serverId={serverId} canManageChannels={canManageChannels} />
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
            className={cn("rounded p-1.5 hover:bg-base-600", voiceMuted ? "text-dnd" : "text-signal-dim hover:text-signal", !connectedVoiceChannel && "opacity-40")}
            title={connectedVoiceChannel ? (voiceMuted ? "Unmute" : "Mute") : "Join a voice channel to mute"}
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
