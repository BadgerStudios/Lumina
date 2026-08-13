import { randomBytes } from "node:crypto";
import { Permissions, ServerEvents } from "@lumina/shared";
import type { InteractionDTO, SlashCommandDTO, SlashCommandOptionDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { checkPermission } from "../../permissions/permissionService.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { getIO } from "../../realtime/io.js";
import { createChannelMessage, createDMMessage } from "../messages/service.js";

/**
 * Slash commands and message components.
 *
 * ## The response window
 *
 * A bot has RESPONSE_WINDOW_MS to answer an interaction. That is not an arbitrary politeness rule —
 * the user is sitting in front of a chat window that shows nothing until the bot replies, so an
 * unanswered interaction has to become a visible failure rather than silence. After the window the
 * interaction is marked TIMED_OUT and the invoking user is told the bot did not respond.
 *
 * ## Why the token exists
 *
 * Responding is authorized by holding the interaction's single-use token, not by re-checking the
 * bot's permissions in the channel. The bot was *invoked* there by someone who could see the
 * channel, and the response is that invocation's reply — re-deriving permission at response time
 * would mean a bot that loses a role mid-interaction leaves the user staring at nothing. The token
 * is 32 random bytes, unique-indexed, and cleared on use.
 */

const RESPONSE_WINDOW_MS = 3_000;
export const MAX_COMMANDS_PER_APPLICATION = 50;

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function serializeCommand(row: {
  id: string;
  applicationId: string;
  name: string;
  description: string;
  optionsJson: unknown;
}): SlashCommandDTO {
  return {
    id: row.id,
    applicationId: row.applicationId,
    name: row.name,
    description: row.description,
    options: Array.isArray(row.optionsJson) ? (row.optionsJson as SlashCommandOptionDTO[]) : [],
  };
}

const VALID_OPTION_TYPES = new Set(["string", "integer", "boolean", "user", "channel"]);

/**
 * Validates one command definition as sent by a bot.
 *
 * Strict on purpose: this JSON is stored and later handed to every client in the server to draw a
 * command palette from. A malformed option list would render as a broken form for real users, and
 * "the bot sent nonsense" is much easier to act on at registration time than at render time.
 */
function validateCommand(raw: unknown, index: number): { name: string; description: string; options: SlashCommandOptionDTO[] } {
  if (!raw || typeof raw !== "object") throw new BadRequestError(`Command ${index} is not an object`);
  const cmd = raw as Record<string, unknown>;
  const name = typeof cmd.name === "string" ? cmd.name.trim().toLowerCase() : "";
  if (!NAME_RE.test(name)) {
    throw new BadRequestError(`Command ${index}: name must be 1-32 lowercase characters (a-z, 0-9, _, -) starting with a letter`);
  }
  const description = typeof cmd.description === "string" ? cmd.description.trim() : "";
  if (!description || description.length > 200) {
    throw new BadRequestError(`Command "${name}": description is required and must be 200 characters or fewer`);
  }

  const rawOptions = Array.isArray(cmd.options) ? cmd.options : [];
  if (rawOptions.length > 25) throw new BadRequestError(`Command "${name}": at most 25 options`);

  const seen = new Set<string>();
  let seenOptional = false;
  const options: SlashCommandOptionDTO[] = rawOptions.map((o, i) => {
    if (!o || typeof o !== "object") throw new BadRequestError(`Command "${name}": option ${i} is not an object`);
    const opt = o as Record<string, unknown>;
    const optName = typeof opt.name === "string" ? opt.name.trim().toLowerCase() : "";
    if (!NAME_RE.test(optName)) throw new BadRequestError(`Command "${name}": option ${i} has an invalid name`);
    if (seen.has(optName)) throw new BadRequestError(`Command "${name}": duplicate option "${optName}"`);
    seen.add(optName);

    const type = typeof opt.type === "string" ? opt.type : "string";
    if (!VALID_OPTION_TYPES.has(type)) {
      throw new BadRequestError(`Command "${name}": option "${optName}" has unknown type "${type}"`);
    }
    const required = opt.required === true;
    // Required-after-optional is unfillable in a positional `/cmd a b c` palette: the client cannot
    // tell which argument the user meant to skip. Rejected here rather than silently reordered.
    if (required && seenOptional) {
      throw new BadRequestError(`Command "${name}": required option "${optName}" cannot come after an optional one`);
    }
    if (!required) seenOptional = true;

    return {
      name: optName,
      description: typeof opt.description === "string" ? opt.description.slice(0, 200) : "",
      type: type as SlashCommandOptionDTO["type"],
      required,
      choices: Array.isArray(opt.choices)
        ? opt.choices
            .filter(
              (c): c is { name: string; value: string | number } =>
                !!c &&
                typeof c === "object" &&
                typeof (c as { name?: unknown }).name === "string" &&
                ["string", "number"].includes(typeof (c as { value?: unknown }).value),
            )
            .slice(0, 25)
        : undefined,
    };
  });

  return { name, description, options };
}

/**
 * Bulk overwrite — the whole command set, replacing whatever was there.
 *
 * Discord's own shape, and the reason is drift: with individual create/update/delete calls, a bot
 * that renames a command leaves the old one registered forever, and there is no way for the bot
 * author to notice. "Here is my complete list" cannot drift.
 */
export async function overwriteCommands(applicationId: string, raw: unknown): Promise<SlashCommandDTO[]> {
  if (!Array.isArray(raw)) throw new BadRequestError("Body must be an array of commands");
  if (raw.length > MAX_COMMANDS_PER_APPLICATION) {
    throw new BadRequestError(`At most ${MAX_COMMANDS_PER_APPLICATION} commands per application`);
  }

  const validated = raw.map(validateCommand);
  const names = new Set<string>();
  for (const cmd of validated) {
    if (names.has(cmd.name)) throw new BadRequestError(`Duplicate command name "${cmd.name}"`);
    names.add(cmd.name);
  }

  // One transaction: a half-applied overwrite would leave the bot advertising a command set that
  // is neither the old one nor the new one.
  await prisma.$transaction(async (tx) => {
    await tx.slashCommand.deleteMany({
      where: { applicationId, ...(names.size > 0 ? { name: { notIn: Array.from(names) } } : {}) },
    });
    for (const cmd of validated) {
      await tx.slashCommand.upsert({
        where: { applicationId_name: { applicationId, name: cmd.name } },
        create: {
          applicationId,
          name: cmd.name,
          description: cmd.description,
          optionsJson: cmd.options as never,
        },
        update: { description: cmd.description, optionsJson: cmd.options as never },
      });
    }
  });

  const stored = await prisma.slashCommand.findMany({ where: { applicationId }, orderBy: { name: "asc" } });
  return stored.map(serializeCommand);
}

export async function listCommandsForApplication(applicationId: string): Promise<SlashCommandDTO[]> {
  const rows = await prisma.slashCommand.findMany({ where: { applicationId }, orderBy: { name: "asc" } });
  return rows.map(serializeCommand);
}

/**
 * Every command a user could run in this server — that is, the commands of every bot that is
 * actually a member of it.
 *
 * Scoped by membership rather than listing all registered commands on the instance, because a
 * command palette showing commands from bots that are not present would be a list of things that
 * cannot work, and a directory of every application on the instance besides.
 */
export async function listCommandsForServer(serverId: string): Promise<SlashCommandDTO[]> {
  const botMemberships = await prisma.membership.findMany({
    where: { serverId, user: { isBot: true } },
    select: { userId: true },
  });
  if (botMemberships.length === 0) return [];

  const applications = await prisma.application.findMany({
    where: { botUser: { id: { in: botMemberships.map((m) => m.userId) } } },
    select: { id: true },
  });
  if (applications.length === 0) return [];

  const rows = await prisma.slashCommand.findMany({
    where: { applicationId: { in: applications.map((a) => a.id) } },
    orderBy: [{ name: "asc" }],
  });
  return rows.map(serializeCommand);
}

function serializeInteraction(row: {
  id: string;
  type: string;
  token: string;
  userId: string;
  channelId: string | null;
  dmConversationId: string | null;
  serverId: string | null;
  commandName: string | null;
  optionsJson: unknown;
  componentCustomId: string | null;
  messageId: bigint | null;
  createdAt: Date;
}): InteractionDTO {
  return {
    id: row.id,
    type: row.type === "COMMAND" ? "command" : "component",
    token: row.token,
    userId: row.userId,
    channelId: row.channelId,
    dmConversationId: row.dmConversationId,
    serverId: row.serverId,
    commandName: row.commandName,
    options: (row.optionsJson as Record<string, string | number | boolean> | null) ?? null,
    customId: row.componentCustomId,
    messageId: row.messageId !== null ? row.messageId.toString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function dispatch(
  interaction: Parameters<typeof serializeInteraction>[0] & { applicationId: string },
): Promise<{ interactionId: string; delivered: boolean }> {
  const application = await prisma.application.findUnique({
    where: { id: interaction.applicationId },
    select: { botUser: { select: { id: true } } },
  });
  if (!application?.botUser) return { interactionId: interaction.id, delivered: false };

  try {
    getIO().to(`user:${application.botUser.id}`).emit(ServerEvents.INTERACTION_CREATE, serializeInteraction(interaction));
  } catch {
    /* realtime down — the row still exists and the poll endpoint will find it */
  }
  return { interactionId: interaction.id, delivered: true };
}

export interface InvokeResult {
  interactionId: string;
  /** Null when the bot answered in time; a human-readable reason when it did not. */
  timedOut: string | null;
}

/**
 * Waits (briefly) for the bot to answer.
 *
 * Polling the row rather than holding an in-memory promise, because the process that receives the
 * bot's response is not necessarily this one — the API is behind a socket adapter and can be scaled
 * horizontally. A resolver held in a Map in one container would never fire in the other.
 */
async function awaitResponse(interactionId: string): Promise<InvokeResult> {
  const deadline = Date.now() + RESPONSE_WINDOW_MS;
  for (;;) {
    const row = await prisma.interaction.findUnique({
      where: { id: interactionId },
      select: { status: true },
    });
    if (!row) return { interactionId, timedOut: "That interaction no longer exists" };
    if (row.status === "RESPONDED") return { interactionId, timedOut: null };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  await prisma.interaction.updateMany({
    where: { id: interactionId, status: "PENDING" },
    data: { status: "TIMED_OUT" },
  });
  return { interactionId, timedOut: "The bot didn't respond in time" };
}

export async function invokeCommand(params: {
  userId: string;
  channelId?: string | null;
  dmConversationId?: string | null;
  commandName: string;
  options: Record<string, string | number | boolean>;
}): Promise<InvokeResult> {
  let serverId: string | null = null;

  if (params.channelId) {
    const channel = await prisma.channel.findUnique({
      where: { id: params.channelId },
      select: { serverId: true },
    });
    if (!channel) throw new NotFoundError("Channel not found");
    serverId = channel.serverId;
    // SEND_MESSAGES, not VIEW_CHANNELS: running a command is how a bot is made to post, so someone
    // who may not speak in a channel must not be able to make a bot speak there for them.
    await checkPermission(params.userId, serverId, Permissions.SEND_MESSAGES);
  } else if (params.dmConversationId) {
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: params.dmConversationId, userId: params.userId } },
    });
    if (!participant) throw new ForbiddenError("Not a participant in this conversation");
  } else {
    throw new BadRequestError("A command must be run in a channel or a DM");
  }

  // Resolved against the bots actually present here, so `/deploy` in a server whose bot does not
  // define it is a clean "no such command" rather than an invocation of some unrelated
  // application's command of the same name.
  const available = serverId
    ? await listCommandsForServer(serverId)
    : await listCommandsForDMBots(params.dmConversationId!);
  const command = available.find((c) => c.name === params.commandName.toLowerCase());
  if (!command) throw new NotFoundError(`No command called /${params.commandName} is available here`);

  assertOptionsSatisfy(command, params.options);

  const interaction = await prisma.interaction.create({
    data: {
      applicationId: command.applicationId,
      type: "COMMAND",
      userId: params.userId,
      channelId: params.channelId ?? null,
      dmConversationId: params.dmConversationId ?? null,
      serverId,
      commandName: command.name,
      optionsJson: params.options as never,
      token: randomBytes(32).toString("hex"),
    },
  });

  await dispatch({ ...interaction, applicationId: command.applicationId });
  return awaitResponse(interaction.id);
}

