import { REST, Routes } from 'discord.js';

import {
  buildDiscordHistoryPage,
  discordHistoryFetchRequest,
  rateLimitedDiscordHistoryPage,
  type DiscordHistoryFetchInput,
  type DiscordHistoryPage,
  type DiscordHistorySource,
} from './discord-reconciliation-service.js';
import {
  discordSourceRevisionChecksum,
  normalizeDiscordSourceForStorage,
} from './source-message.js';

interface DiscordRestAttachment {
  readonly description?: string | null;
  readonly name?: string | null;
}

interface DiscordRestMessage {
  readonly attachments?: readonly DiscordRestAttachment[];
  readonly author: {
    readonly bot?: boolean;
    readonly global_name?: string | null;
    readonly id: string;
    readonly username: string;
  };
  readonly channel_id: string;
  readonly content: string;
  readonly edited_timestamp?: string | null;
  readonly id: string;
  readonly member?: { readonly nick?: string | null } | null;
  readonly message_reference?: { readonly message_id?: string } | null;
  readonly timestamp: string;
  readonly webhook_id?: string | null;
}

export interface DiscordRestHistorySourceOptions {
  readonly botUserId: string;
  readonly channelId: string;
  readonly dependencies?: {
    readonly get: (
      route: string,
      query: Readonly<Record<string, number | string>>,
    ) => Promise<unknown>;
  };
  readonly guildId: string;
  readonly token: string;
}

export class DiscordRestHistorySource implements DiscordHistorySource {
  readonly #allowed: {
    readonly botUserId: string;
    readonly channelId: string;
    readonly guildId: string;
  };
  readonly #get: (
    route: string,
    query: Readonly<Record<string, number | string>>,
  ) => Promise<unknown>;

  public constructor(options: DiscordRestHistorySourceOptions) {
    this.#allowed = options;
    if (options.dependencies !== undefined) {
      this.#get = options.dependencies.get;
    } else {
      const rest = new REST({ version: '10' }).setToken(options.token);
      this.#get = (route, query) =>
        rest.get(route as `/${string}`, {
          query: new URLSearchParams(
            Object.entries(query).map(
              ([key, value]) => [key, String(value)] as [string, string],
            ),
          ),
        });
    }
  }

  public async fetchPage(
    input: DiscordHistoryFetchInput,
  ): Promise<DiscordHistoryPage> {
    try {
      const request = discordHistoryFetchRequest(input);
      const raw = await this.#get(
        Routes.channelMessages(this.#allowed.channelId),
        request,
      );
      if (!Array.isArray(raw)) {
        throw new Error('Discord history response was not a message array');
      }
      const fetched = (raw as DiscordRestMessage[]).map((message) => {
        const occurredAt = Date.parse(message.timestamp);
        const editedAt =
          message.edited_timestamp === null ||
          message.edited_timestamp === undefined
            ? null
            : Date.parse(message.edited_timestamp);
        if (!Number.isFinite(occurredAt) || !validOptionalTimestamp(editedAt)) {
          throw new Error('Discord history response had an invalid timestamp');
        }
        const source = normalizeDiscordSourceForStorage(this.#allowed, {
          attachments: (message.attachments ?? []).map(
            ({ description, name }) => ({
              description: description ?? null,
              name: name ?? '',
            }),
          ),
          authorDisplayName:
            message.member?.nick ??
            message.author.global_name ??
            message.author.username,
          authorId: message.author.id,
          authorIsBot: message.author.bot === true,
          canModerateContext: false,
          channelId: message.channel_id,
          content: message.content,
          editedAt,
          guildId: this.#allowed.guildId,
          id: message.id,
          isThread: false,
          occurredAt,
          replyToMessageId: message.message_reference?.message_id ?? null,
          webhookId: message.webhook_id ?? null,
        });
        const revisionChecksum =
          source === null ? undefined : discordSourceRevisionChecksum(source);
        return {
          ...(source === null || revisionChecksum === undefined
            ? {}
            : {
                item: {
                  messageId: message.id,
                  occurredAt,
                  revisionChecksum,
                  ...(input.mode === 'full'
                    ? {}
                    : { source: { ...source, revisionChecksum } }),
                },
              }),
          messageId: message.id,
          occurredAt,
        };
      });
      return buildDiscordHistoryPage(input, fetched);
    } catch (error) {
      if (isRateLimited(error)) return rateLimitedDiscordHistoryPage(input);
      throw error;
    }
  }
}

function validOptionalTimestamp(value: number | null): boolean {
  return value === null || Number.isFinite(value);
}

function isRateLimited(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 429
  );
}
