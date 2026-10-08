import { createHash } from 'node:crypto';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

import type Database from 'better-sqlite3';

import {
  discordSourceSnowflake,
  hasSourceTombstone,
} from '../context/source-scope.js';

export interface SourceObservation {
  readonly canModerateContext?: boolean;
  readonly content: string;
  readonly medium: 'text' | 'voice';
  readonly occurredAt: number;
  readonly platformSourceId: string;
  readonly revisionChecksum?: string;
  readonly retentionDeadline: number;
  readonly sourceScopeId?: string;
  readonly speakerId: string;
}

export interface ExtractionJob {
  readonly attemptCount: number;
  readonly id: number;
  readonly sourceEventId: number;
}

export interface ExtractionSource {
  readonly canModerateContext: boolean;
  readonly content: string;
  readonly id: number;
  readonly medium: 'text' | 'voice';
  readonly occurredAt: number;
  readonly platformSourceId: string;
  readonly revisionChecksum: string;
  readonly speakerId: string;
}

export interface MemoryInput {
  readonly canonicalText: string;
  readonly confidence: number;
  readonly embedding: Float32Array;
  readonly kind: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly sourceEventId: number | null;
  readonly timestamp: number;
}

export interface MemoryQuery {
  readonly embedding: Float32Array;
  readonly limit: number;
  readonly now: number;
  readonly text: string;
}

export interface RetrievedMemory {
  readonly canonicalText: string;
  readonly confidence: number;
  readonly id: number;
  readonly kind: string;
  readonly score: number;
}

export interface MemoryCandidate {
  readonly canonicalText: string;
  readonly id: number;
}

export type PreparedMemoryMutation =
  | { readonly action: 'create'; readonly memory: MemoryInput }
  | {
      readonly action: 'conflict' | 'supersede';
      readonly memory: MemoryInput;
      readonly targetMemoryId: number;
    }
  | { readonly action: 'forget'; readonly targetMemoryId: number };

export interface AppliedMemoryMutation {
  readonly action: PreparedMemoryMutation['action'];
  readonly memoryId: number | null;
}

interface MemoryRow {
  canonical_text: string;
  confidence: number;
  id: number;
  kind: string;
}

function buildLexicalQuery(
  text: string,
  operator: 'AND' | 'OR',
): string | undefined {
  return text
    .match(/[\p{L}\p{N}]+/gu)
    ?.map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(` ${operator} `);
}

export class SqliteMemoryStore {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public observe(source: SourceObservation): number {
    return this.#observe(source, true);
  }

  public observeExplicit(source: SourceObservation): number {
    return this.#observe(source, false);
  }

