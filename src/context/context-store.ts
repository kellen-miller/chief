import type Database from 'better-sqlite3';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

import { hasSourceTombstone } from './source-scope.js';
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
  readonly isInternal?: boolean;
  readonly parentDocumentIds: readonly number[];
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly retentionDeadline: number | null;
  readonly revision: number;
  readonly sourceRevisionChecksum?: string;
  readonly summary: string;
  readonly tier: ContextTier;
  readonly timeZone: string;
  readonly topicKey: string | null;
  readonly topicLabel?: string | null;
}

export function contextDocumentGenerationScopeId(
  documentKey: string,
  sourceRevisionChecksum: string,
): string {
  return `generation:${JSON.stringify([documentKey, sourceRevisionChecksum])}`;
}

export class ContextStore {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public activateDocumentRevision(input: ContextDocumentRevisionInput): number {
    return this.#activateDocumentRevision(input, false);
  }

  public activateBackfillDocumentRevision(
    input: ContextDocumentRevisionInput,
  ): number {
    return this.#activateDocumentRevision(input, true);
  }

  #activateDocumentRevision(
    input: ContextDocumentRevisionInput,
    allowRetentionExpiredSources: boolean,
  ): number {
    return this.#database.transaction(() => {
      this.#assertInputsAvailable(input, allowRetentionExpiredSources);
      const maximumRevision = queries
        .contextActivateDocumentRevisionSelectContextDocuments(this.#database)
        .pluck()
        .get(input.documentKey) as number | null;
      if (maximumRevision !== null && input.revision <= maximumRevision) {
        throw new Error('context document revision must increase');
      }
      const previousIds = queries
        .contextActivateDocumentRevisionSelectContextDocuments2(this.#database)
        .pluck()
        .all(input.documentKey);
      for (const id of previousIds) this.#deleteSearchRows(id);
      queries
        .contextActivateDocumentRevisionUpdateContextDocuments(this.#database)
        .run(input.createdAt, input.documentKey);

      const result = queries
        .contextActivateDocumentRevisionInsertContextDocuments(this.#database)
        .run({
          ...input,
          isInternal: input.isInternal === true ? 1 : 0,
          topicLabel: input.topicLabel ?? null,
        });
      const documentId = Number(result.lastInsertRowid);
      const insertEvent =
        queries.contextActivateDocumentRevisionInsertContextDocumentEvents(
          this.#database,
        );
      for (const eventId of input.eventIds) {
        insertEvent.run(documentId, eventId);
      }
      const insertParent =
        queries.contextActivateDocumentRevisionInsertContextDocumentParents(
          this.#database,
        );
      for (const parentId of input.parentDocumentIds) {
        insertParent.run(documentId, parentId);
      }
      if (input.isInternal !== true) {
        this.#database
          .prepare(readSqliteStatement('insertContextDocumentFts'))
          .run(documentId, input.summary);
        this.#database
          .prepare(
            readSqliteStatement(
              'contextStoreActivateDocumentRevisionInsertContextDocumentVectors',
            ),
          )
          .run(BigInt(documentId), JSON.stringify(Array.from(input.embedding)));
      }
      return documentId;
    })();
  }

  #assertInputsAvailable(
    input: ContextDocumentRevisionInput,
    allowRetentionExpiredSources: boolean,
  ): void {
    if (input.eventIds.length === 0 && input.parentDocumentIds.length === 0) {
      throw new Error('context document requires lineage');
    }
    if (input.tier !== 'hourly' && input.parentDocumentIds.length === 0) {
      throw new Error('higher context tier requires parent lineage');
    }
    if (input.tier !== 'hourly' && input.eventIds.length > 0) {
      throw new Error('higher context tier requires parent-only lineage');
    }
    const sourceRevisionChecksum = input.sourceRevisionChecksum;
    if (input.eventIds.length > 0 && !allowRetentionExpiredSources) {
      if (sourceRevisionChecksum === undefined)
        throw new Error('context document requires source revision checksum');

      const current = queries
        .contextAssertInputsAvailableSelectContextJobs(this.#database)
        .pluck()
        .get(
          input.periodStart,
          input.periodEnd,
          input.timeZone,
          sourceRevisionChecksum,
        );
      if (current !== 1) {
        throw new Error('context document source revision changed');
      }
    }
    const sourceAvailable =
      queries.contextAssertInputsAvailableSelectConversationEvents(
        this.#database,
      );
    if (
      input.eventIds.some(
        (eventId) =>
          sourceAvailable
            .pluck()
            .get(eventId, allowRetentionExpiredSources ? 1 : 0) !== 1,
      )
    ) {
      throw new Error('context document source is unavailable');
    }
    if (allowRetentionExpiredSources) {
      if (
        input.eventIds.some((eventId) => {
          const scopeId = queries
            .contextAssertInputsAvailableSelectConversationEvents2(
              this.#database,
            )
            .pluck()
            .get(eventId) as string | undefined;
          return (
            scopeId !== undefined && hasSourceTombstone(this.#database, scopeId)
          );
        })
      ) {
        throw new Error('context document source is tombstoned');
      }
    }
    const parentAvailable =
      queries.contextAssertInputsAvailableSelectContextDocuments(
        this.#database,
      );
    if (
      input.parentDocumentIds.some(
        (parentId) => parentAvailable.pluck().get(parentId) !== 1,
      )
    ) {
      throw new Error('context document parent is unavailable');
    }
    if (input.tier !== 'hourly') {
      const parentFinal =
        queries.contextAssertInputsAvailableSelectContextDocuments2(
          this.#database,
        );
      if (
        input.parentDocumentIds.some(
          (parentId) => parentFinal.pluck().get(parentId) !== 1,
        )
      ) {
        throw new Error('higher context tier requires final parents');
      }
    }
    const tombstoned = queries
      .contextStoreAssertInputsAvailableSelectContextTombstones(this.#database)
      .pluck()
      .get({
        documentGenerationScopeId:
          input.sourceRevisionChecksum === undefined
            ? ''
            : contextDocumentGenerationScopeId(
                input.documentKey,
                input.sourceRevisionChecksum,
              ),
        documentKey: input.documentKey,
        topicKey: input.topicKey,
      });
    if (tombstoned === 1) {
      throw new Error('context document is tombstoned');
    }
  }

  #deleteSearchRows(documentId: number): void {
    this.#database
      .prepare(readSqliteStatement('deleteContextDocumentFts'))
      .run(documentId);
    this.#database
      .prepare(readSqliteStatement('deleteContextDocumentVector'))
      .run(BigInt(documentId));
  }
}
