import { once } from 'node:events';

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type PartialMessage,
  type TextChannel,
} from 'discord.js';
import type { Logger } from 'pino';

import type { ConversationOrchestrator } from '../app/conversation-orchestrator.js';
import { roll } from '../commands/roll.js';
import type {
  DiscordHistoryMode,
  DiscordHistoryPage,
  DiscordHistorySource,
  DiscordReconciliationResult,
} from './discord-reconciliation-service.js';
import { contextPermissionSnapshot } from './source-message.js';
import {
  discordSourceRevisionChecksum,
  normalizeDiscordSourceForStorage,
} from './source-message.js';
import { DiscordTextController } from './text-controller.js';

export interface GatewayVoiceController {
  join(guild: Guild): Promise<{ readonly aiPaused: boolean }>;
  leave(): Promise<void>;
}

export interface DiscordGatewayOptions {
  readonly channelId: string;
  readonly client?: Client;
  readonly guildId: string;
  readonly logger: Logger;
  readonly orchestrator: ConversationOrchestrator;
  readonly reconciliation?: (input: {
    readonly botUserId: string;
    readonly history: DiscordHistorySource;
  }) => GatewayReconciliation;
  readonly token: string;
  readonly voice: GatewayVoiceController;
  readonly voiceChannelId: string;
}

export interface GatewayReconciliation {
  reconcileAfterGap(): Promise<DiscordReconciliationResult>;
}

export class DiscordGateway {
  readonly #client: Client;
  readonly #options: DiscordGatewayOptions;
  #ready = false;
  #reconciliation: GatewayReconciliation | undefined;
  #text: DiscordTextController | undefined;
  #textChannel: TextChannel | undefined;

