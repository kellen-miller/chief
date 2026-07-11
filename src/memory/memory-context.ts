import type { MemoryContextRetriever } from '../app/conversation-orchestrator.js';
import type { EmbeddingResult } from './memory-worker.js';
import type { SqliteMemoryStore } from './memory-store.js';

export class MemoryContext implements MemoryContextRetriever {
  readonly #embed: (text: string) => Promise<EmbeddingResult>;
  readonly #limit: number;
  readonly #store: SqliteMemoryStore;

  public constructor(options: {
    readonly embed: (text: string) => Promise<EmbeddingResult>;
    readonly limit?: number;
    readonly store: SqliteMemoryStore;
  }) {
    this.#embed = options.embed;
    this.#limit = options.limit ?? 6;
    this.#store = options.store;
  }

  public async retrieve(prompt: string): Promise<{
    readonly memories: readonly string[];
    readonly usageUsd: number;
  }> {
    const embedded = await this.#embed(prompt);
    const memories = this.#store.retrieve({
      embedding: embedded.embedding,
      limit: this.#limit,
      now: Date.now(),
      text: prompt,
    });
    return {
      memories: memories.map((memory) => memory.canonicalText),
      usageUsd: embedded.usageUsd,
    };
  }
}