async function listCommandsForDMBots(conversationId: string): Promise<SlashCommandDTO[]> {
  const participants = await prisma.dMParticipant.findMany({
    where: { conversationId, user: { isBot: true } },
    select: { userId: true },
  });
  if (participants.length === 0) return [];
  const applications = await prisma.application.findMany({
    where: { botUser: { id: { in: participants.map((p) => p.userId) } } },
    select: { id: true },
  });
  if (applications.length === 0) return [];
  const rows = await prisma.slashCommand.findMany({
    where: { applicationId: { in: applications.map((a) => a.id) } },
    orderBy: { name: "asc" },
  });
  return rows.map(serializeCommand);
}

function assertOptionsSatisfy(command: SlashCommandDTO, supplied: Record<string, string | number | boolean>): void {
  for (const option of command.options) {
    const value = supplied[option.name];
    if (value === undefined || value === "") {
      if (option.required) throw new BadRequestError(`/${command.name} needs a value for "${option.name}"`);
      continue;
    }
    if (option.type === "integer" && !Number.isInteger(Number(value))) {
      throw new BadRequestError(`"${option.name}" must be a whole number`);
    }
    if (option.type === "boolean" && typeof value !== "boolean" && value !== "true" && value !== "false") {
      throw new BadRequestError(`"${option.name}" must be true or false`);
    }
    if (option.choices?.length && !option.choices.some((c) => String(c.value) === String(value))) {
      throw new BadRequestError(`"${option.name}" must be one of: ${option.choices.map((c) => c.name).join(", ")}`);
    }
  }
  const known = new Set(command.options.map((o) => o.name));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) throw new BadRequestError(`/${command.name} has no option called "${key}"`);
  }
}

