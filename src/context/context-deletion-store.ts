import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { SqliteMemoryStore } from '../memory/memory-store.js';
import { contextPeriod } from './context-period.js';
import { contextDocumentGenerationScopeId } from './context-store.js';
import {
  buildLexicalQuery,
  extractLexicalTermSet,
  hasCompleteLexicalAnchor,
} from './lexical-relevance.js';
import { discordSourceSnowflake } from './source-scope.js';

export interface ContextDeletionCandidates {
  readonly documentKeys: readonly string[];
  readonly memoryIds: readonly number[];
  readonly sourceScopeIds: readonly string[];
}

export interface ContextDeletionDiscovery extends ContextDeletionCandidates {
  readonly complete: boolean;
}

export interface ContextForgetJournalEntry {
  readonly checksum: string;
  readonly journalKey: string;
  readonly occurredAt: number;
  readonly payload: {
    readonly documentIds: readonly number[];
    readonly documentKeys: readonly string[];
    readonly memoryIds: readonly number[];
    readonly reason?: 'discord-deleted' | 'locally-forgotten';
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

export interface ContextAuthoritativeDeletionResult {
  readonly eventId: number | null;
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
  readonly completeness: 'final' | 'provisional';
  readonly contentState: string;
  readonly documentKey: string;
  readonly id: number;
  readonly isInternal: number;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly state: string;
  readonly sourceRevisionChecksum: string | null;
  readonly tier: 'daily' | 'hourly' | 'long-term' | 'weekly';
  readonly timeZone: string;
  readonly topicKey: string | null;
  readonly topicLabel: string | null;
}

interface SuppressionMutationResult {
  readonly documents: readonly DocumentRow[];
  readonly payload: ContextForgetJournalEntry['payload'];
  readonly sources: readonly SourceRow[];
}

const DELETION_DISCOVERY_PAGE_SIZE = 20;
const MAX_DELETION_CANDIDATES = 1_000;

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
    readonly memory?: SqliteMemoryStore | undefined;
    readonly timeZone: string;
  }) {
    this.#channelId = options.channelId;
    this.#database = options.database;
    this.#guildId = options.guildId;
    this.#memory = options.memory ?? new SqliteMemoryStore(options.database);
    this.#timeZone = options.timeZone;
  }

  public discover(
    target: string,
    excludedSourceScopeId: string,
  ): ContextDeletionDiscovery {
    const lexicalTerms = extractLexicalTermSet(target);
    const lexicalQuery = buildLexicalQuery(lexicalTerms.all);
    if (lexicalQuery === undefined) {
      return {
        complete: true,
        documentKeys: [],
        memoryIds: [],
        sourceScopeIds: [],
      };
    }
    const sourceMatches = collectCompleteLexicalRows(
      (limit, offset) =>
        this.#database
          .prepare(
            `select c.guild_id || '/' || c.channel_id || '/' ||
                  c.discord_message_id as scopeId, c.content as text
         from conversation_event_fts f
         join conversation_events c on c.id = f.rowid
         where conversation_event_fts match ?
           and c.guild_id = ? and c.channel_id = ?
           and c.content_state = 'available'
         order by bm25(conversation_event_fts), c.id desc limit ? offset ?`,
          )
          .all(lexicalQuery, this.#guildId, this.#channelId, limit, offset) as {
          readonly scopeId: string;
          readonly text: string;
        }[],
      lexicalTerms.all,
    );
    const documentMatches = collectCompleteLexicalRows(
      (limit, offset) =>
        this.#database
          .prepare(
            `select distinct d.document_key as documentKey, d.summary as text
         from context_document_fts f
         join context_documents d on d.id = f.rowid
         where context_document_fts match ? and d.state = 'active'
           and d.content_state = 'available' and d.is_internal = 0
         order by bm25(context_document_fts), d.updated_at desc
         limit ? offset ?`,
          )
          .all(lexicalQuery, limit, offset) as {
          readonly documentKey: string;
          readonly text: string;
        }[],
      lexicalTerms.all,
    );
    const memoryMatches = collectCompleteLexicalRows(
      (limit, offset) =>
        this.#database
          .prepare(
            `select m.id, m.canonical_text as text
         from memory_fts f join memories m on m.id = f.rowid
         where memory_fts match ? and m.state = 'active'
         order by bm25(memory_fts), m.updated_at desc limit ? offset ?`,
          )
          .all(lexicalQuery, limit, offset) as {
          readonly id: number;
          readonly text: string;
        }[],
      lexicalTerms.all,
    );
    if (
      !sourceMatches.complete ||
      !documentMatches.complete ||
      !memoryMatches.complete
    ) {
      return {
        complete: false,
        documentKeys: [],
        memoryIds: [],
        sourceScopeIds: [],
      };
    }
    const directSources = sourceMatches.rows.map(({ scopeId }) => scopeId);
    const documents = documentMatches.rows.map(
      ({ documentKey }) => documentKey,
    );
    const memories = memoryMatches.rows.map(({ id }) => id);
    const sourceScopeIds = new Set(
      directSources.filter((scopeId) => scopeId !== excludedSourceScopeId),
    );
    for (const scopeId of this.#unavailableDocumentSourceScopes(documents)) {
      if (scopeId !== excludedSourceScopeId) sourceScopeIds.add(scopeId);
    }
    const result = {
      complete: true,
      documentKeys: [...new Set(documents)].sort(),
      memoryIds: [...new Set(memories)].sort((left, right) => left - right),
      sourceScopeIds: [...sourceScopeIds].sort(),
    };
    return candidateCount(result) > MAX_DELETION_CANDIDATES
      ? {
          complete: false,
          documentKeys: [],
          memoryIds: [],
          sourceScopeIds: [],
        }
      : result;
  }

  public discoverMember(
    memberLabel: string,
    excludedSourceScopeId: string,
  ): ContextDeletionDiscovery {
    const matches = this.#database
      .prepare(
        `select guild_id || '/' || channel_id || '/' || discord_message_id
                  as scopeId,
                speaker_id as speakerId
         from conversation_events
         where guild_id = ? and channel_id = ? and role = 'human'
           and content_state_reason not in ('discord-deleted', 'locally-forgotten')
           and lower(trim(speaker_name)) = lower(trim(?))
         order by id`,
      )
      .all(this.#guildId, this.#channelId, memberLabel) as {
      readonly scopeId: string;
      readonly speakerId: string | null;
    }[];
    const sourceScopeIds = matches.map(({ scopeId }) => scopeId);
    const ambiguousIdentity =
      new Set(matches.map(({ speakerId }) => speakerId)).size > 1;
    return {
      complete:
        !ambiguousIdentity && sourceScopeIds.length <= MAX_DELETION_CANDIDATES,
      documentKeys: [],
      memoryIds: [],
      sourceScopeIds:
        ambiguousIdentity || sourceScopeIds.length > MAX_DELETION_CANDIDATES
          ? []
          : sourceScopeIds.filter(
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
    return candidates.documentKeys.every((documentKey) =>
      this.#documentHasSourceScope(documentKey, allowedScopes),
    );
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
      const { documents, payload, sources } = this.#mutateSuppression({
        documentKeys: input.candidates.documentKeys,
        hardDeleteMemorySources: false,
        memoryIds: input.candidates.memoryIds,
        now: input.now,
        reason: 'locally-forgotten',
        sourceScopeIds: allSourceScopeIds,
        tombstoneDocuments: true,
        tombstoneMissingSources: false,
      });
      const occurredAt = input.now;
      const journalKey = `forget:${randomUUID()}`;
      const checksum = digest({ journalKey, occurredAt, payload });
      const primaryTombstone = payload.tombstoneKeys[0];
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
            `memory:${String(payload.memoryIds[0] ?? '')}`,
          primaryTombstone,
          occurredAt,
          checksum,
          JSON.stringify(payload),
        );
      return {
        documentCount: documents.length,
        journal: { checksum, journalKey, occurredAt, payload },
        journalId: Number(result.lastInsertRowid),
        memoryCount: payload.memoryIds.length,
        sourceCount: targetSources.length,
      };
    })();
  }

  public suppressSource(input: {
    readonly now: number;
    readonly reason: 'discord-deleted' | 'locally-forgotten';
    readonly sourceScopeId: string;
  }): ContextAuthoritativeDeletionResult {
    return this.#database.transaction(() => {
      const { payload, sources } = this.#mutateSuppression({
        documentKeys: [],
        hardDeleteMemorySources: true,
        memoryIds: [],
        now: input.now,
        reason: input.reason,
        sourceScopeIds: [input.sourceScopeId],
        tombstoneDocuments: false,
        tombstoneMissingSources: true,
      });
      const journalKey = `forget:${input.sourceScopeId}`;
      const checksum = digest({
        journalKey,
        occurredAt: input.now,
        payload,
      });
      const primaryTombstone = payload.tombstoneKeys[0];
      if (primaryTombstone === undefined) {
        throw new Error('source suppression requires a source tombstone');
      }
      this.#database
        .prepare(
          `insert into context_forget_journal
             (journal_key, scope_id, tombstone_key, occurred_at, checksum,
              payload_json)
           values (?, ?, ?, ?, ?, ?)
           on conflict(journal_key) do nothing`,
        )
        .run(
          journalKey,
          input.sourceScopeId,
          primaryTombstone,
          input.now,
          checksum,
          JSON.stringify(payload),
        );
      return { eventId: sources[0]?.id ?? null };
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
      const authoritativeSourceScope = entry.payload.sourceScopeIds[0];
      const reason =
        entry.payload.reason ??
        (authoritativeSourceScope !== undefined &&
        entry.journalKey === `forget:${authoritativeSourceScope}`
          ? 'discord-deleted'
          : 'locally-forgotten');
      const sources = this.#sourceRows(entry.payload.sourceScopeIds);
      const documents = this.#affectedDocuments(
        sources.map(({ id }) => id),
        entry.payload.documentKeys,
      );
      const tombstoneKeys = entry.payload.tombstoneKeys.map((tombstoneKey) => {
        const scope = parseTombstoneKey(tombstoneKey);
        return this.#insertTombstone({
          now: entry.occurredAt,
          reason,
          scopeId: scope.scopeId,
          scopeType: scope.scopeType,
        });
      });
      for (const scopeId of entry.payload.sourceScopeIds) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: entry.occurredAt,
            reason,
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
                 content_state_reason = ?
             where id in (${placeholders})
               ${reason === 'discord-deleted' ? "and content_state = 'available'" : ''}`,
          )
          .run(entry.occurredAt, reason, ...sources.map(({ id }) => id));
      }
      this.#scrubDocuments(documents, now, reason);
      const memoryIds = [
        ...new Set([
          ...entry.payload.memoryIds,
          ...this.#sourceDerivedMemoryIds(entry.payload.sourceScopeIds),
        ]),
      ];
      const affectedMemoryIds =
        reason === 'discord-deleted'
          ? memoryIds
          : this.#memory.supersedeForContextDeletion(
              memoryIds,
              entry.occurredAt,
            );
      if (reason === 'discord-deleted') {
        this.#memory.deleteContextMemories(affectedMemoryIds);
        this.#memory.deleteContextSources(entry.payload.sourceScopeIds);
      }
      if (tombstoneKeys.length === 0 && affectedMemoryIds.length > 0) {
        tombstoneKeys.push(
          this.#insertTombstone({
            now: entry.occurredAt,
            reason,
            scopeId: `memory:${String(affectedMemoryIds[0])}`,
            scopeType: 'topic',
          }),
        );
      }
      if (reason === 'locally-forgotten') {
        const memorySourceScopeIds =
          this.#memorySourceScopes(affectedMemoryIds);
        this.#memory.scrubContextSources([
          ...new Set([
            ...entry.payload.sourceScopeIds,
            ...memorySourceScopeIds,
          ]),
        ]);
      }
      this.#enqueueRebuilds(sources, documents, now);
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

  #mutateSuppression(input: {
    readonly documentKeys: readonly string[];
    readonly hardDeleteMemorySources: boolean;
    readonly memoryIds: readonly number[];
    readonly now: number;
    readonly reason: 'discord-deleted' | 'locally-forgotten';
    readonly sourceScopeIds: readonly string[];
    readonly tombstoneDocuments: boolean;
    readonly tombstoneMissingSources: boolean;
  }): SuppressionMutationResult {
    const sources = this.#sourceRows(input.sourceScopeIds);
    const documents = this.#affectedDocuments(
      sources.map(({ id }) => id),
      input.documentKeys,
    );
    const memoryIds = [
      ...new Set([
        ...input.memoryIds,
        ...this.#sourceDerivedMemoryIds(input.sourceScopeIds),
      ]),
    ];
    const memorySourceScopeIds = input.hardDeleteMemorySources
      ? []
      : this.#affectedMemorySourceScopes(memoryIds);
    const tombstonedSourceScopes = input.tombstoneMissingSources
      ? input.sourceScopeIds
      : sources.map(({ scopeId }) => scopeId);
    const allTombstonedSourceScopes = [
      ...new Set([...tombstonedSourceScopes, ...memorySourceScopeIds]),
    ];
    const tombstoneKeys = allTombstonedSourceScopes.map((scopeId) =>
      this.#insertTombstone({
        now: input.now,
        reason: input.reason,
        scopeId,
        scopeType: 'source',
      }),
    );
    if (input.tombstoneDocuments) {
      const affectedDocumentIds = new Set(documents.map(({ id }) => id));
      const deletedEventIds = new Set(sources.map(({ id }) => id));
      for (const documentKey of input.documentKeys) {
        const selected = documents.find(
          (document) =>
            document.documentKey === documentKey && document.state === 'active',
        );
        const survivingLineage = this.#documentHasSurvivingLineage(
          documentKey,
          deletedEventIds,
          affectedDocumentIds,
        );
        const scopeId =
          survivingLineage &&
          typeof selected?.sourceRevisionChecksum === 'string'
            ? contextDocumentGenerationScopeId(
                documentKey,
                selected.sourceRevisionChecksum,
              )
            : documentKey;
        tombstoneKeys.push(
          this.#insertTombstone({
            now: input.now,
            reason: input.reason,
            scopeId,
            scopeType: 'document',
          }),
        );
      }
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
               content_state = 'scrubbed', content_state_reason = ?
           where id in (${placeholders})
             ${input.reason === 'discord-deleted' ? "and content_state = 'available'" : ''}`,
        )
        .run(input.now, input.reason, ...sources.map(({ id }) => id));
    }
    this.#scrubDocuments(documents, input.now, input.reason);
    const affectedMemoryIds = input.hardDeleteMemorySources
      ? memoryIds
      : this.#memory.supersedeForContextDeletion(memoryIds, input.now);
    if (input.hardDeleteMemorySources) {
      this.#memory.deleteContextMemories(affectedMemoryIds);
      this.#memory.deleteContextSources(input.sourceScopeIds);
    }
    if (tombstoneKeys.length === 0 && affectedMemoryIds.length > 0) {
      tombstoneKeys.push(
        this.#insertTombstone({
          now: input.now,
          reason: input.reason,
          scopeId: `memory:${String(affectedMemoryIds[0])}`,
          scopeType: 'topic',
        }),
      );
    }
    if (!input.hardDeleteMemorySources) {
      this.#memory.scrubContextSources([
        ...new Set([...input.sourceScopeIds, ...memorySourceScopeIds]),
      ]);
    }
    this.#enqueueRebuilds(sources, documents, input.now);
    return {
      documents,
      payload: {
        documentIds: documents.map(({ id }) => id),
        documentKeys: [
          ...new Set(documents.map(({ documentKey }) => documentKey)),
        ],
        memoryIds: affectedMemoryIds,
        reason: input.reason,
        sourceScopeIds: [
          ...new Set([
            ...(input.tombstoneMissingSources
              ? input.sourceScopeIds
              : sources.map(({ scopeId }) => scopeId)),
            ...memorySourceScopeIds,
          ]),
        ],
        tombstoneKeys,
      },
      sources,
    };
  }

  #sourceRows(scopeIds: readonly string[]): SourceRow[] {
    const uniqueScopeIds = [...new Set(scopeIds)].filter(
      (scopeId) => scopeId !== '',
    );
    if (uniqueScopeIds.length === 0) return [];
    const snowflakes = sourceSnowflakes(uniqueScopeIds);
    const placeholders = uniqueScopeIds.map(() => '?').join(', ');
    const snowflakePredicate =
      snowflakes.length === 0
        ? ''
        : `or discord_message_id in
             (${snowflakes.map(() => '?').join(', ')})`;
    return this.#database
      .prepare(
        `select id, occurred_at as occurredAt,
                guild_id || '/' || channel_id || '/' || discord_message_id
                  as scopeId
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in (${placeholders})
            ${snowflakePredicate}
         order by id`,
      )
      .all(...uniqueScopeIds, ...snowflakes) as SourceRow[];
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
             where document_key in (${placeholders})`,
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
           select sibling.id from context_documents current
           join context_documents sibling
             on sibling.document_key = current.document_key
           join affected a on current.id = a.id
           union
           select p.document_id from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select d.id, d.document_key as documentKey, d.state, d.completeness,
                d.content_state as contentState, d.is_internal as isInternal,
                d.tier, d.period_start as periodStart,
                d.period_end as periodEnd, d.timezone as timeZone,
                d.topic_key as topicKey, d.topic_label as topicLabel,
                (select j.source_revision_checksum from context_jobs j
                 where j.job_key = d.document_key || ':' || d.completeness
                 limit 1) as sourceRevisionChecksum
         from context_documents d join affected a on a.id = d.id
         order by d.id`,
      )
      .all(...uniqueRoots) as DocumentRow[];
  }

  #documentHasSurvivingLineage(
    documentKey: string,
    deletedEventIds: ReadonlySet<number>,
    affectedDocumentIds: ReadonlySet<number>,
  ): boolean {
    const lineage = this.#database
      .prepare(
        `with recursive lineage(id) as (
           select id from context_documents
           where document_key = ? and state = 'active'
           union
           select p.parent_document_id
           from context_document_parents p join lineage l
             on p.document_id = l.id
         )
         select d.id, d.state, d.content_state as contentState,
                e.event_id as eventId,
                c.content_state as eventContentState
         from lineage l join context_documents d on d.id = l.id
         left join context_document_events e on e.document_id = l.id
         left join conversation_events c on c.id = e.event_id`,
      )
      .all(documentKey) as {
      readonly contentState: string;
      readonly eventContentState: string | null;
      readonly eventId: number | null;
      readonly id: number;
      readonly state: string;
    }[];
    return lineage.some(
      ({ contentState, eventContentState, eventId, id, state }) =>
        (eventId !== null &&
          eventContentState === 'available' &&
          !deletedEventIds.has(eventId)) ||
        (!affectedDocumentIds.has(id) &&
          state === 'active' &&
          contentState === 'available'),
    );
  }

  #scrubDocuments(
    documents: readonly DocumentRow[],
    now: number,
    reason: 'discord-deleted' | 'locally-forgotten',
  ): void {
    for (const document of documents) {
      if (
        document.state !== 'active' ||
        document.contentState !== 'available' ||
        document.isInternal === 1
      ) {
        continue;
      }
      this.#database
        .prepare('delete from context_document_fts where rowid = ?')
        .run(document.id);
      this.#database
        .prepare('delete from context_document_vectors where document_id = ?')
        .run(BigInt(document.id));
    }
    if (documents.length === 0) return;
    const ids = documents.map(({ id }) => id);
    const placeholders = ids.map(() => '?').join(', ');
    const topicKeys = [
      ...new Set(
        documents.flatMap(({ topicKey }) =>
          topicKey === null ? [] : [topicKey],
        ),
      ),
    ];
    const topicLabels = [
      ...new Set(
        documents.flatMap(({ topicLabel }) =>
          topicLabel === null ? [] : [topicLabel],
        ),
      ),
    ];
    this.#database
      .prepare(
        `update context_documents
         set state = 'suppressed', content_state = 'scrubbed',
             content_state_reason = ?, summary = '',
             topic_label = null, updated_at = ?
         where id in (${placeholders})`,
      )
      .run(reason, now, ...ids);
    const jobPredicates = [
      topicKeys.length === 0
        ? null
        : `topic_key in (${topicKeys.map(() => '?').join(', ')})`,
      topicLabels.length === 0
        ? null
        : `topic_label in (${topicLabels.map(() => '?').join(', ')})`,
      `exists (
         select 1 from json_each(context_jobs.source_document_ids_json)
         where cast(json_each.value as integer) in (${placeholders})
       )`,
    ].filter((predicate): predicate is string => predicate !== null);
    this.#database
      .prepare(
        `update context_jobs set topic_label = null
         where ${jobPredicates.join(' or ')}`,
      )
      .run(...topicKeys, ...topicLabels, ...ids);
  }

  #insertTombstone(input: {
    readonly now: number;
    readonly reason: 'discord-deleted' | 'locally-forgotten';
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

  #enqueueRebuilds(
    sources: readonly SourceRow[],
    documents: readonly DocumentRow[],
    now: number,
  ): void {
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
    for (const document of documents) {
      if (document.tier !== 'hourly' || document.periodEnd === null) continue;
      periods.set(`${document.timeZone}:${String(document.periodStart)}`, {
        end: document.periodEnd,
        start: document.periodStart,
      });
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
               last_error_category = 'rebuild'
           where tier = 'hourly' and timezone = ?
             and period_start = ? and period_end = ?`,
        )
        .run(digest(rows), now, now, this.#timeZone, period.start, period.end);
    }
    const derived = new Map<
      string,
      Pick<DocumentRow, 'periodEnd' | 'periodStart' | 'tier' | 'timeZone'>
    >();
    for (const document of documents) {
      if (
        (document.tier !== 'daily' && document.tier !== 'weekly') ||
        document.periodEnd === null
      ) {
        continue;
      }
      derived.set(
        `${document.tier}:${document.timeZone}:${String(document.periodStart)}`,
        document,
      );
    }
    for (const document of derived.values()) {
      const childTier = document.tier === 'daily' ? 'hourly' : 'daily';
      const rows = this.#database
        .prepare(
          `select id, revision from context_documents
           where tier = ? and completeness = 'final' and state = 'active'
             and content_state = 'available' and is_internal = 0
             and period_start >= ? and period_end <= ?
           order by period_start, id`,
        )
        .all(childTier, document.periodStart, document.periodEnd);
      this.#database
        .prepare(
          `update context_jobs
           set source_revision_checksum = ?, status = 'pending',
               not_before = ?, freshness_deadline = ?, lease_expires_at = null,
               last_error_category = 'rebuild'
           where tier = ? and timezone = ?
             and period_start = ? and period_end = ?`,
        )
        .run(
          digest(rows),
          now,
          now,
          document.tier,
          document.timeZone,
          document.periodStart,
          document.periodEnd,
        );
    }
    const topicKeys = new Set(
      documents.flatMap(({ tier, topicKey }) =>
        tier === 'long-term' && topicKey !== null ? [topicKey] : [],
      ),
    );
    for (const topicKey of topicKeys) {
      const jobs = this.#database
        .prepare(
          `select id, source_document_ids_json as sourceDocumentIdsJson
           from context_jobs where tier = 'long-term' and topic_key = ?`,
        )
        .all(topicKey) as {
        readonly id: number;
        readonly sourceDocumentIdsJson: string;
      }[];
      for (const job of jobs) {
        const configuredIds = parseNumberIds(job.sourceDocumentIdsJson);
        const activeIds = this.#activeDocumentIds(configuredIds);
        const rows = this.#documentRevisionRows(activeIds);
        this.#database
          .prepare(
            `update context_jobs
             set source_revision_checksum = ?, source_document_ids_json = ?,
                 status = 'pending', not_before = ?, freshness_deadline = ?,
                 lease_expires_at = null, last_error_category = 'rebuild'
             where id = ?`,
          )
          .run(digest(rows), JSON.stringify(activeIds), now, now, job.id);
      }
    }
  }

  #activeDocumentIds(documentIds: readonly number[]): number[] {
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `select id from context_documents
         where id in (${placeholders}) and state = 'active'
           and content_state = 'available' order by id`,
      )
      .pluck()
      .all(...documentIds) as number[];
  }

  #documentRevisionRows(documentIds: readonly number[]): unknown[] {
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `select id, revision from context_documents
         where id in (${placeholders}) order by id`,
      )
      .all(...documentIds);
  }

  #memorySourceScopes(memoryIds: readonly number[]): string[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `select coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         )
         from memories m join source_events s on s.id = m.source_event_id
         where m.id in (${placeholders}) and coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         ) is not null
         order by m.id`,
      )
      .pluck()
      .all(...memoryIds) as string[];
  }

  #affectedMemorySourceScopes(memoryIds: readonly number[]): string[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        `with recursive affected(id) as (
           select id from memories where id in (${placeholders})
           union
           select m.id from memories m join affected a
             on m.superseded_by = a.id
         )
         select coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         )
         from affected a join memories m on m.id = a.id
         join source_events s on s.id = m.source_event_id
         where coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         ) is not null
         order by m.id`,
      )
      .pluck()
      .all(...memoryIds) as string[];
  }

  #sourceDerivedMemoryIds(sourceScopeIds: readonly string[]): number[] {
    const uniqueScopeIds = [...new Set(sourceScopeIds)].filter(
      (scopeId) => scopeId !== '',
    );
    if (uniqueScopeIds.length === 0) return [];
    const snowflakes = sourceSnowflakes(uniqueScopeIds);
    const placeholders = uniqueScopeIds.map(() => '?').join(', ');
    const snowflakePredicate =
      snowflakes.length === 0
        ? ''
        : `or (s.medium = 'text' and s.platform_source_id in
             (${snowflakes.map(() => '?').join(', ')}))`;
    return this.#database
      .prepare(
        `select m.id from memories m join source_events s
           on s.id = m.source_event_id
         where s.source_scope_id in (${placeholders})
            ${snowflakePredicate}
         order by m.id`,
      )
      .pluck()
      .all(...uniqueScopeIds, ...snowflakes) as number[];
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

  #unavailableDocumentSourceScopes(documentKeys: readonly string[]): string[] {
    return documentKeys.flatMap((documentKey) => {
      const scopes = this.#documentSourceScopes([documentKey]);
      if (scopes.length !== 1) return [];
      const scopeId = scopes[0];
      if (scopeId === undefined) return [];
      const available = this.#database
        .prepare(
          `select exists(
             select 1 from conversation_events c
             where c.guild_id || '/' || c.channel_id || '/' ||
                   c.discord_message_id = ?
               and c.content_state = 'available'
           )`,
        )
        .pluck()
        .get(scopeId);
      return available === 1 ? [] : [scopeId];
    });
  }

  #documentHasSourceScope(
    documentKey: string,
    allowedScopes: ReadonlySet<string>,
  ): boolean {
    if (allowedScopes.size === 0) return false;
    return this.#documentSourceScopes([documentKey]).some((scopeId) =>
      allowedScopes.has(scopeId),
    );
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

function sourceSnowflakes(scopeIds: readonly string[]): string[] {
  return [
    ...new Set(
      scopeIds.flatMap((scopeId) => {
        const snowflake = discordSourceSnowflake(scopeId);
        return snowflake === null ? [] : [snowflake];
      }),
    ),
  ];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function candidateCount(candidates: ContextDeletionCandidates): number {
  return (
    candidates.documentKeys.length +
    candidates.memoryIds.length +
    candidates.sourceScopeIds.length
  );
}

function collectCompleteLexicalRows<Row extends { readonly text: string }>(
  fetch: (limit: number, offset: number) => readonly Row[],
  relevanceTerms: readonly string[],
): { readonly complete: boolean; readonly rows: readonly Row[] } {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += DELETION_DISCOVERY_PAGE_SIZE) {
    const page = fetch(DELETION_DISCOVERY_PAGE_SIZE, offset);
    for (const row of page) {
      if (!hasCompleteLexicalAnchor(relevanceTerms, row.text)) continue;
      rows.push(row);
      if (rows.length > MAX_DELETION_CANDIDATES) {
        return { complete: false, rows: [] };
      }
    }
    if (page.length < DELETION_DISCOVERY_PAGE_SIZE) {
      return { complete: true, rows };
    }
  }
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
  const documentKeys = parseStringIds(
    JSON.stringify(candidate.documentKeys ?? []),
  );
  const memoryIds = parseNumberIds(JSON.stringify(candidate.memoryIds));
  const reason = candidate.reason;
  if (
    reason !== undefined &&
    reason !== 'discord-deleted' &&
    reason !== 'locally-forgotten'
  ) {
    throw new Error('context forget journal has invalid reason');
  }
  const sourceScopeIds = parseStringIds(
    JSON.stringify(candidate.sourceScopeIds),
  );
  const tombstoneKeys = parseStringIds(JSON.stringify(candidate.tombstoneKeys));
  return {
    documentIds,
    documentKeys,
    memoryIds,
    ...(reason === undefined ? {} : { reason }),
    sourceScopeIds,
    tombstoneKeys,
  };
}
