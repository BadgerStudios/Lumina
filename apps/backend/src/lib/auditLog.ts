import { prisma } from "../db/prisma.js";
import type { Prisma } from "@prisma/client";

export async function recordAuditLog(params: {
  serverId: string;
  actorId: string;
  actionType: string;
  targetId?: string | null;
  targetType?: string | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      serverId: params.serverId,
      actorId: params.actorId,
      actionType: params.actionType,
      targetId: params.targetId ?? null,
      targetType: params.targetType ?? null,
      metadata: params.metadata ?? undefined,
    },
  });
}
