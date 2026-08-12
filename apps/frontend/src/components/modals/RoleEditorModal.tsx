import { useEffect, useState } from "react";
import { Permissions, type PermissionKey } from "@lumina/shared";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateRole, useRoles, useUpdateRole, useDeleteRole } from "../../queries/roles";

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  VIEW_CHANNELS: "View Channels",
  SEND_MESSAGES: "Send Messages",
  MANAGE_MESSAGES: "Manage Messages",
  MANAGE_CHANNELS: "Manage Channels",
  MANAGE_ROLES: "Manage Roles",
  MANAGE_SERVER: "Manage Server",
  KICK_MEMBERS: "Kick Members",
  BAN_MEMBERS: "Ban Members",
  CREATE_INVITE: "Create Invite",
  MENTION_EVERYONE: "Mention @everyone",
  ADD_REACTIONS: "Add Reactions",
  ATTACH_FILES: "Attach Files",
  MANAGE_NICKNAMES: "Manage Nicknames",
  TIMEOUT_MEMBERS: "Timeout Members",
  VIEW_AUDIT_LOG: "View Audit Log",
  ADMINISTRATOR: "Administrator (grants everything)",
  MANAGE_WEBHOOKS: "Manage Webhooks",
  MANAGE_EMOJI: "Manage Emoji",
};

function colorToHex(color: number | null): string {
  return color === null ? "#99aab5" : `#${color.toString(16).padStart(6, "0")}`;
}
function hexToColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

export function RoleEditorModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string; roleId?: string | null } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "roleEditor" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";

  const { data: roles } = useRoles(open ? serverId : undefined);
  const editingRole = modalPayload?.roleId ? roles?.find((r) => r.id === modalPayload.roleId) : undefined;

  const createRole = useCreateRole(serverId);
  const updateRole = useUpdateRole(serverId);
  const deleteRole = useDeleteRole(serverId);

  const [name, setName] = useState("New Role");
  const [color, setColor] = useState("#99aab5");
  const [mentionable, setMentionable] = useState(true);
  const [bits, setBits] = useState<bigint>(0n);

  useEffect(() => {
    if (editingRole) {
      setName(editingRole.name);
      setColor(colorToHex(editingRole.color));
      setMentionable(editingRole.mentionable);
      setBits(BigInt(editingRole.permissions));
    } else {
      setName("New Role");
      setColor("#99aab5");
      setMentionable(true);
      setBits(0n);
    }
  }, [editingRole?.id, open]);

  function toggleBit(key: PermissionKey) {
    const bit = Permissions[key];
    setBits((prev) => (prev & bit ? prev & ~bit : prev | bit));
  }

  async function handleSave() {
    if (!name.trim()) return;
    const body = { name: name.trim(), color: hexToColor(color), permissions: bits.toString(), mentionable };
    if (editingRole) {
      await updateRole.mutateAsync({ roleId: editingRole.id, ...body });
    } else {
      await createRole.mutateAsync(body);
    }
    closeModal();
  }

  async function handleDelete() {
    if (!editingRole) return;
    await deleteRole.mutateAsync(editingRole.id);
    closeModal();
  }

  const isEveryone = editingRole?.isDefault ?? false;

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title={editingRole ? `Edit Role — ${editingRole.name}` : "Create Role"} width="max-w-lg">
      <div className="flex flex-col gap-4">
        {!isEveryone && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Role name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
            />
          </label>
        )}

        <label className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase text-signal-dim">Color</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-14 cursor-pointer rounded bg-transparent" />
        </label>

        <label className="flex items-center gap-2 text-sm text-signal-dim">
          <input type="checkbox" checked={mentionable} onChange={(e) => setMentionable(e.target.checked)} />
          Anyone can @mention this role
        </label>

        <div>
          <span className="text-xs font-bold uppercase text-signal-dim">Permissions</span>
          <div className="mt-2 grid max-h-64 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {(Object.keys(Permissions) as PermissionKey[]).map((key) => (
              <label key={key} className="flex items-center gap-2 rounded px-2 py-1 text-sm text-signal-dim hover:bg-base-700">
                <input type="checkbox" checked={(bits & Permissions[key]) !== 0n} onChange={() => toggleBit(key)} />
                {PERMISSION_LABELS[key]}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        {editingRole && !isEveryone ? (
          <button onClick={() => void handleDelete()} className="text-sm text-dnd hover:underline">
            Delete role
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-3">
          <button onClick={closeModal} className="rounded px-4 py-2 text-sm font-medium text-signal-dim hover:underline">
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={createRole.isPending || updateRole.isPending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
