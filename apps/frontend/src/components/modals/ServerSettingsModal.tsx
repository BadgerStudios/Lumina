import { APP_HOME } from "../../lib/platform";
import { ServerAddonsPanel } from "./ServerAddonsPanel";
import { ServerBotsPanel } from "./ServerBotsPanel";
import { ServerAutoModPanel } from "./ServerAutoModPanel";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Copy, Check, Trash2, X, Settings as SettingsIcon, ShieldCheck, Users, Smile,
  Tags, Ban, ScrollText, Webhook, ShieldAlert, Puzzle, Bot,
} from "lucide-react";
import { useUIStore } from "../../store/uiStore";
import { useServer, useUpdateServer, useDeleteServer, useLeaveServer, useUploadServerIcon, useUploadServerBanner } from "../../queries/servers";
import { resolveAssetUrl } from "../../lib/apiClient";
import { useRoles } from "../../queries/roles";
import { useChannels } from "../../queries/channels";
import { useBans, useUnbanMember, useAuditLog } from "../../queries/moderation";
import { useServerWebhooks, useCreateWebhook, useDeleteWebhook } from "../../queries/webhooks";
import { useAuthStore } from "../../store/authStore";
import { cn } from "../../lib/cn";
import { ModerationPanel, CommunityPanel } from "./ServerSettingsPanels";
import { ExpressionsSettingsPanel } from "./ExpressionsSettingsPanel";
import { ServerTemplateSection } from "./ServerTemplateSection";