  #observe(source: SourceObservation, createJob: boolean): number {
    return this.#database.transaction(() => {
      const normalized = {
        ...source,
        canModerateContext: source.canModerateContext ? 1 : 0,
        revisionChecksum:
          source.revisionChecksum ?? sourceObservationChecksum(source),
        sourceScopeId: source.sourceScopeId ?? '',
      };
      const existing = queries
        .memoryObserveSelectSourceEvents(this.#database)
        .get(source.platformSourceId) as
        { id: number; revisionChecksum: string } | undefined;
      if (
        existing !== undefined &&
        existing.revisionChecksum !== normalized.revisionChecksum
      ) {
        this.#deleteSourceMemories(existing.id);
        queries.memoryObserveDeleteMemoryJobs(this.#database).run(existing.id);
      }
      queries.memoryObserveInsertSourceEvents(this.#database).run(normalized);
      const sourceEventId = queries
        .memoryObserveSelectSourceEvents2(this.#database)
        .pluck()
        .get(source.platformSourceId);
      if (sourceEventId === undefined)
        throw new Error('observed source event missing');

      if (createJob) {
        queries
          .memoryObserveInsertMemoryJobs(this.#database)
          .run(
            sourceEventId,
            normalized.revisionChecksum,
            source.occurredAt,
            sourceEventId,
          );
      }
      return sourceEventId;
    })();
  }

  public leaseNextJob(
    now: number,
    leaseDuration: number,
  ): ExtractionJob | null {
    return this.#database.transaction(() => {
      const row = queries
        .memoryLeaseNextJobSelectMemoryJobs(this.#database)
        .get(now, now) as ExtractionJob | undefined;
      if (row === undefined) return null;
      queries
        .memoryLeaseNextJobUpdateMemoryJobs(this.#database)
        .run(now + leaseDuration, row.id);
      return { ...row, attemptCount: row.attemptCount + 1 };
    })();
  }

  public nextJobDeadline(now: number): number | null {
    return (
      (queries
        .memoryNextJobDeadlineSelectMemoryJobs(this.#database)
        .pluck()
        .get(now, now) as number | null) ?? null
    );
  }

  public deferForBudget(jobId: number, nextMonth: number): void {
    queries
      .memoryDeferForBudgetUpdateMemoryJobs(this.#database)
      .run(nextMonth, jobId);
  }

  public completeJob(jobId: number): void {
    this.#database.transaction(() => {
      this.#completeJob(jobId);
    })();
  }

  public getJobSource(jobId: number): ExtractionSource | null {
    const row = queries
      .memoryGetJobSourceSelectMemoryJobs(this.#database)
      .get(jobId) as
      | (Omit<ExtractionSource, 'canModerateContext'> & {
          canModerateContext: 0 | 1;
        })
      | undefined;
    return row === undefined
      ? null
      : { ...row, canModerateContext: row.canModerateContext === 1 };
  }

  public canRequesterForget(
    memoryId: number,
    requesterId: string,
    canModerateContext: boolean,
  ): boolean {
    if (canModerateContext) return true;
    return (
      queries
        .memoryCanRequesterForgetSelectMemories(this.#database)
        .pluck()
        .get(memoryId, requesterId) === 1
    );
  }

  public retryJob(
    jobId: number,
    notBefore: number,
    maxAttempts: number,
  ): 'failed' | 'pending' {
    const attemptCount = queries
      .memoryRetryJobSelectMemoryJobs(this.#database)
      .pluck()
      .get(jobId);
    if (attemptCount === undefined) throw new Error('memory job not found');
    const status = attemptCount >= maxAttempts ? 'failed' : 'pending';
    queries
      .memoryRetryJobUpdateMemoryJobs(this.#database)
      .run(status, notBefore, jobId);
    return status;
  }

  public recordConflict(leftMemoryId: number, rightMemoryId: number): void {
    this.#recordConflict(leftMemoryId, rightMemoryId, Date.now());
  }

  #recordConflict(
    leftMemoryId: number,
    rightMemoryId: number,
    timestamp: number,
  ): void {
    const [left, right] =
      leftMemoryId < rightMemoryId
        ? [leftMemoryId, rightMemoryId]
        : [rightMemoryId, leftMemoryId];
    queries
      .memoryRecordConflictInsertMemoryConflicts(this.#database)
      .run(left, right, timestamp);
  }

  public applyMemory(memory: MemoryInput): number {
    return this.#database.transaction(() => this.#insertMemory(memory))();
  }

  public supersede(memoryId: number, replacement: MemoryInput): number {
    return this.#database.transaction(() => {
      const replacementId = this.#insertMemory(replacement);
      this.#supersede(memoryId, replacementId, replacement.timestamp);
      return replacementId;
    })();
  }

  public forget(memoryId: number): {
    readonly deleted: boolean;
    readonly sourceDeleted: boolean;
  } {
    return this.#database.transaction(() => this.#forget(memoryId))();
  }

  public applyPreparedMutationBatch(input: {
    readonly completedAt: number;
    readonly expectedRevisionChecksum?: string;
    readonly jobId?: number;
    readonly mutations: readonly PreparedMemoryMutation[];
    readonly sourceEventId: number;
  }): readonly AppliedMemoryMutation[] {
    return this.#database.transaction(() => {
      const source = queries
        .memoryApplyPreparedMutationBatchSelectSourceEvents(this.#database)
        .get(input.sourceEventId) as
        { revisionChecksum: string; sourceScopeId: string } | undefined;
      const jobRevision =
        input.jobId === undefined
          ? undefined
          : queries
              .memoryApplyPreparedMutationBatchSelectMemoryJobs(this.#database)
              .pluck()
              .get(input.jobId, input.sourceEventId);
      const tombstoned =
        source !== undefined &&
        source.sourceScopeId !== '' &&
        hasSourceTombstone(this.#database, source.sourceScopeId);
      if (
        source === undefined ||
        tombstoned ||
        (input.expectedRevisionChecksum !== undefined &&
          source.revisionChecksum !== input.expectedRevisionChecksum) ||
        (input.jobId !== undefined &&
          (jobRevision === undefined ||
            jobRevision !== source.revisionChecksum))
      ) {
        return [];
      }
      const applied: AppliedMemoryMutation[] = [];
      for (const mutation of input.mutations) {
        if (mutation.action === 'forget') {
          const forgotten = this.#forget(mutation.targetMemoryId);
          applied.push({
            action: 'forget',
            memoryId: forgotten.deleted ? mutation.targetMemoryId : null,
          });
          continue;
        }
        const memoryId = this.#insertMemory(mutation.memory);
        if (mutation.action === 'supersede') {
          this.#supersede(mutation.targetMemoryId, memoryId, input.completedAt);
        } else if (mutation.action === 'conflict') {
          this.#recordConflict(
            mutation.targetMemoryId,
            memoryId,
            input.completedAt,
          );
        }
        applied.push({ action: mutation.action, memoryId });
      }
      if (input.jobId === undefined) {
        queries
          .memoryApplyPreparedMutationBatchUpdateSourceEvents(this.#database)
          .run(input.sourceEventId);
      } else {
        this.#completeJob(input.jobId);
      }
      return applied;
    })();
  }

  public retrieve(query: MemoryQuery): RetrievedMemory[] {
    const ranks = new Map<number, number>();
    const lexicalQuery = buildLexicalQuery(query.text, 'AND');
    if (lexicalQuery !== undefined && lexicalQuery.length > 0) {
      const rows = this.#database
        .prepare(
          readSqliteStatement('memory/memoryStoreRetrieveSelectMemoryFts'),
        )
        .all(lexicalQuery, query.limit * 2) as { id: number }[];
      rows.forEach((row, index) => ranks.set(row.id, 1 / (60 + index + 1)));
    }

    const vectorRows = this.#database
      .prepare(
        readSqliteStatement('memory/memoryStoreRetrieveSelectMemoryVectors'),
      )
      .all(JSON.stringify(Array.from(query.embedding)), query.limit * 2) as {
      id: number;
    }[];
    vectorRows.forEach((row, index) =>
      ranks.set(row.id, (ranks.get(row.id) ?? 0) + 1 / (60 + index + 1)),
    );

    if (ranks.size === 0) return [];
    const ids = [...ranks.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.#database
      .prepare(
        readSqliteStatement('memory/memoryStoreRetrieveSelectMemories', [
          placeholders,
        ]),
      )
      .all(...ids) as MemoryRow[];
    return rows
      .map((row) => ({
        canonicalText: row.canonical_text,
        confidence: row.confidence,
        id: row.id,
        kind: row.kind,
        score: (ranks.get(row.id) ?? 0) * (0.5 + row.confidence / 2),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit);
  }

  public findLexical(text: string, limit = 10): MemoryCandidate[] {
    const lexicalQuery = buildLexicalQuery(text, 'OR');
    if (lexicalQuery === undefined || lexicalQuery.length === 0) return [];
    return this.#database
      .prepare(
        readSqliteStatement('memory/memoryStoreFindLexicalSelectMemoryFts'),
      )
      .all(lexicalQuery, limit) as MemoryCandidate[];
  }

  public maintain(now: number): {
    readonly consolidatedMemories: number;
    readonly deletedSources: number;
  } {
    return this.#database.transaction(() => {
      queries.memoryMaintainDeleteMemoryJobs(this.#database).run(now);
      queries.memoryMaintainUpdateSourceEvents(this.#database).run(now);
      const result = queries
        .memoryMaintainDeleteSourceEvents(this.#database)
        .run(now);
      return {
        consolidatedMemories: this.#consolidateExactDuplicates(now),
        deletedSources: result.changes,
      };
    })();
  }

  public async backup(destination: string): Promise<void> {
    await this.#database.backup(destination);
  }

  #deleteIndexes(memoryId: number): void {
    this.#database
      .prepare(readSqliteStatement('memory/deleteMemoryFts'))
      .run(memoryId);
    this.#database
      .prepare(readSqliteStatement('memory/deleteMemoryVector'))
      .run(BigInt(memoryId));
  }

  public suppressSource(platformSourceId: string): void {
    this.#database.transaction(() => {
      const sourceEventId = queries
        .memorySuppressSourceSelectSourceEvents(this.#database)
        .pluck()
        .get(platformSourceId);
      if (sourceEventId === undefined) return;
      this.#deleteSourceMemories(sourceEventId);
      queries
        .memorySuppressSourceDeleteSourceEvents(this.#database)
        .run(sourceEventId);
    })();
  }

  /**
   * Synchronous authoritative-deletion primitive. The caller owns the shared
   * outer transaction, so this method must not open or commit one itself.
   */
  public deleteContextMemories(
    memoryIds: readonly number[],
  ): readonly number[] {
    const uniqueIds = [...new Set(memoryIds)].filter(
      (memoryId) => Number.isSafeInteger(memoryId) && memoryId > 0,
    );
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const memories = this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreDeleteContextMemoriesSelectMemories',
          [placeholders],
        ),
      )
      .all(...uniqueIds) as { readonly id: number; readonly state: string }[];
    for (const { id, state } of memories) {
      if (state === 'active') this.#deleteIndexes(id);
    }
    const existingIds = memories.map(({ id }) => id);
    if (existingIds.length > 0) {
      const existingPlaceholders = existingIds.map(() => '?').join(', ');
      this.#database
        .prepare(
          readSqliteStatement(
            'memory/memoryStoreDeleteContextMemoriesDeleteMemories',
            [existingPlaceholders],
          ),
        )
        .run(...existingIds);
    }
    return existingIds;
  }

  /**
   * Synchronous authoritative-deletion primitive. The caller owns the shared
   * outer transaction, so this method must not open or commit one itself.
   */
  public deleteContextSources(sourceScopeIds: readonly string[]): void {
    const sourceEventIds = this.#sourceEventIds(sourceScopeIds);
    for (const sourceEventId of sourceEventIds) {
      this.#deleteSourceMemories(sourceEventId);
    }
    if (sourceEventIds.length === 0) return;
    const sourcePlaceholders = sourceEventIds.map(() => '?').join(', ');
    this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreDeleteContextSourcesDeleteSourceEvents',
          [sourcePlaceholders],
        ),
      )
      .run(...sourceEventIds);
  }

  /**
   * Synchronous deletion primitive. The caller owns the shared outer
   * transaction so this method must not open or commit one itself.
   */
  public supersedeForContextDeletion(
    memoryIds: readonly number[],
    now: number,
  ): readonly number[] {
    const uniqueIds = [...new Set(memoryIds)].filter(Number.isSafeInteger);
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const affected = this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreSupersedeForContextDeletionSelectMemories',
          [placeholders],
        ),
      )
      .all(...uniqueIds) as { readonly id: number; readonly state: string }[];
    const existingIds = affected.map(({ id }) => id);
    for (const { id, state } of affected) {
      if (state === 'active') this.#deleteIndexes(id);
    }
    if (existingIds.length > 0) {
      const existingPlaceholders = existingIds.map(() => '?').join(', ');
      this.#database
        .prepare(
          readSqliteStatement(
            'memory/memoryStoreSupersedeForContextDeletionUpdateMemories',
            [existingPlaceholders],
          ),
        )
        .run(now, ...existingIds);
    }
    return existingIds;
  }

  /**
   * Synchronous deletion primitive. It preserves content-free provenance
   * identity while removing the private extraction snapshot and stale work.
   */
  public scrubContextSources(sourceScopeIds: readonly string[]): void {
    const sourceEventIds = this.#sourceEventIds(sourceScopeIds);
    if (sourceEventIds.length === 0) return;
    const placeholders = sourceEventIds.map(() => '?').join(', ');
    this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreScrubContextSourcesDeleteMemoryJobs',
          [placeholders],
        ),
      )
      .run(...sourceEventIds);
    this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreScrubContextSourcesUpdateSourceEvents',
          [placeholders],
        ),
      )
      .run(...sourceEventIds);
  }

  #sourceEventIds(sourceScopeIds: readonly string[]): number[] {
    const uniqueScopeIds = [...new Set(sourceScopeIds)].filter(
      (scopeId) => scopeId !== '',
    );
    if (uniqueScopeIds.length === 0) return [];
    const snowflakes = [
      ...new Set(
        uniqueScopeIds.flatMap((scopeId) => {
          const snowflake = discordSourceSnowflake(scopeId);
          return snowflake === null ? [] : [snowflake];
        }),
      ),
    ];
    const scopePlaceholders = uniqueScopeIds.map(() => '?').join(', ');
    const snowflakePredicate =
      snowflakes.length === 0
        ? ''
        : readSqliteStatement('memory/memorySnowflakeFilter', [
            snowflakes.map(() => '?').join(', '),
          ]);
    return this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreSourceEventIdsSelectSourceEvents',
          [scopePlaceholders, snowflakePredicate],
        ),
      )
      .pluck()
      .all(...uniqueScopeIds, ...snowflakes) as number[];
  }

  #deleteSourceMemories(sourceEventId: number): void {
    const memories = queries
      .memoryDeleteSourceMemoriesSelectMemories(this.#database)
      .all(sourceEventId) as {
      readonly id: number;
      readonly state: string;
    }[];
    for (const { id, state } of memories) {
      if (state === 'active') this.#deleteIndexes(id);
    }
    queries
      .memoryDeleteSourceMemoriesDeleteMemories(this.#database)
      .run(sourceEventId);
  }

  #completeJob(jobId: number): void {
    queries.memoryCompleteJobUpdateMemoryJobs(this.#database).run(jobId);
    queries.memoryCompleteJobUpdateSourceEvents(this.#database).run(jobId);
  }

  #forget(memoryId: number): {
    readonly deleted: boolean;
    readonly sourceDeleted: boolean;
  } {
    const memory = queries
      .memoryForgetSelectMemories(this.#database)
      .get(memoryId) as
      | { readonly sourceEventId: number | null; readonly state: string }
      | undefined;
    if (memory === undefined) return { deleted: false, sourceDeleted: false };
    if (memory.state === 'active') this.#deleteIndexes(memoryId);
    queries.memoryForgetDeleteMemories(this.#database).run(memoryId);

    let sourceDeleted = false;
    if (memory.sourceEventId !== null) {
      const sourceResult = queries
        .memoryForgetDeleteSourceEvents(this.#database)
        .run(memory.sourceEventId, memory.sourceEventId, memory.sourceEventId);
      sourceDeleted = sourceResult.changes === 1;
    }
    return { deleted: true, sourceDeleted };
  }

  #insertMemory(memory: MemoryInput): number {
    const result = queries
      .memoryInsertMemoryInsertMemories(this.#database)
      .run(
        memory.sourceEventId,
        memory.canonicalText,
        memory.kind,
        memory.confidence,
        JSON.stringify(memory.provenance),
        memory.timestamp,
        memory.timestamp,
      );
    const id = Number(result.lastInsertRowid);
    this.#database
      .prepare(
        readSqliteStatement('memory/memoryStoreInsertMemoryInsertMemoryFts'),
      )
      .run(id, memory.canonicalText);
    this.#database
      .prepare(
        readSqliteStatement(
          'memory/memoryStoreInsertMemoryInsertMemoryVectors',
        ),
      )
      .run(BigInt(id), JSON.stringify(Array.from(memory.embedding)));
    return id;
  }

  #supersede(memoryId: number, replacementId: number, timestamp: number): void {
    const result = queries
      .memorySupersedeUpdateMemories(this.#database)
      .run(replacementId, timestamp, memoryId);
    if (result.changes !== 1) throw new Error('active memory not found');
    this.#deleteIndexes(memoryId);
  }

  #consolidateExactDuplicates(now: number): number {
    const groups = queries
      .memoryConsolidateExactDuplicatesSelectMemories(this.#database)
      .all() as {
      ids: string;
      normalized: string;
    }[];
    let consolidated = 0;
    this.#database.transaction(() => {
      for (const group of groups) {
        const ids = group.ids.split(',').map(Number);
        const keep = this.#database
          .prepare(
            readSqliteStatement(
              'memory/memoryStoreConsolidateExactDuplicatesSelectMemories',
              [ids.map(() => '?').join(',')],
            ),
          )
          .pluck()
          .get(...ids) as number;
        for (const id of ids) {
          if (id === keep) continue;
          this.#deleteIndexes(id);
          queries
            .memoryConsolidateExactDuplicatesUpdateMemories(this.#database)
            .run(keep, now, id);
          consolidated += 1;
        }
      }
    })();
    return consolidated;
  }
}

function sourceObservationChecksum(source: SourceObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        content: source.content,
        medium: source.medium,
        occurredAt: source.occurredAt,
        platformSourceId: source.platformSourceId,
        speakerId: source.speakerId,
      }),
    )
    .digest('hex');
}
