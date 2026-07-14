import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import type { ContextForgetJournalEntry } from '../context/context-deletion-store.js';
import {
  CHANNEL_CONTEXT_MIGRATION_CHECKSUM,
  CHANNEL_CONTEXT_MIGRATION_ID,
  verifyRecordedMigrationSet,
} from './database.js';

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

export type RestorableDatabaseCapability =
  '0002_conversation_events' | '0003_channel_context';

export function restorableDatabaseCapability(
  database: Database.Database,
): RestorableDatabaseCapability | null {
  if (!verifyRestorableDatabase(database)) return null;
  if (hasMigration(database, CHANNEL_CONTEXT_MIGRATION_ID)) {
    return verifyRestorableDatabase(database, CHANNEL_CONTEXT_MIGRATION_ID)
      ? CHANNEL_CONTEXT_MIGRATION_ID
      : null;
  }
  return hasMigration(database, '0002_conversation_events')
    ? '0002_conversation_events'
    : null;
}

export function verifyRestorableDatabase(
  database: Database.Database,
  requiredMigration?: string,
): boolean {
  try {
    if (!verifyRecordedMigrationSet(database)) return false;
    if (database.prepare('pragma integrity_check').pluck().get() !== 'ok') {
      return false;
    }
    if (database.prepare('select vec_version()').pluck().get() !== 'v0.1.9') {
      return false;
    }
    if (requiredMigration === undefined) return true;
    if (requiredMigration !== CHANNEL_CONTEXT_MIGRATION_ID) return false;
    const checksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(requiredMigration);
    if (checksum !== CHANNEL_CONTEXT_MIGRATION_CHECKSUM) return false;
    if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) {
      return false;
    }
    if (!verifyContextIndexes(database)) return false;
    const inconsistentBackfillProgress =
      database
        .prepare(
          `select exists(
             select 1 from context_backfills b
             where b.page_count != (
               select count(*) from context_backfill_pages p
               where p.run_id = b.id
             )
           )`,
        )
        .pluck()
        .get() === 1;
    if (inconsistentBackfillProgress) return false;
    const tombstones = database
      .prepare(
        `select scope_type as scopeType, scope_id as scopeId, reason,
                occurred_at as occurredAt, checksum
         from context_tombstones`,
      )
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
    for (const table of [
      'context_tombstones',
      'context_backfills',
      'context_backfill_pages',
      'context_backfill_segments',
    ]) {
      database.prepare(`select count(*) from ${table}`).pluck().get();
    }
    return true;
  } catch {
    return false;
  }
}

