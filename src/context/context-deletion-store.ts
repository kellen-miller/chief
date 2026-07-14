import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { SqliteMemoryStore } from '../memory/memory-store.js';
import { contextPeriod } from './context-period.js';

export interface ContextDeletionCandidates {
  readonly documentKeys: readonly string[];
  readonly memoryIds: readonly number[];
  readonly sourceScopeIds: readonly string[];
}

export interface ContextForgetJournalEntry {
  readonly checksum: string;
  readonly journalKey: string;
  readonly occurredAt: number;
  readonly payload: {
    readonly documentIds: readonly number[];
    readonly memoryIds: readonly number[];
    readonly sourceScopeIds: readonly string[];
    readonly tombstoneKeys: readonly string[];
  };
}

export interface ContextDeletionResult {
  readonly documentCount: number;
  readonly journal: ContextForgetJournalEntry;
  readonly journalId: number;
  readonly memoryCount: number;
  readonly sourceCount: number;
}

export interface PendingContextForgetJournal {
  readonly entry: ContextForgetJournalEntry;
  readonly id: number;
}

export type ContextDeletionConfirmation =
  | { readonly status: 'expired' }
  | { readonly status: 'invalid' }
  | {
      readonly candidates: ContextDeletionCandidates;
      readonly requestId: string;
      readonly requestSourceScopeId: string;
      readonly status: 'ready';
    };

interface SourceRow {
  readonly id: number;
  readonly occurredAt: number;
  readonly scopeId: string;
}

interface DocumentRow {
  readonly documentKey: string;
  readonly id: number;
}

export class ContextDeletionStore {
  readonly #channelId: string;
  readonly #database: Database.Database;
  readonly #guildId: string;
  readonly #memory: SqliteMemoryStore;
  readonly #timeZone: string;

  public constructor(options: {
    readonly channelId: string;
    readonly database: Database.Database;
    readonly guildId: string;
    readonly memory: SqliteMemoryStore;
    readonly timeZone: string;
  }) {
    this.#channelId = options.channelId;
    this.#database = options.database;
    this.#guildId = options.guildId;
    this.#memory = options.memory;
    this.#timeZone = options.timeZone;
  }

