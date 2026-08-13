import { randomBytes } from "node:crypto";
import { DEFAULT_EVERYONE_PERMISSIONS, Permissions } from "@lumina/shared";
import type { ServerTemplateDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { checkPermission } from "../../permissions/permissionService.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

/**
 * Server templates: a frozen copy of a server's structure, replayable into a new one.
 *
 * ## What a template does and does not carry
 *
 * Channels, categories, their order and settings, and roles with their permission bitfields. Not
 * messages, not members, not invites, not uploaded emoji/stickers/sounds, and — importantly — not
 * role *assignments*. A template describes a shape, not a population; copying who held which role
 * would mean naming accounts that have nothing to do with the new server.
 *
 * ## Why permissions are re-clamped on apply
 *
 * A snapshot stores raw permission bitfields, and one of those bits is ADMINISTRATOR. Replaying a
 * snapshot verbatim would let anyone who can create a server also mint roles with any permission
 * they liked — which is fine, because they own the new server and could grant themselves anything
 * anyway. It stops being fine if templates are ever shared: applying someone else's template must
 * not be a way to be handed a structure whose "Member" role quietly carries ADMINISTRATOR. So the
 * bits are clamped on apply, and the clamp is deliberately generous for everything except the two
 * that are not recoverable from — ADMINISTRATOR and MANAGE_SERVER.
 */

const MAX_TEMPLATE_CHANNELS = 100;
const MAX_TEMPLATE_ROLES = 50;

interface ChannelSnapshot {
  key: string;
  name: string;
  type: "TEXT" | "VOICE" | "CATEGORY";
  topic: string | null;
  position: number;
  parentKey: string | null;
  slowmodeSeconds: number;
  nsfw: boolean;
}

interface RoleSnapshot {
  name: string;
  color: number | null;
  permissions: string;
  position: number;
  isDefault: boolean;
  mentionable: boolean;
}

interface Snapshot {
  version: 1;
  channels: ChannelSnapshot[];
  roles: RoleSnapshot[];
  systemChannelKey: string | null;
}

/**
 * The permission bits a role may carry when a template is applied.
 *
 * ADMINISTRATOR is excluded because it bypasses every other check, and MANAGE_SERVER because it can
 * be used to grant ADMINISTRATOR. Everything else — including BAN_MEMBERS and MANAGE_ROLES — is
 * allowed through, because a template that cannot describe a moderator role is not much of a
 * template, and the server owner can always widen a role afterwards deliberately.
 */
const APPLY_PERMISSION_MASK = ~(Permissions.ADMINISTRATOR | Permissions.MANAGE_SERVER);

function newCode(): string {
  // 9 bytes → 18 hex chars. Long enough that codes are not guessable, short enough to paste.
  return randomBytes(9).toString("hex");
}

function summarize(snapshot: Snapshot): ServerTemplateDTO["summary"] {
  return {
    categories: snapshot.channels.filter((c) => c.type === "CATEGORY").length,
    textChannels: snapshot.channels.filter((c) => c.type === "TEXT").length,
    voiceChannels: snapshot.channels.filter((c) => c.type === "VOICE").length,
    roles: snapshot.roles.filter((r) => !r.isDefault).length,
  };
}

function parseSnapshot(raw: unknown): Snapshot {
  const snapshot = raw as Snapshot;
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.channels) || !Array.isArray(snapshot.roles)) {
    throw new BadRequestError("That template is not in a format this version understands");
  }
  return snapshot;
}

export function serializeTemplate(row: {
  code: string;
  name: string;
  description: string | null;
  creatorId: string | null;
  uses: number;
  createdAt: Date;
  snapshotJson: unknown;
}): ServerTemplateDTO {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    creatorId: row.creatorId,
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
    summary: summarize(parseSnapshot(row.snapshotJson)),
  };
}

/** Snapshots a server's current structure. Requires MANAGE_SERVER on the source. */
export async function createTemplate(params: {
  userId: string;
  serverId: string;
  name: string;
  description?: string | null;
}): Promise<ServerTemplateDTO> {
  await checkPermission(params.userId, params.serverId, Permissions.MANAGE_SERVER);

  const name = params.name.trim();
  if (!name || name.length > 100) throw new BadRequestError("A template needs a name of 100 characters or fewer");

  const [channels, roles, server] = await Promise.all([
    prisma.channel.findMany({ where: { serverId: params.serverId }, orderBy: { position: "asc" } }),
    prisma.role.findMany({ where: { serverId: params.serverId }, orderBy: { position: "asc" } }),
    prisma.server.findUnique({ where: { id: params.serverId }, select: { systemChannelId: true } }),
  ]);

  if (channels.length > MAX_TEMPLATE_CHANNELS) {
    throw new BadRequestError(`Templates can hold at most ${MAX_TEMPLATE_CHANNELS} channels`);
  }
  if (roles.length > MAX_TEMPLATE_ROLES) {
    throw new BadRequestError(`Templates can hold at most ${MAX_TEMPLATE_ROLES} roles`);
  }

  // Channels reference their parent by a snapshot-local key, never by the source server's channel
  // id. An id would be meaningless in the new server, and worse, would still resolve — to a channel
  // in a different server entirely.
  const keyById = new Map(channels.map((c, i) => [c.id, `c${i}`]));

  const snapshot: Snapshot = {
    version: 1,
    channels: channels.map((c) => ({
      key: keyById.get(c.id)!,
      name: c.name,
      type: c.type as ChannelSnapshot["type"],
      topic: c.topic,
      position: c.position,
      parentKey: c.parentId ? (keyById.get(c.parentId) ?? null) : null,
      slowmodeSeconds: c.slowmodeSeconds,
      nsfw: c.nsfw,
    })),
    // BigInt does not survive JSON, so permission bitfields are stored as decimal strings and
    // parsed back on apply. Storing them as numbers would silently lose bits above 2^53.
    roles: roles.map((r) => ({
      name: r.name,
      color: r.color,
      permissions: r.permissions.toString(),
      position: r.position,
      isDefault: r.isDefault,
      mentionable: r.mentionable,
    })),
    systemChannelKey: server?.systemChannelId ? (keyById.get(server.systemChannelId) ?? null) : null,
  };

  const created = await prisma.serverTemplate.create({
    data: {
      code: newCode(),
      name,
      description: params.description?.trim() || null,
      creatorId: params.userId,
      sourceServerId: params.serverId,
      snapshotJson: snapshot as never,
    },
  });

  return serializeTemplate(created);
}