type Tab = "overview" | "moderation" | "community" | "emoji" | "roles" | "bans" | "auditLog" | "webhooks" | "automod" | "addons" | "bots";

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
    setJustCreatedUrl(`${window.location.origin}/api/webhooks/${result.id}/${result.token}`);
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
          <p className="text-sm text-signal-faint">No webhooks in this server yet.</p>
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
  const { data: bans } = useBans(open && tab === "bans" ? serverId : undefined);
  const { data: auditLog } = useAuditLog(open && tab === "auditLog" ? serverId : undefined);
  const updateServer = useUpdateServer(serverId);
  const uploadServerIcon = useUploadServerIcon(serverId);
  const uploadServerBanner = useUploadServerBanner(serverId);
  const deleteServer = useDeleteServer(serverId);
  const leaveServer = useLeaveServer(serverId);
  const unbanMember = useUnbanMember(serverId);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(server?.name ?? "");
  const [accentColor, setAccentColor] = useState<string>(colorToHex(server?.accentColor ?? null));

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

  // Icons are not decoration here — they are the entire label on a phone, where the rail
  // collapses to 64px. A tab without one would be a blank button.
  const tabs: Array<{ key: Tab; label: string; icon: typeof SettingsIcon }> = [
    { key: "overview", label: "Overview", icon: SettingsIcon },
    { key: "moderation", label: "Moderation", icon: ShieldCheck },
    { key: "community", label: "Community", icon: Users },
    { key: "emoji", label: "Expressions", icon: Smile },
    { key: "roles", label: "Roles", icon: Tags },
    { key: "bans", label: "Bans", icon: Ban },
    { key: "auditLog", label: "Audit Log", icon: ScrollText },
    { key: "webhooks", label: "Webhooks", icon: Webhook },
    { key: "automod", label: "AutoMod", icon: ShieldAlert },
    { key: "addons", label: "Addons", icon: Puzzle },
    { key: "bots", label: "Bots", icon: Bot },
  ];

  return (
    /**
     * Full-viewport, matching UserSettingsModal — NOT the shared centred `Modal` box.
     *
     * It used to be that box at `max-w-2xl` with a hardcoded `w-40` tab column inside. On a 375px
     * phone that left roughly 113px for the content, and every panel was clipped mid-word: the
     * addon directory read "Nothing installed ye", the search field "Search publishe". Nothing
     * overflowed in a way a scrollWidth check could see, because the container simply cut it off —
     * which is why this survived a responsive pass that was looking for horizontal scroll.
     */
    <Dialog.Root open={open} onOpenChange={(o) => !o && closeModal()}>
      <Dialog.Portal>
        {/* z-[55]/z-[60]: clear the app's mobile bottom nav (fixed z-50) which otherwise tied a z-50
            content and painted over the panel. Matches UserSettingsModal. */}
        <Dialog.Overlay className="fixed inset-0 z-[55] bg-black/60" />
        {/* Safe-area inset the content so it clears the device system bars (viewport-fit=cover);
            matches UserSettingsModal. */}
        <Dialog.Content
          className="fixed inset-0 z-[60] flex focus:outline-none"
          style={{
            paddingTop: "max(env(safe-area-inset-top), var(--android-safe-top, 0px))",
            paddingBottom: "max(env(safe-area-inset-bottom), var(--android-safe-bottom, 0px))",
            paddingLeft: "max(env(safe-area-inset-left), var(--android-safe-left, 0px))",
            paddingRight: "max(env(safe-area-inset-right), var(--android-safe-right, 0px))",
          }}
        >
          <Dialog.Title className="sr-only">{server?.name ?? "Server"} Settings</Dialog.Title>

          <div className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-base-900/60 bg-base-800 p-3 max-md:w-16">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                title={t.label}
                className={cn(
                  "flex items-center gap-2.5 rounded px-3 py-2 text-left text-sm font-medium max-md:justify-center max-md:px-0",
                  tab === t.key ? "bg-base-500 text-signal" : "text-signal-dim hover:bg-base-700 hover:text-signal",
                )}
              >
                <t.icon size={17} className="shrink-0" />
                <span className="truncate max-md:hidden">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col bg-base-700">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-base-900/60 px-5 py-4">
              <h1 className="min-w-0 truncate text-xl font-bold text-signal">
                {tabs.find((t) => t.key === tab)?.label}
              </h1>
              <Dialog.Close asChild>
                <button className="shrink-0 text-signal-dim hover:text-signal" aria-label="Close">
                  <X size={22} />
                </button>
              </Dialog.Close>
            </div>

            <div className="min-w-0 flex-1 overflow-y-auto p-5">
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
                <span className="text-xs text-signal-faint">Server icon — click to change</span>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase text-signal-dim">Server name</span>
                <input
                  value={name || server?.name || ""}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase text-signal-dim">Server theme color</span>
                <p className="text-xs text-signal-faint">Recolors buttons and highlights for EVERY member while they're viewing this server.</p>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Server theme colour"
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
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${server?.name}"? This cannot be undone.`)) {
                        deleteServer.mutate(undefined, {
                          onSuccess: () => {
                            closeModal();
                            navigate(APP_HOME);
                          },
                        });
                      }
                    }}
                    className="text-sm font-medium text-dnd hover:underline"
                  >
                    Delete Server
                  </button>
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
                    Leave Server
                  </button>
                )}
              </div>

              <ServerTemplateSection serverId={serverId} serverName={server?.name ?? "Server"} />
            </div>
          )}

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
              {[...(roles ?? [])].sort((a, b) => b.position - a.position).map((role) => (
                <button
                  key={role.id}
                  onClick={() => openModalWith("roleEditor", { serverId, roleId: role.id })}
                  className="flex items-center justify-between rounded bg-base-900 px-3 py-2 text-left text-sm hover:bg-base-700"
                >
                  <span style={{ color: role.color !== null ? `#${role.color.toString(16).padStart(6, "0")}` : undefined }}>{role.name}</span>
                  <span className="text-xs text-signal-faint">pos {role.position}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "bans" && (
            <div className="flex flex-col gap-2">
              {bans?.length ? (
                bans.map((ban) => (
                  <div key={ban.userId} className="flex items-center justify-between rounded bg-base-900 px-3 py-2 text-sm">
                    <div>
                      <div className="text-signal">{ban.userId}</div>
                      {ban.reason ? <div className="text-xs text-signal-faint">{ban.reason}</div> : null}
                    </div>
                    <button onClick={() => unbanMember.mutate(ban.userId)} className="text-xs text-accent hover:underline">
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
                      by {entry.actorId ?? "[deleted]"} · {new Date(entry.createdAt).toLocaleString()}
                      {entry.targetType ? ` · ${entry.targetType}:${entry.targetId}` : ""}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-signal-faint">No audit log entries.</p>
              )}
            </div>
          )}

          {tab === "webhooks" && <WebhooksTab serverId={serverId} />}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
