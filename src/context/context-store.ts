import type Database from 'better-sqlite3';

import type { ContextCompleteness, ContextTier } from './context-types.js';

export interface ContextDocumentRevisionInput {
  readonly completeness: ContextCompleteness;
  readonly confidence: number;
  readonly createdAt: number;
  readonly documentKey: string;
  readonly embedding: Float32Array;
  readonly eventIds: readonly number[];
  readonly generationInputTokens: number;
  readonly generationOutputTokens: number;
  readonly generationUsageUsd: number;
  readonly parentDocumentIds: readonly number[];
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly retentionDeadline: number | null;
  readonly revision: number;
  readonly summary: string;
  readonly tier: ContextTier;
  readonly timeZone: string;
  readonly topicKey: string | null;
}

export class ContextStore {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public activateDocumentRevision(input: ContextDocumentRevisionInput): number {
    return this.#database.transaction(() => {
      this.#assertInputsAvailable(input);
      const previousIds = this.#database
        .prepare(
          `select id from context_documents
           where document_key = ? and state = 'active'`,
        )
        .pluck()
        .all(input.documentKey) as number[];
      for (const id of previousIds) this.#deleteSearchRows(id);
      this.#database
        .prepare(
          `update context_documents
           set state = 'superseded', updated_at = ?
           where document_key = ? and state = 'active'`,
        )
        .run(input.createdAt, input.documentKey);

      const result = this.#database
        .prepare(
          `insert into context_documents
             (document_key, tier, period_start, period_end, timezone,
              topic_key, revision, completeness, state, content_state,
              content_state_reason, summary, confidence, retention_deadline,
              created_at, updated_at, generation_input_tokens,
              generation_output_tokens, generation_usage_usd)
           values
             (@documentKey, @tier, @periodStart, @periodEnd, @timeZone,
              @topicKey, @revision, @completeness, 'active', 'available',
              'retained', @summary, @confidence, @retentionDeadline,
              @createdAt, @createdAt, @generationInputTokens,
              @generationOutputTokens, @generationUsageUsd)`,
        )
        .run(input);
      const documentId = Number(result.lastInsertRowid);
      const insertEvent = this.#database.prepare(
        `insert into context_document_events (document_id, event_id)
         values (?, ?)`,
      );
      for (const eventId of input.eventIds) {
        insertEvent.run(documentId, eventId);
      }
      const insertParent = this.#database.prepare(
        `insert into context_document_parents
           (document_id, parent_document_id)
         values (?, ?)`,
      );
      for (const parentId of input.parentDocumentIds) {
        insertParent.run(documentId, parentId);
      }
      this.#database
        .prepare(
          'insert into context_document_fts (rowid, content) values (?, ?)',
        )
        .run(documentId, input.summary);
      this.#database
        .prepare(
          `insert into context_document_vectors (document_id, embedding)
           values (?, ?)`,
        )
        .run(BigInt(documentId), JSON.stringify(Array.from(input.embedding)));
      return documentId;
    })();
  }

  #assertInputsAvailable(input: ContextDocumentRevisionInput): void {
    const sourceAvailable = this.#database.prepare(
      `select exists(
         select 1 from conversation_events
         where id = ? and content_state = 'available'
       )`,
    );
    if (
      input.eventIds.some(
        (eventId) => sourceAvailable.pluck().get(eventId) !== 1,
      )
    ) {
      throw new Error('context document source is unavailable');
    }
    const parentAvailable = this.#database.prepare(
      `select exists(
         select 1 from context_documents
         where id = ? and state = 'active' and content_state = 'available'
       )`,
    );
    if (
      input.parentDocumentIds.some(
        (parentId) => parentAvailable.pluck().get(parentId) !== 1,
      )
    ) {
      throw new Error('context document parent is unavailable');
    }
    const tombstoned = this.#database
      .prepare(
        `select exists(
           select 1 from context_tombstones
           where (scope_type = 'document' and scope_id = @documentKey)
              or (scope_type = 'topic' and scope_id = @topicKey)
         )`,
      )
      .pluck()
      .get({ documentKey: input.documentKey, topicKey: input.topicKey });
    if (tombstoned === 1) {
      throw new Error('context document is tombstoned');
    }
  }

  #deleteSearchRows(documentId: number): void {
    this.#database
      .prepare('delete from context_document_fts where rowid = ?')
      .run(documentId);
    this.#database
      .prepare('delete from context_document_vectors where document_id = ?')
      .run(BigInt(documentId));
  }
}
