import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import type { ContextForgetJournalEntry } from '../context/context-deletion-store.js';
import { verifyDatabaseMigrations } from './database.js';

const journalPayloadSchema = z
  .object({
    documentIds: z.array(z.number().int().positive()),
    documentKeys: z.array(z.string().min(1)),
    memoryIds: z.array(z.number().int().positive()),
    reason: z.enum(['discord-deleted', 'locally-forgotten']).optional(),
    sourceScopeIds: z.array(z.string().min(1)).min(1),
    tombstoneKeys: z.array(z.string().min(1)).min(1),
  })
  .strict();

const journalSchema = z
  .object({
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
    journalKey: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    payload: journalPayloadSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

export type RestorableDatabaseCapability = 'chief-v1';

export function restorableDatabaseCapability(
  database: Database.Database,
): RestorableDatabaseCapability | null {
  return verifyRestorableDatabase(database, 'chief-v1') ? 'chief-v1' : null;
}

export function verifyRestorableDatabase(
  database: Database.Database,
  requiredMigration?: string,
): boolean {
  try {
    if (!verifyDatabaseMigrations(database)) return false;
    if (
      database
        .prepare(
          readSqliteStatement(
            'recovery/recoveryVerifyRestorableDatabasePragmaStatement',
          ),
        )
        .pluck()
        .get() !== 'ok'
    ) {
      return false;
    }
    if (
      queries
        .recoveryVerifyRestorableDatabaseSelectStatement(database)
        .pluck()
        .get() !== 'v0.1.9'
    ) {
      return false;
    }
    if (requiredMigration === undefined) return true;
    if (requiredMigration !== 'chief-v1') return false;
    if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) {
      return false;
    }
    if (!verifyContextIndexes(database)) {
      return false;
    }

    const inconsistentBackfillProgress =
      queries
        .recoveryVerifyRestorableDatabaseSelectContextBackfills(database)
        .pluck()
        .get() === 1;
    if (inconsistentBackfillProgress) return false;

    const tombstones = queries
      .recoveryVerifyRestorableDatabaseSelectContextTombstones(database)
      .all() as {
      readonly checksum: string;
      readonly occurredAt: number;
      readonly reason: 'discord-deleted' | 'locally-forgotten';
      readonly scopeId: string;
      readonly scopeType: 'document' | 'source' | 'topic';
    }[];
    if (
      tombstones.some(
        (tombstone) => tombstone.checksum !== tombstoneChecksum(tombstone),
      )
    ) {
      return false;
    }
    const requiredTables = [
      'context_tombstones',
      'context_backfills',
      'context_backfill_pages',
      'context_backfill_segments',
    ];
    for (const table of requiredTables) {
      database
        .prepare(
          readSqliteStatement(
            'recovery/recoveryVerifyRestorableDatabaseSelectStatement2',
            [table],
          ),
        )
        .pluck()
        .get();
    }
    return true;
  } catch {
    return false;
  }
}

function verifyContextIndexes(database: Database.Database): boolean {
  const publicDocumentFilter = readSqliteStatement(
    'recovery/publicContextDocumentFilter',
  );
  database.exec(
    readSqliteStatement('recovery/recoveryVerifyContextIndexesDropIf', [
      publicDocumentFilter,
    ]),
  );
  try {
    const identityMismatch =
      database
        .prepare(
          readSqliteStatement(
            'recovery/recoveryVerifyContextIndexesSelectContextDocuments',
            [publicDocumentFilter],
          ),
        )
        .pluck()
        .get() === 1;
    if (identityMismatch) return false;
    const lexicalMismatch =
      database
        .prepare(
          readSqliteStatement(
            'recovery/recoveryVerifyContextIndexesSelectContextRestoreExpectedVocab',
          ),
        )
        .pluck()
        .get() === 1;
    if (lexicalMismatch) return false;
    const tierRows = database
      .prepare(
        readSqliteStatement(
          'recovery/recoveryVerifyContextIndexesSelectTiers',
          [publicDocumentFilter],
        ),
      )
      .all() as { readonly count: number; readonly tier: string }[];
    return (
      tierRows.length === 4 &&
      tierRows.every(({ tier }) =>
        ['hourly', 'daily', 'weekly', 'long-term'].includes(tier),
      )
    );
  } finally {
    database.exec(
      readSqliteStatement('recovery/recoveryVerifyContextIndexesDropIf2'),
    );
  }
}

export async function readForgetJournalDirectory(
  directory: string,
): Promise<readonly ContextForgetJournalEntry[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const entries: ContextForgetJournalEntry[] = [];
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, name), 'utf8'));
    } catch {
      throw new Error('forget journal is malformed');
    }
    const result = journalSchema.safeParse(parsed);
    if (!result.success) throw new Error('forget journal is malformed');
    const entry: ContextForgetJournalEntry = {
      checksum: result.data.checksum,
      journalKey: result.data.journalKey,
      occurredAt: result.data.occurredAt,
      payload: {
        documentIds: result.data.payload.documentIds,
        documentKeys: result.data.payload.documentKeys,
        memoryIds: result.data.payload.memoryIds,
        ...(result.data.payload.reason === undefined
          ? {}
          : { reason: result.data.payload.reason }),
        sourceScopeIds: result.data.payload.sourceScopeIds,
        tombstoneKeys: result.data.payload.tombstoneKeys,
      },
    };
    assertJournalChecksum(entry);
    entries.push(entry);
  }
  return entries;
}

