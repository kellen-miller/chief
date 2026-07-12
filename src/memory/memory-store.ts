import type Database from 'better-sqlite3';

export interface SourceObservation {
  readonly content: string;
  readonly medium: 'text' | 'voice';
  readonly occurredAt: number;
  readonly platformSourceId: string;
  readonly retentionDeadline: number;
  readonly speakerId: string;
}

export interface ExtractionJob {
  readonly attemptCount: number;
  readonly id: number;
  readonly sourceEventId: number;
}

export interface ExtractionSource {
  readonly content: string;
  readonly id: number;
  readonly medium: 'text' | 'voice';
  readonly occurredAt: number;
  readonly platformSourceId: string;
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

interface MemoryRow {
  canonical_text: string;
  confidence: number;
  id: number;
  kind: string;
}

export class SqliteMemoryStore {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public observe(source: SourceObservation): number {
    return this.#database.transaction(() => {
      this.#database
        .prepare(
          `insert into source_events
             (platform_source_id, speaker_id, medium, content, occurred_at, retention_deadline)
           values (@platformSourceId, @speakerId, @medium, @content, @occurredAt, @retentionDeadline)
           on conflict(platform_source_id) do update set
             content = excluded.content,
             retention_deadline = excluded.retention_deadline`,
        )
        .run(source);
      const sourceEventId = this.#database
        .prepare('select id from source_events where platform_source_id = ?')
        .pluck()
        .get(source.platformSourceId) as number;
      this.#database
        .prepare(
          `insert into memory_jobs (source_event_id, not_before)
           select ?, ? where not exists (
             select 1 from memory_jobs
             where source_event_id = ? and status in ('pending', 'leased')
           )`,
        )
        .run(sourceEventId, source.occurredAt, sourceEventId);
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
    })();
  }

  public getJobSource(jobId: number): ExtractionSource | null {
    return (
      (this.#database
        .prepare(
          `select s.id, s.content, s.medium, s.occurred_at as occurredAt,
                  s.platform_source_id as platformSourceId,
                  s.speaker_id as speakerId
           from memory_jobs j join source_events s on s.id = j.source_event_id
           where j.id = ?`,
        )
        .get(jobId) as ExtractionSource | undefined) ?? null
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
      .run(left, right, Date.now());
  }

  public applyMemory(memory: MemoryInput): number {
    return this.#database.transaction(() => {
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
    })();
  }

  public supersede(memoryId: number, replacement: MemoryInput): number {
    return this.#database.transaction(() => {
      const replacementId = this.applyMemory(replacement);
      const result = this.#database
        .prepare(
          `update memories set state = 'superseded', superseded_by = ?, updated_at = ?
           where id = ? and state = 'active'`,
        )
        .run(replacementId, replacement.timestamp, memoryId);
      if (result.changes !== 1) throw new Error('active memory not found');
      this.#deleteIndexes(memoryId);
      return replacementId;
    })();
  }

  public forget(memoryId: number): {
    readonly deleted: boolean;
    readonly sourceDeleted: boolean;
  } {
    return this.#database.transaction(() => {
      const memory = this.#database
        .prepare(
          'select source_event_id as sourceEventId from memories where id = ?',
        )
        .get(memoryId) as { sourceEventId: number | null } | undefined;
      if (memory === undefined) return { deleted: false, sourceDeleted: false };
      this.#deleteIndexes(memoryId);
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
          .run(
            memory.sourceEventId,
            memory.sourceEventId,
            memory.sourceEventId,
          );
        sourceDeleted = sourceResult.changes === 1;
      }
      return { deleted: true, sourceDeleted };
    })();
  }

  public retrieve(query: MemoryQuery): RetrievedMemory[] {
    const ranks = new Map<number, number>();
    const lexicalQuery = query.text
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(' AND ');
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
    const lexicalQuery = text
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(' OR ');
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
    const result = this.#database
      .prepare(
        `delete from source_events
         where retention_deadline <= ? and not exists (
           select 1 from memory_jobs j where j.source_event_id = source_events.id
             and j.status != 'completed'
         )`,
      )
      .run(now);
    return {
      consolidatedMemories: this.#consolidateExactDuplicates(now),
      deletedSources: result.changes,
    };
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
