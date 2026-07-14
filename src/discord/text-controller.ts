import type {
  ConversationResult,
  NormalizedTextSource,
  NormalizedTextTurn,
} from '../app/conversation-orchestrator.js';
import type { ContextApplyResult } from '../context/channel-context-service.js';
import type { DeliveredReplyInput } from '../context/channel-context-service.js';
import { chunkReply } from '../replies/suffix.js';
import {
  qualifyTextMessage,
  type AllowedTextSurface,
  type TextMessageCandidate,
} from './invocation-policy.js';
import {
  discordSourceRevisionChecksum,
  normalizeDiscordSourceForStorage,
  type DiscordAttachmentCandidate,
} from './source-message.js';

export interface DiscordTextMessage extends TextMessageCandidate {
  readonly attachments?: readonly DiscordAttachmentCandidate[];
  readonly authorDisplayName: string;
  readonly authorId: string;
  readonly canModerateContext?: boolean;
  readonly editedAt?: number | null;
  readonly id: string;
  readonly occurredAt?: number;
  readonly replyToMessageId?: string | null;
}

export interface DiscordDeletedMessage {
  readonly channelId: string;
  readonly deletedAt: number;
  readonly guildId: string | null;
  readonly messageId: string;
}

export interface TextDelivery {
  readonly reply: (content: string) => Promise<
    | string
    | {
        readonly messageId: string;
        readonly occurredAt: number;
      }
  >;
  readonly typing: () => Promise<void>;
}

export interface DiscordTextDependencies {
  readonly applyTextSource?: (
    source: NormalizedTextSource,
  ) => ContextApplyResult;
  readonly deleteTextSource?: (input: {
    readonly deletedAt: number;
    readonly messageId: string;
  }) => ContextApplyResult;
  readonly handleText: (
    turn: NormalizedTextTurn,
  ) => Promise<ConversationResult | null>;
  readonly now?: () => number;
  readonly recordDeliveredReply: (input: DeliveredReplyInput) => void;
}

export class DiscordTextController {
  readonly #allowed: AllowedTextSurface;
  readonly #dependencies: DiscordTextDependencies;

  public constructor(
    allowed: AllowedTextSurface,
    dependencies: DiscordTextDependencies,
  ) {
    this.#allowed = allowed;
    this.#dependencies = dependencies;
  }

  public async handle(
    message: DiscordTextMessage,
    delivery: TextDelivery,
  ): Promise<void> {
    const source = this.#normalize(message);
    if (source === null) return;
    if (source.authorKind === 'chief') return;
    const qualification = qualifyTextMessage(this.#allowed, message);
    if (qualification.kind === 'ignore') return;

    const base = {
      attachmentMetadataJson: source.attachmentMetadataJson,
      canModerateContext: source.canModerateContext,
      content: qualification.content,
      editedAt: source.editedAt,
      occurredAt: source.occurredAt,
      platformSourceId: message.id,
      replyToMessageId: source.replyToMessageId,
      requestId: message.id,
      revisionChecksum: discordSourceRevisionChecksum({
        ...source,
        content: qualification.content,
      }),
      speakerId: message.authorId,
      speakerName: message.authorDisplayName,
    };
    const turn: NormalizedTextTurn =
      qualification.kind === 'request'
        ? { ...base, kind: 'request', prompt: qualification.prompt }
        : { ...base, kind: qualification.kind };
    const pending = this.#dependencies.handleText(turn);
    if (qualification.kind === 'observe') {
      await pending;
      return;
    }

    if (qualification.kind === 'request') await delivery.typing();
    const result = await pending;
    if (result === null) return;
    const missingCitations = result.citations.filter(
      (citation) => !result.content.includes(citation),
    );
    const content =
      missingCitations.length === 0
        ? result.content
        : `${result.content.replace(/\s*Mr\. President$/u, '')}\n\nSources: ${missingCitations.join(' ')}`;
    const deliveredChunks: {
      content: string;
      messageId: string;
      occurredAt?: number;
    }[] = [];
    for (const chunk of chunkReply(content)) {
      const delivered = await delivery.reply(chunk);
      const recorded =
        typeof delivered === 'string'
          ? { content: chunk, messageId: delivered }
          : {
              content: chunk,
              messageId: delivered.messageId,
              occurredAt: delivered.occurredAt,
            };
      deliveredChunks.push(recorded);
      this.#dependencies.recordDeliveredReply({
        chunks: [...deliveredChunks],
        logicalResponseId: message.id,
        replyToMessageId: message.id,
        requestId: message.id,
        speakerId: this.#allowed.botUserId,
      });
    }
  }

  public handleUpdate(message: DiscordTextMessage): void {
    const source = this.#normalize(message);
    if (source === null) return;
    this.#dependencies.applyTextSource?.(source);
  }

  public handleDelete(message: DiscordDeletedMessage): void {
    if (
      message.guildId !== this.#allowed.guildId ||
      message.channelId !== this.#allowed.channelId
    ) {
      return;
    }
    this.#dependencies.deleteTextSource?.({
      deletedAt: message.deletedAt,
      messageId: message.messageId,
    });
  }

  #normalize(message: DiscordTextMessage): NormalizedTextSource | null {
    const normalized = normalizeDiscordSourceForStorage(this.#allowed, {
      attachments: message.attachments ?? [],
      authorDisplayName: message.authorDisplayName,
      authorId: message.authorId,
      authorIsBot: message.authorIsBot,
      canModerateContext: message.canModerateContext ?? false,
      channelId: message.channelId,
      content: message.content,
      editedAt: message.editedAt ?? null,
      guildId: message.guildId,
      id: message.id,
      isThread: message.isThread,
      occurredAt: message.occurredAt ?? (this.#dependencies.now ?? Date.now)(),
      replyToMessageId: message.replyToMessageId ?? null,
      webhookId: message.webhookId,
    });
    if (normalized === null) return null;
    return {
      ...normalized,
      revisionChecksum: discordSourceRevisionChecksum(normalized),
    };
  }
}