export async function getTemplate(code: string): Promise<ServerTemplateDTO> {
  const row = await prisma.serverTemplate.findUnique({ where: { code } });
  if (!row) throw new NotFoundError("Template not found");
  return serializeTemplate(row);
}

export async function listMyTemplates(userId: string): Promise<ServerTemplateDTO[]> {
  const rows = await prisma.serverTemplate.findMany({
    where: { creatorId: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(serializeTemplate);
}

export async function deleteTemplate(params: { userId: string; code: string }): Promise<void> {
  const row = await prisma.serverTemplate.findUnique({ where: { code: params.code } });
  if (!row) throw new NotFoundError("Template not found");
  if (row.creatorId !== params.userId) throw new NotFoundError("Template not found");
  await prisma.serverTemplate.delete({ where: { code: params.code } });
}

/**
 * Creates a server from a template.
 *
 * One transaction, the same as the plain create path — a server that exists with half its channels
 * is worse than one that failed to be created, because the owner has no way to tell which half is
 * missing.
 */
export async function applyTemplate(params: {
  userId: string;
  code: string;
  name: string;
}): Promise<{ id: string }> {
  const template = await prisma.serverTemplate.findUnique({ where: { code: params.code } });
  if (!template) throw new NotFoundError("Template not found");
  const snapshot = parseSnapshot(template.snapshotJson);

  const name = params.name.trim();
  if (!name || name.length > 100) throw new BadRequestError("A server needs a name of 100 characters or fewer");

  const serverId = await prisma.$transaction(async (tx) => {
    const created = await tx.server.create({ data: { name, ownerId: params.userId } });

    // @everyone must exist exactly once. A snapshot from a server whose default role was somehow
    // duplicated, or one hand-edited to have none, would otherwise produce a server where
    // permission computation has no base to start from.
    const defaultRole = snapshot.roles.find((r) => r.isDefault);
    await tx.role.create({
      data: {
        serverId: created.id,
        name: "@everyone",
        permissions: defaultRole
          ? BigInt(defaultRole.permissions) & APPLY_PERMISSION_MASK
          : DEFAULT_EVERYONE_PERMISSIONS,
        position: 0,
        isDefault: true,
        mentionable: defaultRole?.mentionable ?? true,
      },
    });

    for (const role of snapshot.roles.filter((r) => !r.isDefault)) {
      await tx.role.create({
        data: {
          serverId: created.id,
          name: role.name.slice(0, 100),
          color: role.color,
          permissions: BigInt(role.permissions) & APPLY_PERMISSION_MASK,
          position: role.position,
          isDefault: false,
          mentionable: role.mentionable,
        },
      });
    }

    // Categories first, so a child channel's parent exists by the time it is created. Sorting by
    // type rather than trusting the snapshot's order means a hand-edited or reordered snapshot
    // cannot produce a channel whose parentKey has not been created yet.
    const idByKey = new Map<string, string>();
    const ordered = [...snapshot.channels].sort((a, b) => {
      if (a.type === "CATEGORY" && b.type !== "CATEGORY") return -1;
      if (b.type === "CATEGORY" && a.type !== "CATEGORY") return 1;
      return a.position - b.position;
    });

    for (const channel of ordered) {
      const row = await tx.channel.create({
        data: {
          serverId: created.id,
          name: channel.name.slice(0, 100),
          type: channel.type,
          topic: channel.topic,
          position: channel.position,
          parentId: channel.parentKey ? (idByKey.get(channel.parentKey) ?? null) : null,
          slowmodeSeconds: Math.max(0, Math.min(21_600, channel.slowmodeSeconds || 0)),
          nsfw: channel.nsfw === true,
        },
      });
      idByKey.set(channel.key, row.id);
    }

    await tx.membership.create({ data: { userId: params.userId, serverId: created.id } });

    const systemChannelId = snapshot.systemChannelKey ? (idByKey.get(snapshot.systemChannelKey) ?? null) : null;
    if (systemChannelId) {
      await tx.server.update({ where: { id: created.id }, data: { systemChannelId } });
    }

    await tx.serverTemplate.update({ where: { code: params.code }, data: { uses: { increment: 1 } } });

    return created.id;
  });

  return { id: serverId };
}
