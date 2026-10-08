import { createHash, randomUUID } from 'node:crypto';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

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
  readonly journal: ContextForgetJournalEntry;
  readonly journalId: number;
  readonly journalUploaded: boolean;
}

export interface ContextPreparedForgetJournal {
  readonly entry: ContextForgetJournalEntry;
  readonly uploaded: boolean;
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
            readSqliteStatement(
              'context-deletion/contextDeletionStoreDiscoverSelectConversationEventFts',
            ),
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
            readSqliteStatement(
              'context-deletion/contextDeletionStoreDiscoverSelectContextDocumentFts',
            ),
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
            readSqliteStatement(
              'context-deletion/contextDeletionStoreDiscoverSelectMemoryFts',
            ),
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
    const matches = queries
      .contextDeletionDiscoverMemberSelectConversationEvents(this.#database)
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
        readSqliteStatement(
          'context-deletion/contextDeletionStoreRequesterCanDeleteSelectConversationEvents',
          [placeholders],
        ),
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
    queries
      .contextDeletionCreateConfirmationInsertContextDeletionRequests(
        this.#database,
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
      const row = queries
        .contextDeletionConfirmationSelectContextDeletionRequests(
          this.#database,
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
        queries
          .contextDeletionConfirmationDeleteContextDeletionRequests(
            this.#database,
          )
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
        const consumed = queries
          .contextDeletionDeleteUpdateContextDeletionRequests(this.#database)
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
      const result = queries
        .contextDeletionDeleteInsertContextForgetJournal(this.#database)
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
    readonly preuploadedJournal?: ContextForgetJournalEntry;
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
      const journal =
        input.preuploadedJournal ??
        this.#sourceForgetJournal({
          now: input.now,
          payload,
          reason: input.reason,
          sourceScopeId: input.sourceScopeId,
        });
      this.#validateSourceForgetJournal(journal, {
        reason: input.reason,
        sourceScopeId: input.sourceScopeId,
      });
      const primaryTombstone = journal.payload.tombstoneKeys[0];
      if (primaryTombstone === undefined) {
        throw new Error('source suppression requires a source tombstone');
      }
      if (input.preuploadedJournal === undefined) {
        queries
          .contextDeletionSuppressSourceInsertContextForgetJournal(
            this.#database,
          )
          .run(
            journal.journalKey,
            input.sourceScopeId,
            primaryTombstone,
            journal.occurredAt,
            journal.checksum,
            JSON.stringify(journal.payload),
          );
      } else {
        queries
          .contextDeletionSuppressSourceInsertContextForgetJournal2(
            this.#database,
          )
          .run(
            journal.journalKey,
            input.sourceScopeId,
            primaryTombstone,
            journal.occurredAt,
            journal.checksum,
            JSON.stringify(journal.payload),
            input.now,
          );
      }
      const journalRow = queries
        .contextDeletionSuppressSourceSelectContextForgetJournal(this.#database)
        .get(journal.journalKey) as {
        readonly checksum: string;
        readonly id: number;
        readonly journalKey: string;
        readonly occurredAt: number;
        readonly payloadJson: string;
        readonly uploadStatus: string;
      };
      const storedJournal = {
        checksum: journalRow.checksum,
        journalKey: journalRow.journalKey,
        occurredAt: journalRow.occurredAt,
        payload: parseJournalPayload(journalRow.payloadJson),
      };
      if (
        digest({
          journalKey: storedJournal.journalKey,
          occurredAt: storedJournal.occurredAt,
          payload: storedJournal.payload,
        }) !== storedJournal.checksum
      ) {
        throw new Error('context forget journal checksum mismatch');
      }
      if (
        input.preuploadedJournal !== undefined &&
        storedJournal.checksum !== input.preuploadedJournal.checksum
      ) {
        throw new Error('context forget journal conflicts with uploaded entry');
      }
      return {
        eventId: sources[0]?.id ?? null,
        journal: storedJournal,
        journalId: journalRow.id,
        journalUploaded: journalRow.uploadStatus === 'uploaded',
      };
    })();
  }

  public prepareAuthoritativeSourceJournal(input: {
    readonly now: number;
    readonly reason: 'discord-deleted' | 'locally-forgotten';
    readonly sourceScopeId: string;
  }): ContextPreparedForgetJournal {
    const journalKey = `forget:${input.sourceScopeId}`;
    const row = queries
      .contextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournal(
        this.#database,
      )
      .get(journalKey) as
      | {
          readonly checksum: string;
          readonly journalKey: string;
          readonly occurredAt: number;
          readonly payloadJson: string;
          readonly uploadStatus: string;
        }
      | undefined;
    const entry =
      row === undefined
        ? this.#sourceForgetJournal({
            now: input.now,
            payload: {
              documentIds: [],
              documentKeys: [],
              memoryIds: [],
              reason: input.reason,
              sourceScopeIds: [input.sourceScopeId],
              tombstoneKeys: [`source:${input.sourceScopeId}`],
            },
            reason: input.reason,
            sourceScopeId: input.sourceScopeId,
          })
        : {
            checksum: row.checksum,
            journalKey: row.journalKey,
            occurredAt: row.occurredAt,
            payload: parseJournalPayload(row.payloadJson),
          };
    this.#validateSourceForgetJournal(entry, input);
    return { entry, uploaded: row?.uploadStatus === 'uploaded' };
  }

  public markJournalUploaded(journalId: number, now: number): void {
    queries
      .contextDeletionMarkJournalUploadedUpdateContextForgetJournal(
        this.#database,
      )
      .run(now, journalId);
  }

  public markJournalFailed(journalId: number, now: number): void {
    queries
      .contextDeletionMarkJournalFailedUpdateContextForgetJournal(
        this.#database,
      )
      .run(now + 5_000, journalId);
  }

  public nextForgetJournal(now: number): PendingContextForgetJournal | null {
    const row = queries
      .contextDeletionNextForgetJournalSelectContextForgetJournal(
        this.#database,
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
          .prepare(
            readSqliteStatement('conversation/deleteConversationEventFts'),
          )
          .run(source.id);
      }
      if (sources.length > 0) {
        const placeholders = sources.map(() => '?').join(', ');
        this.#database
          .prepare(
            readSqliteStatement(
              'context-deletion/contextDeletionStoreReplayForgetJournalUpdateConversationEvents',
              [
                placeholders,
                reason === 'discord-deleted'
                  ? readSqliteStatement(
                      'context-deletion/availableContentFilter',
                    )
                  : '',
              ],
            ),
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
      queries
        .contextDeletionReplayForgetJournalInsertContextForgetJournal(
          this.#database,
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

  #sourceForgetJournal(input: {
    readonly now: number;
    readonly payload: ContextForgetJournalEntry['payload'];
    readonly reason: 'discord-deleted' | 'locally-forgotten';
    readonly sourceScopeId: string;
  }): ContextForgetJournalEntry {
    const journalKey = `forget:${input.sourceScopeId}`;
    const entry = {
      checksum: digest({
        journalKey,
        occurredAt: input.now,
        payload: input.payload,
      }),
      journalKey,
      occurredAt: input.now,
      payload: input.payload,
    };
    this.#validateSourceForgetJournal(entry, input);
    return entry;
  }

  #validateSourceForgetJournal(
    entry: ContextForgetJournalEntry,
    expected: {
      readonly reason: 'discord-deleted' | 'locally-forgotten';
      readonly sourceScopeId: string;
    },
  ): void {
    if (
      entry.journalKey !== `forget:${expected.sourceScopeId}` ||
      entry.payload.reason !== expected.reason ||
      entry.payload.sourceScopeIds.length !== 1 ||
      entry.payload.sourceScopeIds[0] !== expected.sourceScopeId ||
      !entry.payload.tombstoneKeys.includes(`source:${expected.sourceScopeId}`)
    ) {
      throw new Error('context forget journal does not match source');
    }
    if (
      digest({
        journalKey: entry.journalKey,
        occurredAt: entry.occurredAt,
        payload: entry.payload,
      }) !== entry.checksum
    ) {
      throw new Error('context forget journal checksum mismatch');
    }
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
        .prepare(readSqliteStatement('conversation/deleteConversationEventFts'))
        .run(source.id);
    }
    if (sources.length > 0) {
      const placeholders = sources.map(() => '?').join(', ');
      this.#database
        .prepare(
          readSqliteStatement(
            'context-deletion/contextDeletionStoreMutateSuppressionUpdateConversationEvents',
            [
              placeholders,
              input.reason === 'discord-deleted'
                ? readSqliteStatement('context-deletion/availableContentFilter')
                : '',
            ],
          ),
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
        : readSqliteStatement('context-deletion/conversationSnowflakeFilter', [
            snowflakes.map(() => '?').join(', '),
          ]);
    return this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreSourceRowsSelectConversationEvents',
          [placeholders, snowflakePredicate],
        ),
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
            readSqliteStatement(
              'context-deletion/contextDeletionStoreAffectedDocumentsSelectContextDocumentEvents',
              [placeholders],
            ),
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
            readSqliteStatement(
              'context-deletion/contextDeletionStoreAffectedDocumentsSelectContextDocuments',
              [placeholders],
            ),
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
        readSqliteStatement(
          'context-deletion/contextDeletionStoreAffectedDocumentsSelectStatement',
          [values],
        ),
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
        readSqliteStatement(
          'context-deletion/contextDeletionStoreDocumentHasSurvivingLineageSelectContextDocuments',
        ),
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
        .prepare(readSqliteStatement('context/deleteContextDocumentFts'))
        .run(document.id);
      this.#database
        .prepare(readSqliteStatement('context/deleteContextDocumentVector'))
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
        readSqliteStatement(
          'context-deletion/contextDeletionStoreScrubDocumentsUpdateContextDocuments',
          [placeholders],
        ),
      )
      .run(reason, now, ...ids);
    const jobPredicates = [
      topicKeys.length === 0
        ? null
        : readSqliteStatement('context-deletion/contextJobTopicKeyFilter', [
            topicKeys.map(() => '?').join(', '),
          ]),
      topicLabels.length === 0
        ? null
        : readSqliteStatement('context-deletion/contextJobTopicLabelFilter', [
            topicLabels.map(() => '?').join(', '),
          ]),
      readSqliteStatement('context-deletion/contextJobSourceDocumentFilter', [
        placeholders,
      ]),
    ].filter((predicate): predicate is string => predicate !== null);
    this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreScrubDocumentsUpdateContextJobs',
          [jobPredicates.join(' or ')],
        ),
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
    queries
      .contextDeletionInsertTombstoneInsertContextTombstones(this.#database)
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
      const rows = queries
        .contextDeletionEnqueueRebuildsSelectConversationEvents(this.#database)
        .all(this.#guildId, this.#channelId, period.start, period.end);
      queries
        .contextDeletionEnqueueRebuildsUpdateContextJobs(this.#database)
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
      const rows = queries
        .contextDeletionEnqueueRebuildsSelectContextDocuments(this.#database)
        .all(childTier, document.periodStart, document.periodEnd);
      queries
        .contextDeletionEnqueueRebuildsUpdateContextJobs2(this.#database)
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
      const jobs = queries
        .contextDeletionEnqueueRebuildsSelectContextJobs(this.#database)
        .all(topicKey) as {
        readonly id: number;
        readonly sourceDocumentIdsJson: string;
      }[];
      for (const job of jobs) {
        const configuredIds = parseNumberIds(job.sourceDocumentIdsJson);
        const activeIds = this.#activeDocumentIds(configuredIds);
        const rows = this.#documentRevisionRows(activeIds);
        queries
          .contextDeletionEnqueueRebuildsUpdateContextJobs3(this.#database)
          .run(digest(rows), JSON.stringify(activeIds), now, now, job.id);
      }
    }
  }

  #activeDocumentIds(documentIds: readonly number[]): number[] {
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreActiveDocumentIdsSelectContextDocuments',
          [placeholders],
        ),
      )
      .pluck()
      .all(...documentIds) as number[];
  }

  #documentRevisionRows(documentIds: readonly number[]): unknown[] {
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        readSqliteStatement('context/selectContextDocumentRevisions', [
          placeholders,
        ]),
      )
      .all(...documentIds);
  }

  #memorySourceScopes(memoryIds: readonly number[]): string[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreMemorySourceScopesSelectMemories',
          [placeholders],
        ),
      )
      .pluck()
      .all(...memoryIds) as string[];
  }

  #affectedMemorySourceScopes(memoryIds: readonly number[]): string[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(', ');
    return this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreAffectedMemorySourceScopesSelectMemories',
          [placeholders],
        ),
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
        : readSqliteStatement('memory/memorySourceSnowflakeFilter', [
            snowflakes.map(() => '?').join(', '),
          ]);
    return this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreSourceDerivedMemoryIdsSelectMemories',
          [placeholders, snowflakePredicate],
        ),
      )
      .pluck()
      .all(...uniqueScopeIds, ...snowflakes) as number[];
  }

  #documentSourceScopes(documentKeys: readonly string[]): string[] {
    if (documentKeys.length === 0) return [];
    const placeholders = documentKeys.map(() => '?').join(', ');
    return this.#database
      .prepare(
        readSqliteStatement(
          'context-deletion/contextDeletionStoreDocumentSourceScopesSelectContextDocuments',
          [placeholders],
        ),
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
      const available = queries
        .contextDeletionUnavailableDocumentSourceScopesSelectConversationEvents(
          this.#database,
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
      queries
        .contextDeletionSourceBelongsToSelectConversationEvents(this.#database)
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
