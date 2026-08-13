import { useState } from "react";
import { Permissions, type PermissionKey } from "@lumina/shared";
import { Check, Minus, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { useRoles } from "../../queries/roles";
import {
  useChannelOverwrites,
  useSetChannelOverwrite,
  useClearChannelOverwrite,
  type ChannelOverwriteDTO,
} from "../../queries/channels";

/**
 * Which permissions are meaningful to set on a single channel.
 *
 * Server-scoped authority (kick, ban, manage the server, edit roles, read the audit log) is
 * deliberately absent: those actions are not performed "in" a channel, so an overwrite for them
 * would be stored, displayed, and then have no effect anywhere — worse than not offering it,
 * because an admin would reasonably believe they had restricted something.
 *
 * ADMINISTRATOR and MANAGE_SERVER are absent for a stronger reason: the backend rejects them
 * outright (see channelRoutes.ts). Granting ADMINISTRATOR in a channel would hand over the bypass
 * that skips overwrites entirely, turning a channel-scoped permission into server-wide authority.
 */
const CHANNEL_PERMISSIONS: PermissionKey[] = [
  "VIEW_CHANNELS",
  "SEND_MESSAGES",
  "MANAGE_MESSAGES",
  "MANAGE_CHANNELS",
  "ADD_REACTIONS",
  "ATTACH_FILES",
  "MENTION_EVERYONE",
  "CREATE_INVITE",
  "MANAGE_WEBHOOKS",
];

const LABELS: Partial<Record<PermissionKey, string>> = {
  VIEW_CHANNELS: "View Channel",
  SEND_MESSAGES: "Send Messages",
  MANAGE_MESSAGES: "Manage Messages",
  MANAGE_CHANNELS: "Manage Channel",
  ADD_REACTIONS: "Add Reactions",
  ATTACH_FILES: "Attach Files",
  MENTION_EVERYONE: "Mention @everyone",
  CREATE_INVITE: "Create Invite",
  MANAGE_WEBHOOKS: "Manage Webhooks",
};

type TriState = "allow" | "inherit" | "deny";

function stateOf(overwrite: ChannelOverwriteDTO | undefined, bit: bigint): TriState {
  if (!overwrite) return "inherit";
  if ((BigInt(overwrite.allow) & bit) !== 0n) return "allow";
  if ((BigInt(overwrite.deny) & bit) !== 0n) return "deny";
  return "inherit";
}

/**
 * Three-state permission grid for one channel.
 *
 * The tri-state is the substance of the feature, not decoration. A two-state checkbox can only
 * say "on" or "off", and "off" would have to mean one of two very different things: *inherit*
 * (follow the role, and keep following it if the role changes later) or *deny* (override the role
 * here, permanently). Collapsing those is how a channel silently stops being private the next
 * time someone edits a role.
 */
export function ChannelPermissionsPanel({ serverId, channelId }: { serverId: string; channelId: string }) {
  const { data: roles } = useRoles(serverId);
  const { data: overwrites } = useChannelOverwrites(channelId);
  const setOverwrite = useSetChannelOverwrite(serverId, channelId);
  const clearOverwrite = useClearChannelOverwrite(serverId, channelId);

  const sorted = [...(roles ?? [])].sort((a, b) => b.position - a.position);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const activeRoleId = selectedRoleId ?? sorted[0]?.id ?? null;
  const current = overwrites?.find((o) => o.targetType === "ROLE" && o.targetId === activeRoleId);

  const [error, setError] = useState<string | null>(null);

  async function apply(bit: bigint, next: TriState) {
    if (!activeRoleId) return;
    setError(null);
    let allow = current ? BigInt(current.allow) : 0n;
    let deny = current ? BigInt(current.deny) : 0n;

    // Clear the bit from both fields first. Setting one without clearing the other is how a bit
    // ends up allowed AND denied, which the backend rejects — and rightly, since the stored row
    // would no longer describe what the admin actually chose.
    allow &= ~bit;
    deny &= ~bit;
    if (next === "allow") allow |= bit;
    if (next === "deny") deny |= bit;

    try {
      // An overwrite with nothing set is not "inherit everything" — it is a row that exists and
      // says nothing. Deleting it keeps the stored state minimal and makes the grid's "no
      // overwrite" and "an empty overwrite" identical, as they should be.
      if (allow === 0n && deny === 0n) {
        await clearOverwrite.mutateAsync(activeRoleId);
      } else {
        await setOverwrite.mutateAsync({ targetId: activeRoleId, targetType: "ROLE", allow, deny });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that change.");
    }
  }

  if (!sorted.length) return <p className="text-sm text-signal-faint">This server has no roles yet.</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Role</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sorted.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedRoleId(r.id)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium",
                activeRoleId === r.id ? "bg-accent text-white" : "bg-base-900 text-signal-dim hover:bg-base-800",
              )}
            >
              {r.isDefault ? "@everyone" : r.name}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-signal-faint">
        Inherit follows the role's server-wide setting. Allow and deny apply only in this channel.
      </p>

      <div className="flex flex-col gap-1">
        {CHANNEL_PERMISSIONS.map((key) => {
          const bit = Permissions[key];
          const state = stateOf(current, bit);
          return (
            <div key={key} className="flex items-center justify-between gap-3 rounded bg-base-900 px-3 py-2">
              <span className="text-sm text-signal">{LABELS[key] ?? key}</span>
              <div className="flex shrink-0 overflow-hidden rounded ring-1 ring-base-600">
                {([
                  ["deny", X, "text-dnd", "Deny"],
                  ["inherit", Minus, "text-signal-dim", "Inherit"],
                  ["allow", Check, "text-online", "Allow"],
                ] as const).map(([value, Icon, tone, title]) => (
                  <button
                    key={value}
                    title={title}
                    aria-label={`${LABELS[key] ?? key}: ${title}`}
                    aria-pressed={state === value}
                    onClick={() => void apply(bit, value)}
                    className={cn(
                      "px-2.5 py-1.5",
                      state === value ? "bg-base-600" : "bg-base-800 hover:bg-base-700",
                      state === value ? tone : "text-signal-faint",
                    )}
                  >
                    <Icon size={14} />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-sm text-dnd">{error}</p>}
    </div>
  );
}