  public constructor(options: DiscordGatewayOptions) {
    this.#options = options;
    this.#client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Channel],
      });
  }

  public get ready(): boolean {
    return this.#ready;
  }

  public async start(): Promise<void> {
    this.#client.on(Events.MessageCreate, (message) => {
      void this.#handleCreate(message).catch((error: unknown) => {
        this.#options.logger.error({ err: error }, 'discord_message_failed');
      });
    });
    this.#client.on(Events.MessageUpdate, (_oldMessage, message) => {
      void this.#handleUpdate(message).catch((error: unknown) => {
        this.#options.logger.error(
          { errorName: errorName(error), retryable: true },
          'discord_message_update_failed',
        );
      });
    });
    this.#client.on(Events.MessageDelete, (message) => {
      this.#handleDelete(message);
    });
    this.#client.on(Events.MessageBulkDelete, (messages) => {
      for (const message of messages.values()) this.#handleDelete(message);
    });
    this.#client.on(Events.Error, (error) => {
      this.#options.logger.error(
        { errorName: error.name },
        'discord_gateway_error',
      );
    });
    this.#client.on(Events.ShardError, (error, shardId) => {
      this.#options.logger.error(
        { errorName: error.name, shardId },
        'discord_shard_error',
      );
    });
    this.#client.on(Events.ShardReconnecting, (shardId) => {
      this.#ready = false;
      this.#options.logger.warn({ shardId }, 'discord_shard_reconnecting');
    });
    this.#client.on(Events.ShardResume, (shardId, replayedEvents) => {
      this.#ready = true;
      this.#options.logger.info(
        { replayedEvents, shardId },
        'discord_shard_resumed',
      );
      void this.#reconcile('resume');
    });
    this.#client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void this.#handleCommand(interaction).catch((error: unknown) => {
        this.#options.logger.error({ err: error }, 'discord_command_failed');
      });
    });
    const ready = once(this.#client, Events.ClientReady);
    await this.#client.login(this.#options.token);
    await ready;
    this.#validateAllowlist();
    const botUserId = this.#client.user?.id;
    if (botUserId === undefined)
      throw new Error('Discord client has no bot user');
    this.#text = new DiscordTextController(
      {
        botUserId,
        channelId: this.#options.channelId,
        guildId: this.#options.guildId,
      },
      {
        applyTextSource: (source) =>
          this.#options.orchestrator.applyTextSource(source),
        deleteTextSource: (input) =>
          this.#options.orchestrator.deleteTextSource(input),
        handleText: (turn) => this.#options.orchestrator.handleText(turn),
        recordDeliveredReply: (input) => {
          this.#options.orchestrator.recordDeliveredReply(input);
        },
      },
    );
    if (this.#textChannel === undefined) {
      throw new Error('configured Discord text channel is unavailable');
    }
    this.#reconciliation = this.#options.reconciliation?.({
      botUserId,
      history: new DiscordGatewayHistorySource({
        botUserId,
        channel: this.#textChannel,
        channelId: this.#options.channelId,
        guildId: this.#options.guildId,
      }),
    });
    await this.#reconcile('startup');
    this.#ready = true;
  }

  public async stop(): Promise<void> {
    this.#ready = false;
    await this.#options.voice.leave();
    await this.#client.destroy();
  }

  async #handleCreate(message: Message | PartialMessage): Promise<void> {
    const text = this.#text;
    if (text === undefined) return;
    const resolved = await this.#resolveMessage(message, 'create');
    if (resolved === null) return;
    let replied = false;
    await text.handle(this.#messageCandidate(resolved), {
      reply: async (content) => {
        if (!replied) {
          const sent = await resolved.reply({
            allowedMentions: { repliedUser: false },
            content,
          });
          replied = true;
          return { messageId: sent.id, occurredAt: sent.createdTimestamp };
        }
        if (!resolved.channel.isSendable()) {
          throw new Error('Discord channel is no longer sendable');
        }
        const sent = await resolved.channel.send(content);
        return { messageId: sent.id, occurredAt: sent.createdTimestamp };
      },
      typing: async () => {
        if (resolved.channel.isSendable()) await resolved.channel.sendTyping();
      },
    });
  }

  async #handleUpdate(message: Message | PartialMessage): Promise<void> {
    const text = this.#text;
    if (text === undefined) return;
    const resolved = await this.#resolveMessage(message, 'update');
    if (resolved === null) return;
    text.handleUpdate(this.#messageCandidate(resolved));
  }

  #handleDelete(message: Message | PartialMessage): void {
    this.#text?.handleDelete({
      channelId: message.channelId,
      deletedAt: Date.now(),
      guildId: message.guildId,
      messageId: message.id,
    });
  }

  async #resolveMessage(
    message: Message | PartialMessage,
    event: 'create' | 'update',
  ): Promise<Message | null> {
    if (!message.partial) return message;
    try {
      return await message.fetch();
    } catch (error) {
      this.#options.logger.warn(
        {
          channelId: message.channelId,
          errorName: errorName(error),
          event,
          guildId: message.guildId,
          messageId: message.id,
          retryable: true,
        },
        'discord_partial_message_retryable',
      );
      return null;
    }
  }

  #messageCandidate(message: Message) {
    return {
      attachments: [...message.attachments.values()].map(
        ({ description, name }) => ({ description, name }),
      ),
      authorDisplayName:
        message.member?.displayName ??
        message.author.globalName ??
        message.author.username,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      canModerateContext:
        !message.author.bot &&
        contextPermissionSnapshot(message.content, () =>
          message.guild?.ownerId === message.author.id
            ? true
            : message.member?.permissions.has(
                PermissionFlagsBits.Administrator,
              ),
        ),
      channelId: message.channelId,
      content: message.content,
      editedAt: message.editedTimestamp,
      guildId: message.guildId,
      id: message.id,
      isThread: message.channel.isThread(),
      occurredAt: message.createdTimestamp,
      replyToMessageId: message.reference?.messageId ?? null,
      webhookId: message.webhookId,
    };
  }

  async #reconcile(trigger: 'resume' | 'startup'): Promise<void> {
    const reconciliation = this.#reconciliation;
    if (reconciliation === undefined) return;
    try {
      const result = await reconciliation.reconcileAfterGap();
      if (result.status === 'completed') {
        this.#options.logger.info(
          { status: result.status, trigger },
          'discord_reconciliation',
        );
      } else {
        this.#options.logger.warn(
          { retryable: true, status: result.status, trigger },
          'discord_reconciliation_incomplete',
        );
      }
    } catch (error) {
      this.#options.logger.warn(
        { errorName: errorName(error), retryable: true, trigger },
        'discord_reconciliation_failed',
      );
    }
  }

  async #handleCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      interaction.guildId !== this.#options.guildId ||
      interaction.channelId !== this.#options.channelId ||
      interaction.guild === null
    ) {
      await interaction.reply({
        content: 'Chief is unavailable here, Mr. President',
        ephemeral: true,
      });
      return;
    }
    switch (interaction.commandName) {
      case 'roll': {
        const maximum = interaction.options.getInteger('max', true);
        await interaction.reply(`${roll(maximum).toString()}, Mr. President`);
        break;
      }
      case 'help': {
        await interaction.reply(
          'Mention @Chief with a request, or use /roll, /join, and /leave. In group voice, address Chief by name. Mr. President',
        );
        break;
      }
      case 'join': {
        const member = await interaction.guild.members.fetch(
          interaction.user.id,
        );
        if (member.voice.channelId !== this.#options.voiceChannelId) {
          await interaction.reply({
            content:
              'Join the configured main voice channel first, Mr. President',
            ephemeral: true,
          });
          break;
        }
        await interaction.deferReply();
        const joined = await this.#options.voice.join(interaction.guild);
        await interaction.editReply(
          joined.aiPaused
            ? 'I am in the room, but AI usage is paused until the next UTC month, so I cannot listen or answer, Mr. President'
            : 'I am in the room, Mr. President',
        );
        break;
      }
      case 'leave': {
        await this.#options.voice.leave();
        await interaction.reply('I have left the room, Mr. President');
        break;
      }
      default:
        await interaction.reply({
          content: 'Unknown command, Mr. President',
          ephemeral: true,
        });
    }
  }

  #validateAllowlist(): void {
    const guild = this.#client.guilds.cache.get(this.#options.guildId);
    if (guild === undefined)
      throw new Error('configured Discord guild is unavailable');
    const text = guild.channels.cache.get(this.#options.channelId);
    if (text?.type !== ChannelType.GuildText) {
      throw new Error('configured Discord text channel is unavailable');
    }
    this.#textChannel = text;
    const voice = guild.channels.cache.get(this.#options.voiceChannelId);
    if (voice?.type !== ChannelType.GuildVoice) {
      throw new Error('configured Discord voice channel is unavailable');
    }
  }
}

