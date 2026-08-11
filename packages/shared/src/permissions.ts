// Permission bitfield — single source of truth, imported by both backend and frontend.
// Values are bigint bit positions so the set can grow past 32/53-bit safe-integer limits.

export const Permissions = {
  VIEW_CHANNELS: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  MANAGE_MESSAGES: 1n << 2n,
  MANAGE_CHANNELS: 1n << 3n,
  MANAGE_ROLES: 1n << 4n,
  MANAGE_SERVER: 1n << 5n,
  KICK_MEMBERS: 1n << 6n,
  BAN_MEMBERS: 1n << 7n,
  CREATE_INVITE: 1n << 8n,
  MENTION_EVERYONE: 1n << 9n,
  ADD_REACTIONS: 1n << 10n,
  ATTACH_FILES: 1n << 11n,
  MANAGE_NICKNAMES: 1n << 12n,
  TIMEOUT_MEMBERS: 1n << 13n,
  VIEW_AUDIT_LOG: 1n << 14n,
  ADMINISTRATOR: 1n << 15n,
  MANAGE_WEBHOOKS: 1n << 16n,
} as const;

export type PermissionKey = keyof typeof Permissions;

// Sensible default permission set for the implicit "@everyone" role on a new server.
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permissions.VIEW_CHANNELS |
  Permissions.SEND_MESSAGES |
  Permissions.CREATE_INVITE |
  Permissions.ADD_REACTIONS |
  Permissions.ATTACH_FILES;

// Sensible default for a server's initial "Owner"-adjacent role is just ADMINISTRATOR,
// but the owner bypasses checks entirely via ownerId comparison, so no such role is required.

export function hasPermission(effective: bigint, bit: bigint): boolean {
  if ((effective & Permissions.ADMINISTRATOR) !== 0n) return true;
  return (effective & bit) !== 0n;
}

export function combinePermissions(bits: bigint[]): bigint {
  return bits.reduce((acc, b) => acc | b, 0n);
}