  public discover(
    target: string,
    excludedSourceScopeId: string,
  ): ContextDeletionCandidates {
    const lexicalQuery = buildLexicalQuery(target);
    if (lexicalQuery === null) {
      return { documentKeys: [], memoryIds: [], sourceScopeIds: [] };
    }
    const directSources = this.#database
      .prepare(
        `select c.guild_id || '/' || c.channel_id || '/' ||
                  c.discord_message_id as scopeId
         from conversation_event_fts f
         join conversation_events c on c.id = f.rowid
         where conversation_event_fts match ?
           and c.guild_id = ? and c.channel_id = ?
           and c.content_state = 'available'
         order by bm25(conversation_event_fts), c.id desc limit 20`,
      )
      .pluck()
      .all(lexicalQuery, this.#guildId, this.#channelId) as string[];
    const documents = this.#database
      .prepare(
        `select distinct d.document_key as documentKey
         from context_document_fts f
         join context_documents d on d.id = f.rowid
         where context_document_fts match ? and d.state = 'active'
           and d.content_state = 'available' and d.is_internal = 0
         order by bm25(context_document_fts), d.updated_at desc limit 20`,
      )
      .pluck()
      .all(lexicalQuery) as string[];
    const memories = this.#database
      .prepare(
        `select m.id from memory_fts f join memories m on m.id = f.rowid
         where memory_fts match ? and m.state = 'active'
         order by bm25(memory_fts), m.updated_at desc limit 20`,
      )
      .pluck()
      .all(lexicalQuery) as number[];
    const sourceScopeIds = new Set(
      directSources.filter((scopeId) => scopeId !== excludedSourceScopeId),
    );
    for (const scopeId of this.#memorySourceScopes(memories)) {
      if (scopeId !== excludedSourceScopeId) sourceScopeIds.add(scopeId);
    }
    for (const scopeId of this.#documentSourceScopes(documents)) {
      if (scopeId !== excludedSourceScopeId) sourceScopeIds.add(scopeId);
    }
    return {
      documentKeys: [...new Set(documents)].sort(),
      memoryIds: [...new Set(memories)].sort((left, right) => left - right),
      sourceScopeIds: [...sourceScopeIds].sort(),
    };
  }

  public discoverMember(
    memberLabel: string,
    excludedSourceScopeId: string,
  ): ContextDeletionCandidates {
    const sourceScopeIds = this.#database
      .prepare(
        `select guild_id || '/' || channel_id || '/' || discord_message_id
           as scopeId
         from conversation_events
         where guild_id = ? and channel_id = ? and role = 'human'
           and content_state_reason not in ('discord-deleted', 'locally-forgotten')
           and lower(trim(speaker_name)) = lower(trim(?))
         order by id`,
      )
      .pluck()
      .all(this.#guildId, this.#channelId, memberLabel) as string[];
    return {
      documentKeys: [],
      memoryIds: [],
      sourceScopeIds: sourceScopeIds.filter(
        (scopeId) => scopeId !== excludedSourceScopeId,
      ),
    };
  }

  public requesterCanDelete(
    candidates: ContextDeletionCandidates,
    requesterId: string,
    canModerateContext: boolean,
  ): boolean {
    if (canModerateContext) return true;
    if (candidates.sourceScopeIds.length === 0) return false;
    const placeholders = candidates.sourceScopeIds.map(() => '?').join(', ');
    const authors = this.#database
      .prepare(
        `select distinct speaker_id
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in (${placeholders})`,
      )
      .pluck()
      .all(...candidates.sourceScopeIds) as (string | null)[];
    if (
      authors.length !== 1 ||
      authors[0] !== requesterId ||
      candidates.sourceScopeIds.some(
        (scopeId) => !this.#sourceBelongsTo(scopeId, requesterId),
      )
    ) {
      return false;
    }
    const memoryScopes = this.#memorySourceScopes(candidates.memoryIds);
    if (
      candidates.memoryIds.length > 0 &&
      memoryScopes.length !== candidates.memoryIds.length
    ) {
      return false;
    }
    const allowedScopes = new Set(candidates.sourceScopeIds);
    if (memoryScopes.some((scopeId) => !allowedScopes.has(scopeId))) {
      return false;
    }
    const documentScopes = this.#documentSourceScopes(candidates.documentKeys);
    return documentScopes.every((scopeId) => allowedScopes.has(scopeId));
  }

  public isNarrowSelfSource(
    candidates: ContextDeletionCandidates,
    requesterId: string,
  ): boolean {
    return (
      candidates.sourceScopeIds.length === 1 &&
      this.requesterCanDelete(candidates, requesterId, false)
    );
  }

  public createConfirmation(input: {
    readonly candidates: ContextDeletionCandidates;
    readonly confirmationChecksum: string;
    readonly now: number;
    readonly requestSourceScopeId: string;
    readonly requesterId: string;
    readonly scopeType: 'member' | 'source' | 'topic';
  }): void {
    const requestId = randomUUID();
    const scopeId = digest(input.candidates);
    this.#database
      .prepare(
        `insert into context_deletion_requests
           (id, requester_id, scope_type, scope_id, confirmation_checksum,
            status, expires_at, created_at, source_ids_json,
            document_ids_json, memory_ids_json, request_source_id)
         values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.requesterId,
        input.scopeType,
        scopeId,
        input.confirmationChecksum,
        input.now + 5 * 60 * 1_000,
        input.now,
        JSON.stringify(input.candidates.sourceScopeIds),
        JSON.stringify(input.candidates.documentKeys),
        JSON.stringify(input.candidates.memoryIds),
        input.requestSourceScopeId,
      );
  }

  public confirmation(input: {
    readonly confirmationChecksum: string;
    readonly now: number;
    readonly requesterId: string;
  }): ContextDeletionConfirmation {
    return this.#database.transaction((): ContextDeletionConfirmation => {
      const row = this.#database
        .prepare(
          `select id, status, expires_at as expiresAt,
                  source_ids_json as sourceIdsJson,
                  document_ids_json as documentIdsJson,
                  memory_ids_json as memoryIdsJson,
                  request_source_id as requestSourceScopeId
           from context_deletion_requests
           where requester_id = ? and confirmation_checksum = ?
           order by created_at desc limit 1`,
        )
        .get(input.requesterId, input.confirmationChecksum) as
        | {
            documentIdsJson: string;
            expiresAt: number;
            id: string;
            memoryIdsJson: string;
            requestSourceScopeId: string;
            sourceIdsJson: string;
            status: string;
          }
        | undefined;
      if (row?.status !== 'pending') {
        return { status: 'invalid' };
      }
      if (row.expiresAt <= input.now) {
        this.#database
          .prepare('delete from context_deletion_requests where id = ?')
          .run(row.id);
        return { status: 'expired' };
      }
      return {
        candidates: {
          documentKeys: parseStringIds(row.documentIdsJson),
          memoryIds: parseNumberIds(row.memoryIdsJson),
          sourceScopeIds: parseStringIds(row.sourceIdsJson),
        },
        requestId: row.id,
        requestSourceScopeId: row.requestSourceScopeId,
        status: 'ready',
      };
    })();
  }

  public delete(input: {
    readonly candidates: ContextDeletionCandidates;
    readonly confirmationRequestId?: string;
    readonly now: number;
    readonly requestSourceScopeIds?: readonly string[];
  }): ContextDeletionResult {
    return this.#database.transaction(() => {
      if (input.confirmationRequestId !== undefined) {
        const consumed = this.#database
          .prepare(
            `update context_deletion_requests
             set status = 'consumed', consumed_at = ?
             where id = ? and status = 'pending' and expires_at > ?`,
          )
          .run(input.now, input.confirmationRequestId, input.now);
        if (consumed.changes !== 1) {
          throw new Error('context deletion confirmation is unavailable');
        }
      }

      const targetSources = this.#sourceRows(input.candidates.sourceScopeIds);
      const allSourceScopeIds = [
        ...new Set([
          ...input.candidates.sourceScopeIds,
          ...(input.requestSourceScopeIds ?? []),
        ]),
      ];
      const sources = this.#sourceRows(allSourceScopeIds);
      const documents = this.#affectedDocuments(
        sources.map(({ id }) => id),
        input.candidates.documentKeys,
      );
      const sourceDerivedMemoryIds =
        this.#sourceDerivedMemoryIds(allSourceScopeIds);
      const memoryIds = [
        ...new Set([...input.candidates.memoryIds, ...sourceDerivedMemoryIds]),
      ];
      const tombstoneKeys: string[] = [];
      for (const source of sources) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: input.now,
            reason: 'locally-forgotten',
            scopeId: source.scopeId,
            scopeType: 'source',
          }),
        );
      }
      for (const document of documents) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: input.now,
            reason: 'locally-forgotten',
            scopeId: String(document.id),
            scopeType: 'document',
          }),
        );
      }

      for (const source of sources) {
        this.#database
          .prepare('delete from conversation_event_fts where rowid = ?')
          .run(source.id);
      }
      if (sources.length > 0) {
        const placeholders = sources.map(() => '?').join(', ');
        this.#database
          .prepare(
            `update conversation_events
             set content = '', attachment_metadata_json = '[]', deleted_at = ?,
                 content_state = 'scrubbed',
                 content_state_reason = 'locally-forgotten'
             where id in (${placeholders})`,
          )
          .run(input.now, ...sources.map(({ id }) => id));
      }
      for (const document of documents) {
        this.#database
          .prepare('delete from context_document_fts where rowid = ?')
          .run(document.id);
        this.#database
          .prepare('delete from context_document_vectors where document_id = ?')
          .run(BigInt(document.id));
      }
      if (documents.length > 0) {
        const placeholders = documents.map(() => '?').join(', ');
        this.#database
          .prepare(
            `update context_documents
             set state = 'suppressed', content_state = 'scrubbed',
                 content_state_reason = 'locally-forgotten', summary = '',
                 updated_at = ? where id in (${placeholders})`,
          )
          .run(input.now, ...documents.map(({ id }) => id));
      }
      const supersededMemoryIds = this.#memory.supersedeForContextDeletion(
        memoryIds,
        input.now,
      );
      if (tombstoneKeys.length === 0 && supersededMemoryIds.length > 0) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: input.now,
            reason: 'locally-forgotten',
            scopeId: `memory:${String(supersededMemoryIds[0])}`,
            scopeType: 'topic',
          }),
        );
      }
      const memorySourceScopeIds =
        this.#memorySourceScopes(supersededMemoryIds);
      this.#memory.scrubContextSources([
        ...new Set([...allSourceScopeIds, ...memorySourceScopeIds]),
      ]);
      this.#enqueueRebuilds(sources, input.now);

      const payload = {
        documentIds: documents.map(({ id }) => id),
        memoryIds: supersededMemoryIds,
        sourceScopeIds: sources.map(({ scopeId }) => scopeId),
        tombstoneKeys,
      };
      const occurredAt = input.now;
      const journalKey = `forget:${randomUUID()}`;
      const checksum = digest({ journalKey, occurredAt, payload });
      const primaryTombstone = tombstoneKeys[0];
      if (primaryTombstone === undefined) {
        throw new Error('context deletion requires a tombstoned scope');
      }
      const result = this.#database
        .prepare(
          `insert into context_forget_journal
             (journal_key, scope_id, tombstone_key, occurred_at, checksum,
              payload_json)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          journalKey,
          sources[0]?.scopeId ??
            documents[0]?.documentKey ??
            `memory:${String(supersededMemoryIds[0] ?? '')}`,
          primaryTombstone,
          occurredAt,
          checksum,
          JSON.stringify(payload),
        );
      return {
        documentCount: documents.length,
        journal: { checksum, journalKey, occurredAt, payload },
        journalId: Number(result.lastInsertRowid),
        memoryCount: supersededMemoryIds.length,
        sourceCount: targetSources.length,
      };
    })();
  }

