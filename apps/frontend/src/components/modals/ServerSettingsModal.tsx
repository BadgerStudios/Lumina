import { APP_HOME, PUBLIC_ORIGIN } from "../../lib/platform";
import { ServerAddonsPanel } from "./ServerAddonsPanel";
import { ServerBotsPanel } from "./ServerBotsPanel";
import { ServerAutoModPanel } from "./ServerAutoModPanel";
import { ServerOnboardingPanel } from "./ServerOnboardingPanel";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DoorOpen,
  Copy, Check, Trash2, Settings as SettingsIcon, ShieldCheck, Users, Smile,
  Tags, Ban, ScrollText, Webhook, ShieldAlert, Puzzle, Bot, ChevronUp, ChevronDown,
} from "lucide-react";
import type { RoleDTO } from "@lumina/shared";
import { useUIStore } from "../../store/uiStore";
import { useServer, useUpdateServer, useDeleteServer, useLeaveServer, useUploadServerIcon, useUploadServerBanner } from "../../queries/servers";
import { resolveAssetUrl } from "../../lib/apiClient";
import { useRoles, useReorderRoles } from "../../queries/roles";
import { useChannels } from "../../queries/channels";
import { useMembers } from "../../queries/members";
import { useBans, useUnbanMember, useAuditLog } from "../../queries/moderation";
import { useServerWebhooks, useCreateWebhook, useDeleteWebhook } from "../../queries/webhooks";
import { useAuthStore } from "../../store/authStore";
import { can } from "../../lib/permissions";
import { cn } from "../../lib/cn";
import { ModerationPanel, CommunityPanel } from "./ServerSettingsPanels";
import { ExpressionsSettingsPanel } from "./ExpressionsSettingsPanel";
import { ServerTemplateSection } from "./ServerTemplateSection";
import { SettingsShell, type SettingsGroup } from "./SettingsShell";

type Tab = "overview" | "onboarding" | "moderation" | "community" | "emoji" | "roles" | "bans" | "auditLog" | "webhooks" | "automod" | "addons" | "bots";

function colorToHex(color: number | null): string {
  return color === null ? "#5b7cfa" : `#${color.toString(16).padStart(6, "0")}`;
}
function hexToColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

