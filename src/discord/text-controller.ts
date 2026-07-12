import type {
  ConversationResult,
  NormalizedTextTurn,
} from '../app/conversation-orchestrator.js';
import { chunkReply } from '../replies/suffix.js';
import {
  qualifyTextMessage,
  type AllowedTextSurface,
  type TextMessageCandidate,
} from './invocation-policy.js';

export interface DiscordTextMessage extends TextMessageCandidate {
  readonly authorDisplayName: string;
  readonly authorId: string;
  readonly id: string;
}

export interface TextDelivery {
  readonly reply: (content: string) => Promise<void>;
  readonly typing: () => Promise<void>;
}

export interface DiscordTextDependencies {
  readonly handleText: (
    turn: NormalizedTextTurn,
  ) => Promise<ConversationResult | null>;
  readonly now?: () => number;
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
    const qualification = qualifyTextMessage(this.#allowed, message);
    if (qualification.kind === 'ignore') return;

    const now = (this.#dependencies.now ?? Date.now)();
    const base = {
      content: qualification.content,
      occurredAt: now,
      platformSourceId: message.id,
      requestId: message.id,
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
    for (const chunk of chunkReply(content)) {
      await delivery.reply(chunk);
    }
  }
}
