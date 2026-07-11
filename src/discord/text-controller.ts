import type {
  ConversationResult,
  TextTurn,
} from '../app/conversation-orchestrator.js';
import type { SourceObservation } from '../memory/memory-store.js';
import { chunkReply } from '../replies/suffix.js';
import {
  qualifyTextMessage,
  type AllowedTextSurface,
  type TextMessageCandidate,
} from './invocation-policy.js';

export interface DiscordTextMessage extends TextMessageCandidate {
  readonly authorId: string;
  readonly id: string;
}

export interface TextDelivery {
  readonly reply: (content: string) => Promise<void>;
  readonly typing: () => Promise<void>;
}

export interface DiscordTextDependencies {
  readonly handleText: (turn: TextTurn) => Promise<ConversationResult>;
  readonly now?: () => number;
  readonly observe: (source: SourceObservation) => void;
}

const TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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
    const qualification = qualifyTextMessage(this.#allowed, message);
    if (qualification.kind === 'ignore') return;

    const now = (this.#dependencies.now ?? Date.now)();
    const observedContent =
      qualification.kind === 'request'
        ? `Chief, ${qualification.prompt}`
        : qualification.kind === 'greeting'
          ? 'Chief'
          : message.content;
    this.#dependencies.observe({
      content: observedContent,
      medium: 'text',
      occurredAt: now,
      platformSourceId: message.id,
      retentionDeadline: now + TEXT_RETENTION_MS,
      speakerId: message.authorId,
    });
    if (qualification.kind === 'observe') return;
    if (qualification.kind === 'greeting') {
      await delivery.reply('At your service, Mr. President');
      return;
    }

    await delivery.typing();
    const result = await this.#dependencies.handleText({
      prompt: qualification.prompt,
      requestId: message.id,
    });
    const missingCitations = result.citations.filter(
      (citation) => !result.content.includes(citation),
    );
    const content =
      missingCitations.length === 0
        ? result.content
        : `${result.content.replace(/\s*Mr\. President$/u, '')}\n\nSources: ${missingCitations.join(' ')}`;
    for (const chunk of chunkReply(content)) {
      await delivery.reply(chunk);
    }
  }
}