function WebhooksTab({ serverId }: { serverId: string }) {
  const { data: channels } = useChannels(serverId);
  const { data: webhooks } = useServerWebhooks(serverId, true);
  const createWebhook = useCreateWebhook(serverId);
  const deleteWebhook = useDeleteWebhook(serverId);
  const textChannels = (channels ?? []).filter((c) => c.type === "TEXT");
  const [channelId, setChannelId] = useState("");
  const [name, setName] = useState("");
  const [justCreatedUrl, setJustCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    if (!channelId || !name.trim()) return;
    const result = await createWebhook.mutateAsync({ channelId, name: name.trim() });
    setJustCreatedUrl(`${PUBLIC_ORIGIN}/api/webhooks/${result.id}/${result.token}`);
    setName("");
  }

  function channelName(id: string): string {
    return textChannels.find((c) => c.id === id)?.name ?? "unknown-channel";
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-signal-dim">
        Webhooks let external services post messages into a channel over a plain HTTP POST — no bot account or login needed.
      </p>

      <div className="flex flex-col gap-2 rounded-lg border border-base-500 p-3">
        <span className="text-xs font-bold uppercase text-signal-dim">New webhook</span>
        <div className="flex gap-2">
          <select
            aria-label="Channel for the new webhook"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          >
            <option value="">Select a channel…</option>
            {textChannels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Webhook name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Webhook name"
            className="min-w-0 flex-1 rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={() => void handleCreate()}
            disabled={!channelId || !name.trim() || createWebhook.isPending}
            className="shrink-0 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Create
          </button>
        </div>

        {justCreatedUrl ? (
          <div className="mt-1 flex flex-col gap-1 rounded bg-base-900 p-2">
            <span className="text-xs text-signal-faint">
              Copy this URL now — it won't be shown again. POST <code>{"{ content, username?, avatarUrl? }"}</code> to it, no auth header needed.
            </span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs text-signal">{justCreatedUrl}</code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(justCreatedUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="shrink-0 text-signal-dim hover:text-signal"
              >
                {copied ? <Check size={15} className="text-online" /> : <Copy size={15} />}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        {webhooks?.length ? (
          webhooks.map((w) => (
            <div key={w.id} className="flex items-center justify-between gap-2 rounded bg-base-900 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate text-signal">{w.name}</div>
                <div className="text-xs text-signal-faint">#{channelName(w.channelId)}</div>
              </div>
              <button onClick={() => deleteWebhook.mutate(w.id)} className="shrink-0 text-signal-faint hover:text-dnd" title="Delete">
                <Trash2 size={15} />
              </button>
            </div>
          ))
        ) : (
          <p className="text-sm text-signal-faint">No webhooks in this space yet.</p>
        )}
      </div>
    </div>
  );
}

export function ServerSettingsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string; tab?: Tab } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const open = openModal === "serverSettings" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";
  const [tab, setTab] = useState<Tab>(modalPayload?.tab ?? "overview");
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Same singleton-state issue as `name` above — resets to the requested tab (or "overview")
  // every time the modal is (re)opened, rather than leaking whatever tab a previous open (for
  // possibly a different server) last landed on.
  useEffect(() => {
    if (open) setTab(modalPayload?.tab ?? "overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  const navigate = useNavigate();
  const { data: server } = useServer(open ? serverId : undefined);
  const { data: roles } = useRoles(open && tab === "roles" ? serverId : undefined);
  const { data: roleTabMembers } = useMembers(open && tab === "roles" ? serverId : undefined);
  const { data: bans } = useBans(open && tab === "bans" ? serverId : undefined);
  const { data: auditLog } = useAuditLog(open && tab === "auditLog" ? serverId : undefined);
  const updateServer = useUpdateServer(serverId);
  const uploadServerIcon = useUploadServerIcon(serverId);
  const uploadServerBanner = useUploadServerBanner(serverId);
  const deleteServer = useDeleteServer(serverId);
  const leaveServer = useLeaveServer(serverId);
  const reorderRoles = useReorderRoles(serverId);
  const unbanMember = useUnbanMember(serverId);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(server?.name ?? "");
  const [accentColor, setAccentColor] = useState<string>(colorToHex(server?.accentColor ?? null));
  // Deleting is a two-step: reveal the panel, then type the name into it. confirm() put an
  // OK button directly under the cursor of someone who had just clicked "Delete space".
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // ServerSettingsModal is a persistent singleton (mounted once for the whole app, gated by
  // `open` — see ModalRoot.tsx), so `useState(server?.name ?? "")` above only ever runs on the
  // very FIRST mount. Without this, opening it for server B after having typed (or even just
  // successfully saved) a name in server A's settings would show server A's leftover `name`
  // value — `servers need their own settings`, not whatever the modal was last showing. Resyncs
  // whenever the modal opens or the target server changes, exactly like RoleEditorModal already
  // does for its own local state (the pattern this was missing).
  useEffect(() => {
    if (open) {
      setName(server?.name ?? "");
      setAccentColor(colorToHex(server?.accentColor ?? null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId, server?.name, server?.accentColor]);

  const isOwner = server?.ownerId === currentUserId;
  const roleTabMe = roleTabMembers?.find((m) => m.userId === currentUserId);
  const canManageRoles = can("MANAGE_ROLES", { userId: currentUserId, server, member: roleTabMe, roles });

  /**
   * Moves a role one place in the list. Up/down buttons rather than drag-and-drop, the same
   * approach (and for the same reasons — no extra dependency, works with a thumb) as reordering
   * rooms. @everyone is excluded: it is pinned at position 0 and the server refuses to move it, so
   * it is left out of the movable set rather than offered and then rejected. The whole movable list
   * is renumbered and sent on every move, so the server never has to infer intent from a partial
   * ordering.
   */
  function moveRole(role: RoleDTO, direction: -1 | 1) {
    const movable = [...(roles ?? [])].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
    const index = movable.findIndex((r) => r.id === role.id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= movable.length) return;

    const reordered = [...movable];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    reorderRoles.mutate(reordered.map((r, i) => ({ id: r.id, position: reordered.length - i })));
  }

  // Grouped, with a one-line hint each: on a phone the list IS the navigation, and twelve bare
  // icons told nobody where Bans lived. Hints say what a section holds, in the words a member uses.
  const groups: SettingsGroup<Tab>[] = [
    {
      title: "Space",
      items: [
        { key: "overview", label: "Overview", icon: SettingsIcon, hint: "Name, icon, banner and theme color" },
        { key: "onboarding", label: "Onboarding", icon: DoorOpen, hint: "Welcome, rules and questions" },
        { key: "emoji", label: "Expressions", icon: Smile, hint: "Emoji, stickers and soundboard" },
        { key: "roles", label: "Roles", icon: Tags, hint: "Permissions, colors and order" },
      ],
    },
    {
      title: "Community",
      items: [
        { key: "community", label: "Community", icon: Users, hint: "Rules channel and inactive channel" },
        { key: "moderation", label: "Moderation", icon: ShieldCheck, hint: "Who and what gets scanned" },
        { key: "automod", label: "AutoMod", icon: ShieldAlert, hint: "Automatic rules for messages" },
        { key: "bans", label: "Bans", icon: Ban, hint: "Who is kept out" },
        { key: "auditLog", label: "Audit log", icon: ScrollText, hint: "Every change and who made it" },
      ],
    },
    {
      title: "Integrations",
      items: [
        { key: "webhooks", label: "Webhooks", icon: Webhook, hint: "Post here from other tools" },
        { key: "addons", label: "Addons", icon: Puzzle, hint: "Directory and installed addons" },
        { key: "bots", label: "Bots", icon: Bot, hint: "Add and manage bots" },
      ],
    },
  ];

  return (
    <SettingsShell<Tab>
      open={open}
      onOpenChange={(o) => !o && closeModal()}
      title={`${server?.name ?? "Space"} settings`}
      identity={{ name: server?.name ?? "Space", caption: "Space settings", imageUrl: server?.iconUrl ? resolveAssetUrl(server.iconUrl) : null }}
      groups={groups}
      active={tab}
      onSelect={setTab}
      // Sent to a specific section (the Bots panel does this) — land there, not on the list.
      startOnList={!modalPayload?.tab}
    >
          {tab === "overview" && (
            <div className="flex flex-col gap-4">
              <button
                onClick={() => bannerInputRef.current?.click()}
                className="group relative flex aspect-[3/1] w-full items-center justify-center overflow-hidden rounded-lg bg-base-900"
                style={
                  server?.bannerUrl
                    ? { backgroundImage: `url(${resolveAssetUrl(server.bannerUrl)})`, backgroundSize: "cover", backgroundPosition: "center" }
                    : undefined
                }
              >
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-medium text-transparent group-hover:bg-black/50 group-hover:text-white">
                  {server?.bannerUrl ? "Change banner" : "Add a banner"}
                </span>
              </button>
              <input
                ref={bannerInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadServerBanner.mutate(file);
                  e.target.value = "";
                }}
              />

              <div className="flex items-center gap-3">
                <button
                  onClick={() => iconInputRef.current?.click()}
                  className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full bg-base-900"
                  style={
                    server?.iconUrl
                      ? { backgroundImage: `url(${resolveAssetUrl(server.iconUrl)})`, backgroundSize: "cover", backgroundPosition: "center" }
                      : undefined
                  }
                >
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-[10px] font-medium text-transparent group-hover:bg-black/50 group-hover:text-white">
                    Change
                  </span>
                </button>
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadServerIcon.mutate(file);
                    e.target.value = "";
                  }}
                />
                <span className="text-xs text-signal-faint">Space icon — tap to change</span>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase text-signal-dim">Space name</span>
                <input
                  value={name || server?.name || ""}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase text-signal-dim">Space theme color</span>
                <p className="text-xs text-signal-faint">Recolors buttons and highlights for EVERY member while they're viewing this space.</p>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Space theme color"
                    type="color"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="h-8 w-14 cursor-pointer rounded bg-transparent"
                  />
                  {server?.accentColor !== null && server?.accentColor !== undefined && (
                    <button
                      onClick={() => {
                        setAccentColor(colorToHex(null));
                        updateServer.mutate({ accentColor: null });
                      }}
                      className="text-xs font-medium text-signal-dim hover:underline"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              </div>

              <button
                onClick={() =>
                  name.trim() && updateServer.mutate({ name: name.trim(), accentColor: hexToColor(accentColor) })
                }
                disabled={updateServer.isPending || !name.trim()}
                className="w-fit rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Save changes
              </button>

              <div className="mt-4 border-t border-base-900/60 pt-4">
                {isOwner ? (
                  deleteOpen ? (
                    <div className="flex flex-col gap-2 rounded-xl border border-dnd/40 bg-dnd/5 p-3">
                      <p className="text-sm text-signal">
                        Deleting <span className="font-semibold">{server?.name}</span> removes every channel,
                        role, message, membership, ban and invite in it. There is no undo and no backup.
                      </p>
                      <label className="text-xs text-signal-faint" htmlFor="confirm-server-delete">
                        Type <span className="font-mono text-signal">{server?.name}</span> to confirm
                      </label>
                      <input
                        id="confirm-server-delete"
                        value={deleteConfirm}
                        onChange={(e) => setDeleteConfirm(e.target.value)}
                        autoComplete="off"
                        className="w-full rounded border border-hairline bg-base-900 px-3 py-2 text-sm text-signal"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            deleteServer.mutate(deleteConfirm.trim(), {
                              onSuccess: () => {
                                closeModal();
                                navigate(APP_HOME);
                              },
                            })
                          }
                          disabled={deleteServer.isPending || deleteConfirm.trim() !== (server?.name ?? "").trim()}
                          className="rounded bg-dnd px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                        >
                          Delete this space
                        </button>
                        <button
                          onClick={() => {
                            setDeleteOpen(false);
                            setDeleteConfirm("");
                          }}
                          className="rounded px-3 py-1.5 text-sm text-signal-faint hover:text-signal"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteOpen(true)}
                      className="text-sm font-medium text-dnd hover:underline"
                    >
                      Delete space
                    </button>
                  )
                ) : (
                  <button
                    onClick={() => {
                      if (confirm(`Leave "${server?.name}"?`)) {
                        leaveServer.mutate(undefined, {
                          onSuccess: () => {
                            closeModal();
                            navigate(APP_HOME);
                          },
                        });
                      }
                    }}
                    className="text-sm font-medium text-dnd hover:underline"
                  >
                    Leave space
                  </button>
                )}
              </div>

              <ServerTemplateSection serverId={serverId} serverName={server?.name ?? "Server"} />
            </div>
          )}

          {tab === "onboarding" && <ServerOnboardingPanel serverId={serverId} />}
          {tab === "automod" && <ServerAutoModPanel serverId={serverId} />}
          {tab === "addons" && <ServerAddonsPanel serverId={serverId} />}
          {tab === "bots" && <ServerBotsPanel serverId={serverId} />}

          {tab === "roles" && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => openModalWith("roleEditor", { serverId, roleId: null })}
                className="mb-2 w-fit rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
              >
                + New role
              </button>
              {[...(roles ?? [])].sort((a, b) => b.position - a.position).map((role, _index, list) => {
                const movable = list.filter((r) => !r.isDefault);
                const movableIndex = movable.findIndex((r) => r.id === role.id);
                const canMoveUp = !role.isDefault && movableIndex > 0;
                const canMoveDown = !role.isDefault && movableIndex < movable.length - 1;
                return (
                  <div key={role.id} className="flex items-center gap-1 rounded bg-base-900 hover:bg-base-700">
                    <button
                      onClick={() => openModalWith("roleEditor", { serverId, roleId: role.id })}
                      className="flex flex-1 items-center justify-between px-3 py-2 text-left text-sm"
                    >
                      <span style={{ color: role.color !== null ? `#${role.color.toString(16).padStart(6, "0")}` : undefined }}>{role.name}</span>
                      <span className="text-xs text-signal-faint">pos {role.position}</span>
                    </button>
                    {canManageRoles && !role.isDefault && (
                      <span className="flex flex-col pr-2">
                        <button
                          onClick={() => moveRole(role, -1)}
                          disabled={!canMoveUp}
                          aria-label={`Move ${role.name} up`}
                          title="Move up"
                          className="rounded px-0.5 leading-none text-signal-faint hover:text-signal disabled:opacity-30"
                        >
                          <ChevronUp size={10} />
                        </button>
                        <button
                          onClick={() => moveRole(role, 1)}
                          disabled={!canMoveDown}
                          aria-label={`Move ${role.name} down`}
                          title="Move down"
                          className="rounded px-0.5 leading-none text-signal-faint hover:text-signal disabled:opacity-30"
                        >
                          <ChevronDown size={10} />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "bans" && (
            <div className="flex flex-col gap-2">
              {bans?.length ? (
                bans.map((ban) => (
                  <div key={ban.userId} className="flex items-center justify-between gap-3 rounded bg-base-900 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate text-signal">
                        {ban.user ? (ban.user.displayName ?? ban.user.username) : ban.userId}
                        {ban.user ? <span className="text-signal-faint"> @{ban.user.username}</span> : null}
                      </div>
                      {ban.reason ? <div className="text-xs text-signal-faint">{ban.reason}</div> : null}
                      {ban.bannedBy ? (
                        <div className="text-[11px] text-signal-faint">
                          Banned by {ban.bannedBy.displayName ?? ban.bannedBy.username}
                        </div>
                      ) : null}
                    </div>
                    <button onClick={() => unbanMember.mutate(ban.userId)} className="shrink-0 text-xs text-accent hover:underline">
                      Unban
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-sm text-signal-faint">No bans.</p>
              )}
            </div>
          )}

          {tab === "moderation" && server && (
            <ModerationPanel server={server} serverId={serverId} />
          )}

          {tab === "community" && server && (
            <CommunityPanel server={server} serverId={serverId} />
          )}

          {tab === "emoji" && <ExpressionsSettingsPanel serverId={serverId} />}

          {tab === "auditLog" && (
            <div className="flex flex-col gap-2">
              {auditLog?.length ? (
                auditLog.map((entry) => (
                  <div key={entry.id} className="rounded bg-base-900 px-3 py-2 text-xs text-signal-dim">
                    <div className="font-medium text-signal">{entry.actionType}</div>
                    <div className="text-signal-faint">
                      by {entry.actor ? (entry.actor.displayName ?? entry.actor.username) : "[deleted]"} ·{" "}
                      {new Date(entry.createdAt).toLocaleString()}
                      {entry.targetType ? ` · ${entry.targetType}: ${entry.targetName ?? entry.targetId}` : ""}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-signal-faint">No audit log entries.</p>
              )}
            </div>
          )}

          {tab === "webhooks" && <WebhooksTab serverId={serverId} />}
    </SettingsShell>
  );
}