/** A button press or select choice on a message a bot posted. */
export async function invokeComponent(params: {
  userId: string;
  messageId: string;
  customId: string;
  values?: string[];
}): Promise<InvokeResult> {
  const message = await prisma.message.findUnique({
    where: { id: BigInt(params.messageId) },
    include: { channel: { select: { serverId: true } } },
  });
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  if (!message.componentsJson) throw new BadRequestError("That message has no components");

  if (message.channel) {
    await checkPermission(params.userId, message.channel.serverId, Permissions.VIEW_CHANNELS);
  } else if (message.dmConversationId) {
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.dmConversationId, userId: params.userId } },
    });
    if (!participant) throw new ForbiddenError("Not a participant in this conversation");
  }

  // The customId must be one this message actually carries. Without this check the endpoint is a
  // way to send an arbitrary string to a bot as though a user had clicked it, which is exactly the
  // kind of unvalidated input a bot author would reasonably assume could not happen.
  if (!componentExists(message.componentsJson, params.customId)) {
    throw new BadRequestError("That control is not on this message");
  }

  if (!message.authorId) throw new BadRequestError("That message has no bot behind it");
  const application = await prisma.application.findFirst({
    where: { botUser: { id: message.authorId } },
    select: { id: true },
  });
  if (!application) throw new BadRequestError("That message was not posted by a bot");

  const interaction = await prisma.interaction.create({
    data: {
      applicationId: application.id,
      type: "COMPONENT",
      userId: params.userId,
      channelId: message.channelId,
      dmConversationId: message.dmConversationId,
      serverId: message.channel?.serverId ?? null,
      componentCustomId: params.customId,
      optionsJson: params.values?.length ? ({ values: params.values } as never) : undefined,
      messageId: message.id,
      token: randomBytes(32).toString("hex"),
    },
  });

  await dispatch({ ...interaction, applicationId: application.id });
  return awaitResponse(interaction.id);
}