function verifyContextIndexes(database: Database.Database): boolean {
  database.exec(`
    drop table if exists temp.context_restore_actual_vocab;
    drop table if exists temp.context_restore_expected_vocab;
    drop table if exists temp.context_restore_expected_fts;
    create virtual table temp.context_restore_expected_fts using fts5(
      content, content='', contentless_delete=1
    );
    insert into temp.context_restore_expected_fts (rowid, content)
      select id, summary from context_documents
      where state = 'active' and content_state = 'available'
        and is_internal = 0;
    create virtual table temp.context_restore_actual_vocab using fts5vocab(
      main, context_document_fts, instance
    );
    create virtual table temp.context_restore_expected_vocab using fts5vocab(
      temp, context_restore_expected_fts, instance
    );
  `);
  try {
    const identityMismatch =
      database
        .prepare(
          `with expected(id) as (
             select id from context_documents
             where state = 'active' and content_state = 'available'
               and is_internal = 0
           )
           select
             exists(
               select id from expected
               except select rowid from context_document_fts
             ) or exists(
               select rowid from context_document_fts
               except select id from expected
             ) or exists(
               select id from expected
               except select document_id from context_document_vectors
             ) or exists(
               select document_id from context_document_vectors
               except select id from expected
             )`,
        )
        .pluck()
        .get() === 1;
    if (identityMismatch) return false;
    const lexicalMismatch =
      database
        .prepare(
          `select
             exists(
               select term, doc, col, offset
               from context_restore_expected_vocab
               except
               select term, doc, col, offset
               from context_restore_actual_vocab
             ) or exists(
               select term, doc, col, offset
               from context_restore_actual_vocab
               except
               select term, doc, col, offset
               from context_restore_expected_vocab
             )`,
        )
        .pluck()
        .get() === 1;
    if (lexicalMismatch) return false;
    const tierRows = database
      .prepare(
        `with tiers(tier) as (
           values ('hourly'), ('daily'), ('weekly'), ('long-term')
         )
         select t.tier, count(d.id) as count
         from tiers t
         left join context_documents d
           on d.tier = t.tier and d.state = 'active'
          and d.content_state = 'available' and d.is_internal = 0
         left join context_document_fts f on f.rowid = d.id
         left join context_document_vectors v on v.document_id = d.id
         group by t.tier order by t.tier`,
      )
      .all() as { readonly count: number; readonly tier: string }[];
    return (
      tierRows.length === 4 &&
      tierRows.every(({ tier }) =>
        ['hourly', 'daily', 'weekly', 'long-term'].includes(tier),
      )
    );
  } finally {
    database.exec(`
      drop table if exists temp.context_restore_actual_vocab;
      drop table if exists temp.context_restore_expected_vocab;
      drop table if exists temp.context_restore_expected_fts;
    `);
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
  if (!verifyRecordedMigrationSet(database)) {
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
  const contextSchema = hasMigration(database, CHANNEL_CONTEXT_MIGRATION_ID);
  const sourceIds = [
    ...new Set(
      entry.payload.sourceScopeIds.flatMap((scopeId) => [
        scopeId,
        scopeId.split('/').at(-1) ?? scopeId,
      ]),
    ),
  ];
  const conversationColumns = tableColumns(database, 'conversation_events');
  const conversationIdColumn = conversationColumns.has('discord_message_id')
    ? 'discord_message_id'
    : 'platform_event_id';
  const conversationEventIds = selectIds(
    database,
    'conversation_events',
    conversationIdColumn,
    sourceIds,
  );
  if (contextSchema) {
    for (const eventId of conversationEventIds) {
      database
        .prepare('delete from conversation_event_fts where rowid = ?')
        .run(eventId);
    }
    updateIds(
      database,
      'conversation_events',
      `content = '', attachment_metadata_json = '[]', deleted_at = ?,
       content_state = 'scrubbed', content_state_reason = ?`,
      [entry.occurredAt, entry.payload.reason ?? 'locally-forgotten'],
      conversationEventIds,
    );
    scrubContextDocuments(database, entry, conversationEventIds, now);
    recordContextJournal(database, entry, now);
  } else {
    updateIds(
      database,
      'conversation_events',
      "content = ''",
      [],
      conversationEventIds,
    );
  }
  scrubMemories(database, entry, sourceIds, now);
}

function scrubMemories(
  database: Database.Database,
  entry: ContextForgetJournalEntry,
  sourceIds: readonly string[],
  now: number,
): void {
  const sourceColumns = tableColumns(database, 'source_events');
  const sourceIdColumn = sourceColumns.has('source_scope_id')
    ? 'source_scope_id'
    : 'platform_source_id';
  const sourceEventIds = selectIds(
    database,
    'source_events',
    sourceIdColumn,
    sourceIds,
  );
  const memoryIds = new Set(entry.payload.memoryIds);
  if (sourceEventIds.length > 0) {
    const placeholders = sourceEventIds.map(() => '?').join(', ');
    for (const id of database
      .prepare(
        `select id from memories where source_event_id in (${placeholders})`,
      )
      .pluck()
      .all(...sourceEventIds) as number[]) {
      memoryIds.add(id);
    }
    database
      .prepare(
        `delete from memory_jobs where source_event_id in (${placeholders})`,
      )
      .run(...sourceEventIds);
    updateIds(
      database,
      'source_events',
      "content = '', extraction_status = 'completed'",
      [],
      sourceEventIds,
    );
  }
  const affectedMemoryIds = [...memoryIds].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  for (const id of affectedMemoryIds) {
    const state = database
      .prepare('select state from memories where id = ?')
      .pluck()
      .get(id);
    if (state !== 'active') continue;
    database.prepare('delete from memory_fts where rowid = ?').run(id);
    database
      .prepare('delete from memory_vectors where memory_id = ?')
      .run(BigInt(id));
  }
  updateIds(
    database,
    'memories',
    "canonical_text = '', provenance_json = '{}', state = 'superseded', superseded_by = null, updated_at = ?",
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
        `select id from context_documents where document_key in (${placeholders})`,
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
        `with recursive affected(id) as (
           select document_id from context_document_events
           where event_id in (${placeholders})
           union
           select p.document_id from context_document_parents p
           join affected a on a.id = p.parent_document_id
         ) select id from affected`,
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
      .prepare('delete from context_document_fts where rowid = ?')
      .run(id);
    database
      .prepare('delete from context_document_vectors where document_id = ?')
      .run(BigInt(id));
  }
  updateIds(
    database,
    'context_documents',
    "summary = '', state = 'suppressed', content_state = 'scrubbed', content_state_reason = ?, updated_at = ?",
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
    database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, ?, ?, ?, ?, ?)
         on conflict(tombstone_key) do nothing`,
      )
      .run(
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
  const columns = tableColumns(database, 'context_forget_journal');
  if (columns.has('payload_json')) {
    database
      .prepare(
        `insert into context_forget_journal
           (journal_key, scope_id, tombstone_key, occurred_at, checksum,
            payload_json, upload_status, uploaded_at)
         values (?, ?, ?, ?, ?, ?, 'uploaded', ?)
         on conflict(journal_key) do update set
           upload_status = 'uploaded', uploaded_at = excluded.uploaded_at`,
      )
      .run(
        entry.journalKey,
        entry.payload.sourceScopeIds[0] ?? primaryTombstone,
        primaryTombstone,
        entry.occurredAt,
        entry.checksum,
        JSON.stringify(entry.payload),
        now,
      );
  } else {
    database
      .prepare(
        `insert into context_forget_journal
           (journal_key, scope_id, tombstone_key, occurred_at, checksum,
            upload_status, uploaded_at)
         values (?, ?, ?, ?, ?, 'uploaded', ?)
         on conflict(journal_key) do update set
           upload_status = 'uploaded', uploaded_at = excluded.uploaded_at`,
      )
      .run(
        entry.journalKey,
        entry.payload.sourceScopeIds[0] ?? primaryTombstone,
        primaryTombstone,
        entry.occurredAt,
        entry.checksum,
        now,
      );
  }
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

function hasMigration(
  database: Database.Database,
  migrationId: string,
): boolean {
  return (
    database
      .prepare('select exists(select 1 from schema_migrations where id = ?)')
      .pluck()
      .get(migrationId) === 1
  );
}

function tableColumns(database: Database.Database, table: string): Set<string> {
  return new Set(
    (
      database.pragma(`table_info(${table})`) as { readonly name: string }[]
    ).map(({ name }) => name),
  );
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
    .prepare(`select id from ${table} where ${column} in (${placeholders})`)
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
    .prepare(`update ${table} set ${assignments} where id in (${placeholders})`)
    .run(...values, ...ids);
}