export function replayForgetJournals(
  database: Database.Database,
  entries: readonly ContextForgetJournalEntry[],
  now: number,
): void {
  if (!verifyDatabaseMigrations(database)) {
    throw new Error('forget journal recovery requires a migrated database');
  }
  for (const entry of entries) assertJournalChecksum(entry);
  database.transaction(() => {
    for (const entry of entries) replayCompatibleJournal(database, entry, now);
  })();
}

function replayCompatibleJournal(
  database: Database.Database,
  entry: ContextForgetJournalEntry,
  now: number,
): void {
  const sourceIds = [
    ...new Set(
      entry.payload.sourceScopeIds.flatMap((scopeId) => [
        scopeId,
        scopeId.split('/').at(-1) ?? scopeId,
      ]),
    ),
  ];
  const conversationEventIds = selectIds(
    database,
    'conversation_events',
    'discord_message_id',
    sourceIds,
  );

  for (const eventId of conversationEventIds) {
    database
      .prepare(readSqliteStatement('conversation/deleteConversationEventFts'))
      .run(eventId);
  }
  updateIds(
    database,
    'conversation_events',
    readSqliteStatement('recovery/scrubConversationAssignments'),
    [entry.occurredAt, entry.payload.reason ?? 'locally-forgotten'],
    conversationEventIds,
  );
  scrubContextDocuments(database, entry, conversationEventIds, now);
  recordContextJournal(database, entry, now);

  scrubMemories(database, entry, sourceIds, now);
}

function scrubMemories(
  database: Database.Database,
  entry: ContextForgetJournalEntry,
  sourceIds: readonly string[],
  now: number,
): void {
  const sourceEventIds = [
    ...new Set([
      ...selectIds(database, 'source_events', 'source_scope_id', sourceIds),
      ...selectIds(database, 'source_events', 'platform_source_id', sourceIds),
    ]),
  ];
  const memoryIds = new Set(entry.payload.memoryIds);
  if (sourceEventIds.length > 0) {
    const placeholders = sourceEventIds.map(() => '?').join(', ');
    for (const id of database
      .prepare(
        readSqliteStatement('recovery/recoveryScrubMemoriesSelectMemories', [
          placeholders,
        ]),
      )
      .pluck()
      .all(...sourceEventIds) as number[]) {
      memoryIds.add(id);
    }
    database
      .prepare(
        readSqliteStatement('recovery/recoveryScrubMemoriesDeleteMemoryJobs', [
          placeholders,
        ]),
      )
      .run(...sourceEventIds);
    updateIds(
      database,
      'source_events',
      readSqliteStatement('recovery/scrubSourceAssignments'),
      [],
      sourceEventIds,
    );
  }
  const affectedMemoryIds = [...memoryIds].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  for (const id of affectedMemoryIds) {
    const state = queries
      .recoveryScrubMemoriesSelectMemories2(database)
      .pluck()
      .get(id);
    if (state !== 'active') continue;
    database.prepare(readSqliteStatement('memory/deleteMemoryFts')).run(id);
    database
      .prepare(readSqliteStatement('memory/deleteMemoryVector'))
      .run(BigInt(id));
  }
  updateIds(
    database,
    'memories',
    readSqliteStatement('recovery/scrubMemoryAssignments'),
    [now],
    affectedMemoryIds,
  );
}

