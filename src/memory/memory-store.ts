import { createHash } from 'node:crypto';

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
      const existing = this.#database
        .prepare(
          `select id, revision_checksum as revisionChecksum
           from source_events where platform_source_id = ?`,
        )
        .get(source.platformSourceId) as
        { id: number; revisionChecksum: string } | undefined;
      if (
        existing !== undefined &&
        existing.revisionChecksum !== normalized.revisionChecksum
      ) {
        this.#deleteSourceMemories(existing.id);
        this.#database
          .prepare('delete from memory_jobs where source_event_id = ?')
          .run(existing.id);
      }
      this.#database
        .prepare(
          `insert into source_events
             (platform_source_id, source_scope_id, revision_checksum,
              can_moderate_context, speaker_id, medium, content, occurred_at,
              retention_deadline)
           values (@platformSourceId, @sourceScopeId, @revisionChecksum,
                   @canModerateContext, @speakerId, @medium, @content,
                   @occurredAt, @retentionDeadline)
           on conflict(platform_source_id) do update set
             content = excluded.content,
             source_scope_id = excluded.source_scope_id,
             revision_checksum = excluded.revision_checksum,
             can_moderate_context = excluded.can_moderate_context,
             retention_deadline = excluded.retention_deadline`,
        )
        .run(normalized);
      const sourceEventId = this.#database
        .prepare('select id from source_events where platform_source_id = ?')
        .pluck()
        .get(source.platformSourceId) as number;
      if (createJob) {
        this.#database
          .prepare(
            `insert into memory_jobs
               (source_event_id, revision_checksum, not_before)
             select ?, ?, ? where not exists (
               select 1 from memory_jobs
               where source_event_id = ? and status in ('pending', 'leased')
             )`,
          )
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
      const row = this.#database
        .prepare(
          `select id, source_event_id as sourceEventId, attempt_count as attemptCount
           from memory_jobs
           where not_before <= ?
             and (status = 'pending' or (status = 'leased' and lease_expires_at <= ?))
           order by id limit 1`,
        )
        .get(now, now) as ExtractionJob | undefined;
      if (row === undefined) return null;
      this.#database
        .prepare(
          `update memory_jobs set status = 'leased', lease_expires_at = ?,
             attempt_count = attempt_count + 1 where id = ?`,
        )
        .run(now + leaseDuration, row.id);
      return { ...row, attemptCount: row.attemptCount + 1 };
    })();
  }

  public nextJobDeadline(now: number): number | null {
    return (
      (this.#database
        .prepare(
          `select min(not_before) from memory_jobs
           where not_before <= ?
             and (status = 'pending'
               or (status = 'leased' and lease_expires_at <= ?))`,
        )
        .pluck()
        .get(now, now) as number | null) ?? null
    );
  }

  public deferForBudget(jobId: number, nextMonth: number): void {
    this.#database
      .prepare(
        `update memory_jobs set status = 'pending', not_before = ?, lease_expires_at = null,
           attempt_count = max(0, attempt_count - 1) where id = ?`,
      )
      .run(nextMonth, jobId);
  }

  public completeJob(jobId: number): void {
    this.#database.transaction(() => {
      this.#completeJob(jobId);
    })();
  }

  public getJobSource(jobId: number): ExtractionSource | null {
    const row = this.#database
      .prepare(
        `select s.id, s.content, s.medium, s.occurred_at as occurredAt,
                s.platform_source_id as platformSourceId,
                s.revision_checksum as revisionChecksum,
                s.can_moderate_context as canModerateContext,
                s.speaker_id as speakerId
         from memory_jobs j join source_events s on s.id = j.source_event_id
         where j.id = ?`,
      )
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
      this.#database
        .prepare(
          `select exists(
             select 1 from memories m join source_events s
               on s.id = m.source_event_id
             where m.id = ? and s.speaker_id = ?
           )`,
        )
        .pluck()
        .get(memoryId, requesterId) === 1
    );
  }

  public retryJob(
    jobId: number,
    notBefore: number,
    maxAttempts: number,
  ): 'failed' | 'pending' {
    const attemptCount = this.#database
      .prepare('select attempt_count from memory_jobs where id = ?')
      .pluck()
      .get(jobId) as number | undefined;
    if (attemptCount === undefined) throw new Error('memory job not found');
    const status = attemptCount >= maxAttempts ? 'failed' : 'pending';
    this.#database
      .prepare(
        `update memory_jobs set status = ?, not_before = ?, lease_expires_at = null
         where id = ?`,
      )
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
    this.#database
      .prepare(
        `insert into memory_conflicts
           (left_memory_id, right_memory_id, created_at)
         values (?, ?, ?) on conflict(left_memory_id, right_memory_id) do nothing`,
      )
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
      const source = this.#database
        .prepare(
          `select revision_checksum as revisionChecksum,
                  source_scope_id as sourceScopeId
           from source_events where id = ?`,
        )
        .get(input.sourceEventId) as
        { revisionChecksum: string; sourceScopeId: string } | undefined;
      const jobRevision =
        input.jobId === undefined
          ? undefined
          : (this.#database
              .prepare(
                `select revision_checksum from memory_jobs
                 where id = ? and source_event_id = ?`,
              )
              .pluck()
              .get(input.jobId, input.sourceEventId) as string | undefined);
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
        this.#database
          .prepare(
            `update source_events set extraction_status = 'completed'
             where id = ?`,
          )
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
          `select m.id from memory_fts f join memories m on m.id = f.rowid
           where memory_fts match ? and m.state = 'active'
           order by bm25(memory_fts) limit ?`,
        )
        .all(lexicalQuery, query.limit * 2) as { id: number }[];
      rows.forEach((row, index) => ranks.set(row.id, 1 / (60 + index + 1)));
    }

    const vectorRows = this.#database
      .prepare(
        `select memory_id as id from memory_vectors
         where embedding match ? and k = ? order by distance`,
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
        `select id, canonical_text, confidence, kind from memories
         where state = 'active' and id in (${placeholders})`,
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
        `select m.id, m.canonical_text as canonicalText
         from memory_fts f join memories m on m.id = f.rowid
         where memory_fts match ? and m.state = 'active'
         order by bm25(memory_fts) limit ?`,
      )
      .all(lexicalQuery, limit) as MemoryCandidate[];
  }

  public maintain(now: number): {
    readonly consolidatedMemories: number;
    readonly deletedSources: number;
  } {
    return this.#database.transaction(() => {
      this.#database
        .prepare(
          `delete from memory_jobs
           where status = 'completed' and source_event_id in (
             select id from source_events where retention_deadline <= ?
           )`,
        )
        .run(now);
      this.#database
        .prepare(
          `update source_events set content = ''
           where retention_deadline <= ? and content != '' and exists (
             select 1 from memories m where m.source_event_id = source_events.id
           )`,
        )
        .run(now);
      const result = this.#database
        .prepare(
          `delete from source_events
           where retention_deadline <= ? and not exists (
             select 1 from memories m where m.source_event_id = source_events.id
           ) and not exists (
             select 1 from memory_jobs j where j.source_event_id = source_events.id
               and j.status != 'completed'
           )`,
        )
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
      .prepare('delete from memory_fts where rowid = ?')
      .run(memoryId);
    this.#database
      .prepare('delete from memory_vectors where memory_id = ?')
      .run(BigInt(memoryId));
  }

  public suppressSource(platformSourceId: string): void {
    this.#database.transaction(() => {
      const sourceEventId = this.#database
        .prepare('select id from source_events where platform_source_id = ?')
        .pluck()
        .get(platformSourceId) as number | undefined;
      if (sourceEventId === undefined) return;
      this.#deleteSourceMemories(sourceEventId);
      this.#database
        .prepare('delete from source_events where id = ?')
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
        `select id, state from memories
         where id in (${placeholders}) order by id`,
      )
      .all(...uniqueIds) as { readonly id: number; readonly state: string }[];
    for (const { id, state } of memories) {
      if (state === 'active') this.#deleteIndexes(id);
    }
    const existingIds = memories.map(({ id }) => id);
    if (existingIds.length > 0) {
      const existingPlaceholders = existingIds.map(() => '?').join(', ');
      this.#database
        .prepare(`delete from memories where id in (${existingPlaceholders})`)
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
      .prepare(`delete from source_events where id in (${sourcePlaceholders})`)
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
        `with recursive affected(id) as (
           select id from memories where id in (${placeholders})
           union
           select m.id from memories m join affected a
             on m.superseded_by = a.id
         )
         select m.id, m.state from affected a join memories m on m.id = a.id
         order by m.id`,
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
          `update memories
           set canonical_text = '', provenance_json = '{}',
               state = 'superseded', superseded_by = null, updated_at = ?
           where id in (${existingPlaceholders})`,
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
        `delete from memory_jobs
         where source_event_id in (${placeholders})`,
      )
      .run(...sourceEventIds);
    this.#database
      .prepare(
        `update source_events
         set content = '', extraction_status = 'completed'
         where id in (${placeholders})`,
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
        : `or (medium = 'text' and platform_source_id in
             (${snowflakes.map(() => '?').join(', ')}))`;
    return this.#database
      .prepare(
        `select id from source_events
         where source_scope_id in (${scopePlaceholders})
           ${snowflakePredicate}
         order by id`,
      )
      .pluck()
      .all(...uniqueScopeIds, ...snowflakes) as number[];
  }

  #deleteSourceMemories(sourceEventId: number): void {
    const memories = this.#database
      .prepare('select id, state from memories where source_event_id = ?')
      .all(sourceEventId) as {
      readonly id: number;
      readonly state: string;
    }[];
    for (const { id, state } of memories) {
      if (state === 'active') this.#deleteIndexes(id);
    }
    this.#database
      .prepare('delete from memories where source_event_id = ?')
      .run(sourceEventId);
  }

  #completeJob(jobId: number): void {
    this.#database
      .prepare(
        `update memory_jobs set status = 'completed', lease_expires_at = null
         where id = ?`,
      )
      .run(jobId);
    this.#database
      .prepare(
        `update source_events set extraction_status = 'completed'
         where id = (select source_event_id from memory_jobs where id = ?)`,
      )
      .run(jobId);
  }

  #forget(memoryId: number): {
    readonly deleted: boolean;
    readonly sourceDeleted: boolean;
  } {
    const memory = this.#database
      .prepare(
        `select source_event_id as sourceEventId, state
         from memories where id = ?`,
      )
      .get(memoryId) as
      | { readonly sourceEventId: number | null; readonly state: string }
      | undefined;
    if (memory === undefined) return { deleted: false, sourceDeleted: false };
    if (memory.state === 'active') this.#deleteIndexes(memoryId);
    this.#database.prepare('delete from memories where id = ?').run(memoryId);

    let sourceDeleted = false;
    if (memory.sourceEventId !== null) {
      const sourceResult = this.#database
        .prepare(
          `delete from source_events where id = ?
           and not exists (select 1 from memories where source_event_id = ?)
           and not exists (
             select 1 from memory_jobs where source_event_id = ? and status != 'completed'
           )`,
        )
        .run(memory.sourceEventId, memory.sourceEventId, memory.sourceEventId);
      sourceDeleted = sourceResult.changes === 1;
    }
    return { deleted: true, sourceDeleted };
  }

  #insertMemory(memory: MemoryInput): number {
    const result = this.#database
      .prepare(
        `insert into memories
           (source_event_id, canonical_text, kind, confidence, provenance_json,
            state, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
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
      .prepare('insert into memory_fts (rowid, canonical_text) values (?, ?)')
      .run(id, memory.canonicalText);
    this.#database
      .prepare(
        'insert into memory_vectors (memory_id, embedding) values (?, ?)',
      )
      .run(BigInt(id), JSON.stringify(Array.from(memory.embedding)));
    return id;
  }

  #supersede(memoryId: number, replacementId: number, timestamp: number): void {
    const result = this.#database
      .prepare(
        `update memories set state = 'superseded', superseded_by = ?, updated_at = ?
         where id = ? and state = 'active'`,
      )
      .run(replacementId, timestamp, memoryId);
    if (result.changes !== 1) throw new Error('active memory not found');
    this.#deleteIndexes(memoryId);
  }

  #consolidateExactDuplicates(now: number): number {
    const groups = this.#database
      .prepare(
        `select lower(trim(canonical_text)) as normalized,
                group_concat(id) as ids
         from memories where state = 'active'
         group by normalized having count(*) > 1`,
      )
      .all() as { ids: string; normalized: string }[];
    let consolidated = 0;
    this.#database.transaction(() => {
      for (const group of groups) {
        const ids = group.ids.split(',').map(Number);
        const keep = this.#database
          .prepare(
            `select id from memories where id in (${ids.map(() => '?').join(',')})
             order by confidence desc, updated_at desc, id desc limit 1`,
          )
          .pluck()
          .get(...ids) as number;
        for (const id of ids) {
          if (id === keep) continue;
          this.#deleteIndexes(id);
          this.#database
            .prepare(
              `update memories set state = 'superseded', superseded_by = ?,
                 updated_at = ? where id = ?`,
            )
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
