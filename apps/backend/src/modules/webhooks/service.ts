import { Permissions } from "@lumina/shared";
import type { MessageDTO, WebhookDTO, WebhookWithTokenDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { generateRefreshToken, hashRefreshToken } from "../../lib/jwt.js";
import { serializeWebhook } from "../../lib/serialize.js";
import { checkPermission, checkChannelPermission } from "../../permissions/permissionService.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";
import { createWebhookMessage } from "../messages/service.js";

export async function createWebhook(params: {
  userId: string;
  channelId: string;
  name: string;
  avatarUrl?: string | null;
}): Promise<WebhookWithTokenDTO> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId } });
  if (!channel) throw new NotFoundError("Channel not found");
  await checkChannelPermission(params.userId, channel.serverId, channel.id, Permissions.MANAGE_WEBHOOKS);

  const name = params.name.trim();
  if (!name) throw new BadRequestError("Name is required");

  const token = generateRefreshToken();
  const tokenHash = hashRefreshToken(token);
  const webhook = await prisma.webhook.create({
    data: { channelId: params.channelId, name, avatarUrl: params.avatarUrl?.trim() || null, tokenHash, creatorId: params.userId },
  });

  return { ...serializeWebhook(webhook), token };
}

export async function listChannelWebhooks(params: { userId: string; channelId: string }): Promise<WebhookDTO[]> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId } });
  if (!channel) throw new NotFoundError("Channel not found");
  await checkChannelPermission(params.userId, channel.serverId, channel.id, Permissions.MANAGE_WEBHOOKS);

  const webhooks = await prisma.webhook.findMany({ where: { channelId: params.channelId }, orderBy: { createdAt: "desc" } });
  return webhooks.map(serializeWebhook);
}

/** Lists every webhook across every channel in a server — backs the Webhooks tab in
 * ServerSettingsModal.tsx, which shows them all in one place rather than requiring the user to
 * click into each channel individually. */
export async function listServerWebhooks(params: { userId: string; serverId: string }): Promise<WebhookDTO[]> {
  await checkPermission(params.userId, params.serverId, Permissions.MANAGE_WEBHOOKS);
  const webhooks = await prisma.webhook.findMany({
    where: { channel: { serverId: params.serverId } },
    orderBy: { createdAt: "desc" },
  });
  return webhooks.map(serializeWebhook);
}

export async function deleteWebhook(params: { userId: string; webhookId: string }): Promise<void> {
  const webhook = await prisma.webhook.findUnique({ where: { id: params.webhookId }, include: { channel: true } });
  if (!webhook) throw new NotFoundError("Webhook not found");
  await checkChannelPermission(params.userId, webhook.channel.serverId, webhook.channelId, Permissions.MANAGE_WEBHOOKS);
  await prisma.webhook.delete({ where: { id: params.webhookId } });
}

/**
 * The public, unauthenticated entry point — no requireAuth preHandler anywhere near this route
 * (see routes.ts), the token in the URL IS the entire authentication, exactly like Discord's
 * incoming webhook URLs. Deliberately does NOT reuse requireAuth/Bearer/Bot header conventions:
 * a webhook token isn't tied to any account at all.
 */
export async function postToWebhook(params: {
  webhookId: string;
  token: string;
  content: string;
  username?: string;
  avatarUrl?: string;
}): Promise<MessageDTO> {
  const webhook = await prisma.webhook.findUnique({ where: { id: params.webhookId } });
  if (!webhook) throw new NotFoundError("Webhook not found");
  if (hashRefreshToken(params.token) !== webhook.tokenHash) throw new UnauthorizedError("Invalid webhook token");
  if (!params.content?.trim()) throw new BadRequestError("Message must have content");

  return createWebhookMessage({
    webhookId: webhook.id,
    channelId: webhook.channelId,
    content: params.content,
    overrideUsername: params.username?.trim() || webhook.name,
    overrideAvatarUrl: params.avatarUrl?.trim() || webhook.avatarUrl,
  });
}