  public markJournalUploaded(journalId: number, now: number): void {
    this.#database
      .prepare(
        `update context_forget_journal
         set upload_status = 'uploaded', uploaded_at = ?,
             next_attempt_at = null, last_error_category = null
         where id = ? and upload_status != 'uploaded'`,
      )
      .run(now, journalId);
  }

  public markJournalFailed(journalId: number, now: number): void {
    this.#database
      .prepare(
        `update context_forget_journal
         set upload_status = 'failed', attempt_count = attempt_count + 1,
             next_attempt_at = ?, last_error_category = 'upload'
         where id = ? and upload_status != 'uploaded'`,
      )
      .run(now + 5_000, journalId);
  }

  public nextForgetJournal(now: number): PendingContextForgetJournal | null {
    const row = this.#database
      .prepare(
        `select id, journal_key as journalKey, occurred_at as occurredAt,
                checksum, payload_json as payloadJson
         from context_forget_journal
         where upload_status in ('pending', 'failed')
           and (next_attempt_at is null or next_attempt_at <= ?)
         order by occurred_at, id limit 1`,
      )
      .get(now) as
      | {
          checksum: string;
          id: number;
          journalKey: string;
          occurredAt: number;
          payloadJson: string;
        }
      | undefined;
    if (row === undefined) return null;
    const payload = parseJournalPayload(row.payloadJson);
    const entry = {
      checksum: row.checksum,
      journalKey: row.journalKey,
      occurredAt: row.occurredAt,
      payload,
    };
    if (
      digest({
        journalKey: row.journalKey,
        occurredAt: row.occurredAt,
        payload,
      }) !== row.checksum
    ) {
      throw new Error('context forget journal checksum mismatch');
    }
    return { entry, id: row.id };
  }