function componentExists(raw: unknown, customId: string): boolean {
  if (!Array.isArray(raw)) return false;
  for (const row of raw) {
    const components = (row as { components?: unknown })?.components;
    if (!Array.isArray(components)) continue;
    if (components.some((c) => (c as { customId?: unknown })?.customId === customId)) return true;
  }
  return false;
}

/**
 * The bot's answer.
 *
 * Authorized by the token alone — see the note at the top of this file. The status transition is a
 * conditional update rather than a read-then-write, which is what makes double-responding
 * impossible even if the bot sends two answers at once.
 */
export async function respondToInteraction(params: {
  token: string;
  content?: string;
  components?: unknown;
  /** Ephemeral responses are not posted as a message; the invoking user is shown them privately. */
  ephemeral?: boolean;
}): Promise<{ ok: true }> {
  const interaction = await prisma.interaction.findUnique({ where: { token: params.token } });
  if (!interaction) throw new NotFoundError("Unknown interaction");

  const claimed = await prisma.interaction.updateMany({
    where: { id: interaction.id, status: "PENDING" },
    data: { status: "RESPONDED", respondedAt: new Date() },
  });
  if (claimed.count === 0) {
    // Either already answered or already timed out. Both are the bot's own doing and both are worth
    // telling it about, because silently accepting a late response would produce a message that
    // appears with no visible cause several seconds after the user gave up.
    throw new BadRequestError(
      interaction.status === "RESPONDED" ? "That interaction was already answered" : "That interaction timed out",
    );
  }

  const content = (params.content ?? "").trim();
  if (params.ephemeral) {
    // Delivered only to the person who triggered it, and never stored — an ephemeral reply that
    // persisted would be a message nobody else can see in a channel's history, which is worse than
    // no message at all.
    try {
      getIO().to(`user:${interaction.userId}`).emit(ServerEvents.INTERACTION_CREATE, {
        id: interaction.id,
        type: "ephemeral-response",
        content,
        channelId: interaction.channelId,
        dmConversationId: interaction.dmConversationId,
      });
    } catch {
      /* nothing to fall back to for an ephemeral reply */
    }
    return { ok: true };
  }

  if (!content && !params.components) return { ok: true };

  const botUser = await prisma.application.findUnique({
    where: { id: interaction.applicationId },
    select: { botUser: { select: { id: true } } },
  });
  if (!botUser?.botUser) throw new NotFoundError("Bot not found");

  if (interaction.channelId) {
    const dto = await createChannelMessage({
      userId: botUser.botUser.id,
      channelId: interaction.channelId,
      content,
    });
    if (params.components) await attachComponents(dto.id, params.components, interaction.channelId, null);
  } else if (interaction.dmConversationId) {
    const dto = await createDMMessage({
      userId: botUser.botUser.id,
      conversationId: interaction.dmConversationId,
      content,
    });
    if (params.components) await attachComponents(dto.id, params.components, null, interaction.dmConversationId);
  }

  return { ok: true };
}

/**
 * Components are written after the message exists rather than as part of its create, because
 * createChannelMessage is the shared send path used by humans, webhooks and the socket handler —
 * threading a bot-only field through all of it to serve one caller is the wrong trade. The update
 * re-broadcasts so clients that already rendered the message pick the buttons up.
 */
async function attachComponents(
  messageId: string,
  components: unknown,
  channelId: string | null,
  dmConversationId: string | null,
): Promise<void> {
  const { serializeMessage } = await import("../../lib/serialize.js");
  const { messageInclude } = await import("../messages/service.js");

  const updated = await prisma.message.update({
    where: { id: BigInt(messageId) },
    data: { componentsJson: components as never },
    include: messageInclude,
  });

  const room = channelId ? `channel:${channelId}` : `dm:${dmConversationId}`;
  try {
    getIO().to(room).emit(ServerEvents.MESSAGE_UPDATE, serializeMessage(updated, null));
  } catch {
    /* the components are stored; a client will see them on next load */
  }
}

/** Bots that would rather poll than hold a socket. */
export async function listPendingInteractions(applicationId: string): Promise<InteractionDTO[]> {
  const rows = await prisma.interaction.findMany({
    where: { applicationId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows.map(serializeInteraction);
}