interface DiscordGatewayHistorySourceOptions {
  readonly botUserId: string;
  readonly channel: TextChannel;
  readonly channelId: string;
  readonly guildId: string;
}

class DiscordGatewayHistorySource implements DiscordHistorySource {
  readonly #allowed: {
    readonly botUserId: string;
    readonly channelId: string;
    readonly guildId: string;
  };
  readonly #channel: TextChannel;

  public constructor(options: DiscordGatewayHistorySourceOptions) {
    this.#allowed = options;
    this.#channel = options.channel;
  }

  public async fetchPage(input: {
    readonly afterMessageId: string | null;
    readonly cursor: string | null;
    readonly mode: DiscordHistoryMode;
    readonly retentionCutoff: number;
  }): Promise<DiscordHistoryPage> {
    try {
      const incremental = input.mode === 'incremental';
      const anchor = input.cursor ?? input.afterMessageId;
      const messages = await this.#channel.messages.fetch({
        ...(anchor === null
          ? {}
          : incremental && input.cursor === null
            ? { after: anchor }
            : { before: anchor }),
        limit: 100,
      });
      const fetched = [...messages.values()];
      const reachedIncrementalBoundary =
        incremental &&
        input.afterMessageId !== null &&
        fetched.some(
          ({ id }) => BigInt(id) <= BigInt(input.afterMessageId ?? '0'),
        );
      const containsExpired = fetched.some(
        ({ createdTimestamp }) => createdTimestamp < input.retentionCutoff,
      );
      const terminal =
        (incremental && input.afterMessageId === null) ||
        fetched.length < 100 ||
        reachedIncrementalBoundary ||
        (input.mode === 'retained' && containsExpired);
      const rawIds = fetched.map(({ id }) => id);
      const oldestRaw = snowflakeMinimum(rawIds);
      const newestRaw = snowflakeMaximum(rawIds);
      const nextCursor = terminal ? null : oldestRaw;
      const items = fetched.flatMap((message) => {
        if (
          incremental &&
          input.afterMessageId !== null &&
          BigInt(message.id) <= BigInt(input.afterMessageId)
        ) {
          return [];
        }
        if (
          input.mode === 'retained' &&
          message.createdTimestamp < input.retentionCutoff
        ) {
          return [];
        }
        const source = normalizeDiscordSourceForStorage(
          this.#allowed,
          historyCandidate(message),
        );
        if (source === null) return [];
        const normalized = {
          ...source,
          revisionChecksum: discordSourceRevisionChecksum(source),
        };
        return [
          {
            messageId: message.id,
            occurredAt: message.createdTimestamp,
            revisionChecksum: normalized.revisionChecksum,
            ...(input.mode === 'full' ? {} : { source: normalized }),
          },
        ];
      });
      const coverage =
        oldestRaw === null && newestRaw === null && !terminal
          ? null
          : {
              newestMessageId:
                newestRaw ??
                timestampSnowflake(input.retentionCutoff + RAW_RETENTION_MS),
              oldestMessageId:
                input.mode === 'full' && terminal
                  ? '0'
                  : input.mode === 'retained' && terminal
                    ? timestampSnowflake(input.retentionCutoff)
                    : (oldestRaw ?? timestampSnowflake(input.retentionCutoff)),
            };
      return {
        complete: true,
        coverage,
        items,
        nextCursor,
        rateLimited: false,
      };
    } catch (error) {
      if (isRateLimited(error)) {
        return {
          complete: false,
          coverage: null,
          items: [],
          nextCursor: input.cursor,
          rateLimited: true,
        };
      }
      throw error;
    }
  }
}

const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;

function historyCandidate(message: Message) {
  return {
    attachments: [...message.attachments.values()].map(
      ({ description, name }) => ({ description, name }),
    ),
    authorDisplayName:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    canModerateContext: false,
    channelId: message.channelId,
    content: message.content,
    editedAt: message.editedTimestamp,
    guildId: message.guildId,
    id: message.id,
    isThread: message.channel.isThread(),
    occurredAt: message.createdTimestamp,
    replyToMessageId: message.reference?.messageId ?? null,
    webhookId: message.webhookId,
  };
}

function snowflakeMinimum(ids: readonly string[]): string | null {
  return ids.reduce<string | null>(
    (minimum, id) =>
      minimum === null || BigInt(id) < BigInt(minimum) ? id : minimum,
    null,
  );
}

function snowflakeMaximum(ids: readonly string[]): string | null {
  return ids.reduce<string | null>(
    (maximum, id) =>
      maximum === null || BigInt(id) > BigInt(maximum) ? id : maximum,
    null,
  );
}

function timestampSnowflake(timestamp: number): string {
  return (
    BigInt(Math.max(0, Math.floor(timestamp) - DISCORD_EPOCH_MS)) << 22n
  ).toString();
}

function isRateLimited(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 429
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