function scrubContextDocuments(
  database: Database.Database,
  entry: ContextForgetJournalEntry,
  eventIds: readonly number[],
  now: number,
): void {
  // Numeric document IDs are snapshot-local and can refer to unrelated rows
  // after restore. Stable document keys and source lineage are authoritative.
  const documentIds = new Set<number>();
  if (entry.payload.documentKeys.length > 0) {
    const placeholders = entry.payload.documentKeys.map(() => '?').join(', ');
    for (const id of database
      .prepare(
        readSqliteStatement(
          'recovery/recoveryScrubContextDocumentsSelectContextDocuments',
          [placeholders],
        ),
      )
      .pluck()
      .all(...entry.payload.documentKeys) as number[]) {
      documentIds.add(id);
    }
  }
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => '?').join(', ');
    for (const id of database
      .prepare(
        readSqliteStatement(
          'recovery/recoveryScrubContextDocumentsSelectContextDocumentEvents',
          [placeholders],
        ),
      )
      .pluck()
      .all(...eventIds) as number[]) {
      documentIds.add(id);
    }
  }
  const ids = [...documentIds].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  for (const id of ids) {
    database
      .prepare(readSqliteStatement('context/deleteContextDocumentFts'))
      .run(id);
    database
      .prepare(readSqliteStatement('context/deleteContextDocumentVector'))
      .run(BigInt(id));
  }
  updateIds(
    database,
    'context_documents',
    readSqliteStatement('recovery/scrubContextAssignments'),
    [entry.payload.reason ?? 'locally-forgotten', now],
    ids,
  );
}

function recordContextJournal(
  database: Database.Database,
  entry: ContextForgetJournalEntry,
  now: number,
): void {
  const reason = entry.payload.reason ?? 'locally-forgotten';
  const tombstones = [
    ...new Set([
      ...entry.payload.tombstoneKeys,
      ...entry.payload.sourceScopeIds.map((scopeId) => `source:${scopeId}`),
    ]),
  ];
  for (const tombstoneKey of tombstones) {
    const separator = tombstoneKey.indexOf(':');
    const scopeType = tombstoneKey.slice(0, separator);
    const scopeId = tombstoneKey.slice(separator + 1);
    if (
      !['document', 'source', 'topic'].includes(scopeType) ||
      scopeId === ''
    ) {
      throw new Error('forget journal tombstone is malformed');
    }
    queries.recoveryRecordContextJournalInsertContextTombstones(database).run(
      tombstoneKey,
      scopeType,
      scopeId,
      reason,
      entry.occurredAt,
      tombstoneChecksum({
        occurredAt: entry.occurredAt,
        reason,
        scopeId,
        scopeType: scopeType as 'document' | 'source' | 'topic',
      }),
    );
  }
  const primaryTombstone = tombstones[0];
  if (primaryTombstone === undefined) {
    throw new Error('forget journal has no tombstone');
  }
  queries
    .recoveryRecordContextJournalInsertContextForgetJournal(database)
    .run(
      entry.journalKey,
      entry.payload.sourceScopeIds[0] ?? primaryTombstone,
      primaryTombstone,
      entry.occurredAt,
      entry.checksum,
      JSON.stringify(entry.payload),
      now,
    );
}

function assertJournalChecksum(entry: ContextForgetJournalEntry): void {
  const checksum = createHash('sha256')
    .update(
      JSON.stringify({
        journalKey: entry.journalKey,
        occurredAt: entry.occurredAt,
        payload: entry.payload,
      }),
    )
    .digest('hex');
  if (checksum !== entry.checksum) {
    throw new Error('forget journal checksum mismatch');
  }
}

function tombstoneChecksum(input: {
  readonly occurredAt: number;
  readonly reason: 'discord-deleted' | 'locally-forgotten';
  readonly scopeId: string;
  readonly scopeType: 'document' | 'source' | 'topic';
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        occurredAt: input.occurredAt,
        reason: input.reason,
        scopeId: input.scopeId,
        scopeType: input.scopeType,
      }),
    )
    .digest('hex');
}

function selectIds(
  database: Database.Database,
  table: string,
  column: string,
  values: readonly string[],
): number[] {
  if (values.length === 0) return [];
  const placeholders = values.map(() => '?').join(', ');
  return database
    .prepare(
      readSqliteStatement('recovery/recoverySelectIdsSelectStatement', [
        table,
        column,
        placeholders,
      ]),
    )
    .pluck()
    .all(...values) as number[];
}

function updateIds(
  database: Database.Database,
  table: string,
  assignments: string,
  values: readonly unknown[],
  ids: readonly number[],
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  database
    .prepare(
      readSqliteStatement('recovery/recoveryUpdateIdsUpdateStatement', [
        table,
        assignments,
        placeholders,
      ]),
    )
    .run(...values, ...ids);
}