  public replayForgetJournal(
    entry: ContextForgetJournalEntry,
    now: number,
  ): void {
    if (
      digest({
        journalKey: entry.journalKey,
        occurredAt: entry.occurredAt,
        payload: entry.payload,
      }) !== entry.checksum
    ) {
      throw new Error('context forget journal checksum mismatch');
    }
    this.#database.transaction(() => {
      const sources = this.#sourceRows(entry.payload.sourceScopeIds);
      const restoredDocumentKeys =
        entry.payload.documentIds.length === 0
          ? []
          : (this.#database
              .prepare(
                `select document_key from context_documents
                 where id in (${entry.payload.documentIds.map(() => '?').join(', ')})`,
              )
              .pluck()
              .all(...entry.payload.documentIds) as string[]);
      const documents = this.#affectedDocuments(
        sources.map(({ id }) => id),
        restoredDocumentKeys,
      );
      const tombstoneKeys = entry.payload.tombstoneKeys.map((tombstoneKey) => {
        const scope = parseTombstoneKey(tombstoneKey);
        return this.#insertTombstone({
          now: entry.occurredAt,
          reason: 'locally-forgotten',
          scopeId: scope.scopeId,
          scopeType: scope.scopeType,
        });
      });
      for (const scopeId of entry.payload.sourceScopeIds) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: entry.occurredAt,
            reason: 'locally-forgotten',
            scopeId,
            scopeType: 'source',
          }),
        );
      }
      for (const source of sources) {
        this.#database
          .prepare('delete from conversation_event_fts where rowid = ?')
          .run(source.id);
      }
      if (sources.length > 0) {
        const placeholders = sources.map(() => '?').join(', ');
        this.#database
          .prepare(
            `update conversation_events
             set content = '', attachment_metadata_json = '[]', deleted_at = ?,
                 content_state = 'scrubbed',
                 content_state_reason = 'locally-forgotten'
             where id in (${placeholders})`,
          )
          .run(entry.occurredAt, ...sources.map(({ id }) => id));
      }
      for (const documentId of entry.payload.documentIds) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: entry.occurredAt,
            reason: 'locally-forgotten',
            scopeId: String(documentId),
            scopeType: 'document',
          }),
        );
      }
      for (const document of documents) {
        this.#database
          .prepare('delete from context_document_fts where rowid = ?')
          .run(document.id);
        this.#database
          .prepare('delete from context_document_vectors where document_id = ?')
          .run(BigInt(document.id));
      }
      if (documents.length > 0) {
        const placeholders = documents.map(() => '?').join(', ');
        this.#database
          .prepare(
            `update context_documents
             set state = 'suppressed', content_state = 'scrubbed',
                 content_state_reason = 'locally-forgotten', summary = '',
                 updated_at = ? where id in (${placeholders})`,
          )
          .run(now, ...documents.map(({ id }) => id));
      }
      const memoryIds = [
        ...new Set([
          ...entry.payload.memoryIds,
          ...this.#sourceDerivedMemoryIds(entry.payload.sourceScopeIds),
        ]),
      ];
      const supersededMemoryIds = this.#memory.supersedeForContextDeletion(
        memoryIds,
        entry.occurredAt,
      );
      if (tombstoneKeys.length === 0 && supersededMemoryIds.length > 0) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: entry.occurredAt,
            reason: 'locally-forgotten',
            scopeId: `memory:${String(supersededMemoryIds[0])}`,
            scopeType: 'topic',
          }),
        );
      }
      const memorySourceScopeIds =
        this.#memorySourceScopes(supersededMemoryIds);
      this.#memory.scrubContextSources([
        ...new Set([...entry.payload.sourceScopeIds, ...memorySourceScopeIds]),
      ]);
      this.#enqueueRebuilds(sources, now);
      const primaryTombstone =
        tombstoneKeys[0] ?? entry.payload.tombstoneKeys[0];
      if (primaryTombstone === undefined) {
        throw new Error('context forget journal has no tombstoned scope');
      }
      this.#database
        .prepare(
          `insert into context_forget_journal
             (journal_key, scope_id, tombstone_key, occurred_at, checksum,
              payload_json, upload_status, uploaded_at)
           values (?, ?, ?, ?, ?, ?, 'uploaded', ?)
           on conflict(journal_key) do update set
             upload_status = 'uploaded', uploaded_at = excluded.uploaded_at,
             next_attempt_at = null, last_error_category = null`,
        )
        .run(
          entry.journalKey,
          entry.payload.sourceScopeIds[0] ??
            `memory:${String(entry.payload.memoryIds[0] ?? '')}`,
          primaryTombstone,
          entry.occurredAt,
          entry.checksum,
          JSON.stringify(entry.payload),
          now,
        );
    })();
  }

  #sourceRows(scopeIds: readonly string[]): SourceRow[] {
    if (scopeIds.length === 0) return [];
    const placeholders = scopeIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `select id, occurred_at as occurredAt,
                guild_id || '/' || channel_id || '/' || discord_message_id
                  as scopeId
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in (${placeholders})
         order by id`,
      )
      .all(...scopeIds) as SourceRow[];
  }

  #affectedDocuments(
    eventIds: readonly number[],
    documentKeys: readonly string[],
  ): DocumentRow[] {
    const roots: number[] = [];
    if (eventIds.length > 0) {
      const placeholders = eventIds.map(() => '?').join(', ');
      roots.push(
        ...(this.#database
          .prepare(
            `select distinct document_id from context_document_events
             where event_id in (${placeholders})`,
          )
          .pluck()
          .all(...eventIds) as number[]),
      );
    }
    if (documentKeys.length > 0) {
      const placeholders = documentKeys.map(() => '?').join(', ');
      roots.push(
        ...(this.#database
          .prepare(
            `select id from context_documents
             where document_key in (${placeholders}) and state = 'active'`,
          )
          .pluck()
          .all(...documentKeys) as number[]),
      );
    }
    const uniqueRoots = [...new Set(roots)];
    if (uniqueRoots.length === 0) return [];
    const values = uniqueRoots.map(() => '(?)').join(', ');
    return this.#database
      .prepare(
        `with recursive roots(id) as (values ${values}), affected(id) as (
           select id from roots
           union
           select p.document_id from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select d.id, d.document_key as documentKey
         from context_documents d join affected a on a.id = d.id
         where d.state = 'active' order by d.id`,
      )
      .all(...uniqueRoots) as DocumentRow[];
  }

  #insertTombstone(input: {
    readonly now: number;
    readonly reason: 'locally-forgotten';
    readonly scopeId: string;
    readonly scopeType: 'document' | 'source' | 'topic';
  }): string {
    const tombstoneKey = `${input.scopeType}:${input.scopeId}`;
    const checksum = digest({
      occurredAt: input.now,
      reason: input.reason,
      scopeId: input.scopeId,
      scopeType: input.scopeType,
    });
    this.#database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, ?, ?, ?, ?, ?)
         on conflict(scope_type, scope_id) do nothing`,
      )
      .run(
        tombstoneKey,
        input.scopeType,
        input.scopeId,
        input.reason,
        input.now,
        checksum,
      );
    return tombstoneKey;
  }

  #enqueueRebuilds(sources: readonly SourceRow[], now: number): void {
    const periods = new Map<
      string,
      { readonly end: number; readonly start: number }
    >();
    for (const source of sources) {
      const period = contextPeriod({
        instant: source.occurredAt,
        tier: 'hourly',
        timeZone: this.#timeZone,
      });
      periods.set(period.key, { end: period.end, start: period.start });
    }
    for (const period of periods.values()) {
      const rows = this.#database
        .prepare(
          `select id, discord_message_id as discordMessageId, content,
                  edited_at as editedAt
           from conversation_events
           where guild_id = ? and channel_id = ? and medium = 'text'
             and content_state = 'available'
             and occurred_at >= ? and occurred_at < ? order by id`,
        )
        .all(this.#guildId, this.#channelId, period.start, period.end);
      this.#database
        .prepare(
          `update context_jobs
           set source_revision_checksum = ?, status = 'pending',
               not_before = ?, freshness_deadline = ?, lease_expires_at = null,
               usage_reservation_id = null, last_error_category = 'rebuild'
           where tier = 'hourly' and timezone = ?
             and period_start = ? and period_end = ?`,
        )
        .run(digest(rows), now, now, this.#timeZone, period.start, period.end);
    }
  }

  #memorySourceScopes(memoryIds: readonly number[]): string[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `select s.source_scope_id
         from memories m join source_events s on s.id = m.source_event_id
         where m.id in (${placeholders}) and s.source_scope_id != ''
         order by m.id`,
      )
      .pluck()
      .all(...memoryIds) as string[];
  }

  #sourceDerivedMemoryIds(sourceScopeIds: readonly string[]): number[] {
    if (sourceScopeIds.length === 0) return [];
    const placeholders = sourceScopeIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `select m.id from memories m join source_events s
           on s.id = m.source_event_id
         where s.source_scope_id in (${placeholders}) order by m.id`,
      )
      .pluck()
      .all(...sourceScopeIds) as number[];
  }

  #documentSourceScopes(documentKeys: readonly string[]): string[] {
    if (documentKeys.length === 0) return [];
    const placeholders = documentKeys.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `with recursive lineage(id) as (
           select id from context_documents
           where document_key in (${placeholders}) and state = 'active'
           union
           select p.parent_document_id
           from context_document_parents p join lineage l
             on p.document_id = l.id
         )
         select distinct c.guild_id || '/' || c.channel_id || '/' ||
                c.discord_message_id
         from lineage l join context_document_events e on e.document_id = l.id
         join conversation_events c on c.id = e.event_id
         order by c.id`,
      )
      .pluck()
      .all(...documentKeys) as string[];
  }

  #sourceBelongsTo(scopeId: string, requesterId: string): boolean {
    return (
      this.#database
        .prepare(
          `select exists(
             select 1 from conversation_events
             where guild_id || '/' || channel_id || '/' ||
                     discord_message_id = ? and speaker_id = ?
           )`,
        )
        .pluck()
        .get(scopeId, requesterId) === 1
    );
  }
}

function buildLexicalQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}]+/gu);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseStringIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error('context deletion request has invalid stable IDs');
  }
  return parsed as string[];
}

function parseNumberIds(value: string): number[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => !Number.isSafeInteger(item) || item <= 0)
  ) {
    throw new Error('context deletion request has invalid stable IDs');
  }
  return parsed as number[];
}

function parseTombstoneKey(value: string): {
  readonly scopeId: string;
  readonly scopeType: 'document' | 'source' | 'topic';
} {
  const separator = value.indexOf(':');
  const scopeType = value.slice(0, separator);
  const scopeId = value.slice(separator + 1);
  if (
    !['document', 'source', 'topic'].includes(scopeType) ||
    scopeId.length === 0
  ) {
    throw new Error('context forget journal has an invalid tombstone key');
  }
  return {
    scopeId,
    scopeType: scopeType as 'document' | 'source' | 'topic',
  };
}

function parseJournalPayload(
  value: string,
): ContextForgetJournalEntry['payload'] {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('context forget journal has invalid payload');
  }
  const candidate = parsed as Record<string, unknown>;
  const documentIds = parseNumberIds(JSON.stringify(candidate.documentIds));
  const memoryIds = parseNumberIds(JSON.stringify(candidate.memoryIds));
  const sourceScopeIds = parseStringIds(
    JSON.stringify(candidate.sourceScopeIds),
  );
  const tombstoneKeys = parseStringIds(JSON.stringify(candidate.tombstoneKeys));
  return { documentIds, memoryIds, sourceScopeIds, tombstoneKeys };
}
