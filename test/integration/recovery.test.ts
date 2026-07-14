import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ContextForgetJournalEntry } from '../../src/context/context-deletion-store.js';
import { ContextDeletionStore } from '../../src/context/context-deletion-store.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import { backupChiefDatabase } from '../../src/memory/backup.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import {
  readForgetJournalDirectory,
  replayForgetJournals,
  restorableDatabaseCapability,
  verifyRestorableDatabase,
} from '../../src/memory/recovery.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('database recovery', () => {
  it('validates recorded migrations by default and requires context explicitly', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database, '0002_conversation_events');

    expect(restorableDatabaseCapability(database)).toBe(
      '0002_conversation_events',
    );
    expect(verifyRestorableDatabase(database)).toBe(true);
    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      false,
    );
    database
      .prepare(
        "update schema_migrations set checksum = 'tampered' where id = '0002_conversation_events'",
      )
      .run();
    expect(restorableDatabaseCapability(database)).toBeNull();
    expect(verifyRestorableDatabase(database)).toBe(false);
    database.close();
  });

  it('checks context FTS/vector consistency in explicit context mode', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);

    expect(restorableDatabaseCapability(database)).toBe('0003_channel_context');
    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      true,
    );
    database
      .prepare(
        "insert into context_document_fts (rowid, content) values (999, 'orphan')",
      )
      .run();
    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      false,
    );
    database.close();
  });

  it('rejects same-count context FTS content corruption', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const documentId = insertContextDocument(
      database,
      'restore-lexical-target',
      recordContextSource(database, 'restore-lexical-source'),
    );
    database
      .prepare('delete from context_document_fts where rowid = ?')
      .run(documentId);
    database
      .prepare(
        'insert into context_document_fts (rowid, content) values (?, ?)',
      )
      .run(documentId, 'corrupted replacement');

    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      false,
    );
    database.close();
  });

  it('rejects a same-count vector attached to an orphan document ID', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const documentId = insertContextDocument(
      database,
      'restore-vector-target',
      recordContextSource(database, 'restore-vector-source'),
    );
    database
      .prepare('delete from context_document_vectors where document_id = ?')
      .run(BigInt(documentId));
    database
      .prepare(
        'insert into context_document_vectors (document_id, embedding) values (?, ?)',
      )
      .run(BigInt(999), JSON.stringify(Array(1536).fill(0)));

    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      false,
    );
    database.close();
  });

  it('checks retained tombstones and backfill progress in context mode', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    database
      .prepare(
        `insert into context_backfills
           (run_key, scope_id, status, page_count, created_at, updated_at)
         values ('restore-progress', 'guild/channel', 'dry-run', 1, 1, 1)`,
      )
      .run();
    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      false,
    );
    database
      .prepare(
        `update context_backfills set page_count = 0
         where run_key = 'restore-progress'`,
      )
      .run();
    database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values ('source:guild/channel/message', 'source',
                 'guild/channel/message', 'locally-forgotten', 1, 'invalid')`,
      )
      .run();
    expect(verifyRestorableDatabase(database, '0003_channel_context')).toBe(
      false,
    );
    database.close();
  });

  it('replays a verified journal into a migration-0002 snapshot idempotently', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database, '0002_conversation_events');
    database
      .prepare(
        `insert into conversation_events
           (platform_event_id, role, speaker_id, speaker_name, medium, content,
            occurred_at, retention_deadline)
         values ('message-1', 'human', 'speaker', 'President', 'text',
                 'forgotten conversation', 1, 999999)`,
      )
      .run();
    const sourceId = Number(
      database
        .prepare(
          `insert into source_events
             (platform_source_id, speaker_id, medium, content, occurred_at,
              retention_deadline, extraction_status)
           values ('message-1', 'speaker', 'text', 'forgotten source', 1,
                   999999, 'completed')`,
        )
        .run().lastInsertRowid,
    );
    const memoryId = Number(
      database
        .prepare(
          `insert into memories
             (source_event_id, canonical_text, kind, confidence,
              provenance_json, state, created_at, updated_at)
           values (?, 'forgotten memory', 'fact', 0.9, '{"private":true}',
                   'active', 1, 1)`,
        )
        .run(sourceId).lastInsertRowid,
    );
    database
      .prepare('insert into memory_fts (rowid, canonical_text) values (?, ?)')
      .run(memoryId, 'forgotten memory');
    database
      .prepare(
        'insert into memory_vectors (memory_id, embedding) values (?, ?)',
      )
      .run(BigInt(memoryId), JSON.stringify(Array(1536).fill(0)));
    const entry = journal({ memoryIds: [memoryId] });

    replayForgetJournals(database, [entry], 10);
    replayForgetJournals(database, [entry], 11);

    expect(
      database.prepare('select content from conversation_events').pluck().get(),
    ).toBe('');
    expect(
      database.prepare('select content from source_events').pluck().get(),
    ).toBe('');
    expect(
      database.prepare('select canonical_text from memories').pluck().get(),
    ).toBe('');
    expect(
      database
        .prepare(
          "select count(*) from memory_fts where memory_fts match 'forgotten'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('replays a real memory-only forget into a migration-0002 snapshot', () => {
    const sourceScopeId = 'guild/channel/memory-message';
    const current = openChiefDatabase(':memory:');
    migrateChiefDatabase(current);
    const currentMemory = new SqliteMemoryStore(current);
    const currentSourceId = currentMemory.observe({
      content: 'memory-only forgotten source',
      medium: 'text',
      occurredAt: 1,
      platformSourceId: 'memory-message',
      retentionDeadline: 99_999,
      sourceScopeId,
      speakerId: 'speaker',
    });
    const currentMemoryId = currentMemory.applyMemory({
      canonicalText: 'memory-only forgotten fact',
      confidence: 0.9,
      embedding: new Float32Array(1536),
      kind: 'fact',
      provenance: {},
      sourceEventId: currentSourceId,
      timestamp: 2,
    });
    const { journal: entry } = new ContextDeletionStore({
      channelId: 'channel',
      database: current,
      guildId: 'guild',
      memory: currentMemory,
      timeZone: 'America/New_York',
    }).delete({
      candidates: {
        documentKeys: [],
        memoryIds: [currentMemoryId],
        sourceScopeIds: [],
      },
      now: 5,
    });

    expect(entry.payload.sourceScopeIds).toContain(sourceScopeId);

    const restored = openChiefDatabase(':memory:');
    migrateChiefDatabase(restored, '0002_conversation_events');
    const restoredSourceId = Number(
      restored
        .prepare(
          `insert into source_events
             (platform_source_id, speaker_id, medium, content, occurred_at,
              retention_deadline, extraction_status)
           values ('memory-message', 'speaker', 'text',
                   'memory-only forgotten source', 1, 99999, 'pending')`,
        )
        .run().lastInsertRowid,
    );
    restored
      .prepare(
        `insert into memory_jobs (source_event_id, not_before)
         values (?, 1)`,
      )
      .run(restoredSourceId);
    const restoredMemoryId = Number(
      restored
        .prepare(
          `insert into memories
             (source_event_id, canonical_text, kind, confidence,
              provenance_json, state, created_at, updated_at)
           values (?, 'memory-only forgotten fact', 'fact', 0.9, '{}',
                   'active', 1, 1)`,
        )
        .run(restoredSourceId).lastInsertRowid,
    );
    expect(restoredMemoryId).toBe(currentMemoryId);
    restored
      .prepare('insert into memory_fts (rowid, canonical_text) values (?, ?)')
      .run(restoredMemoryId, 'memory-only forgotten fact');
    restored
      .prepare(
        'insert into memory_vectors (memory_id, embedding) values (?, ?)',
      )
      .run(BigInt(restoredMemoryId), JSON.stringify(Array(1536).fill(0)));

    replayForgetJournals(restored, [entry], 10);

    expect(
      restored.prepare('select content from source_events').pluck().get(),
    ).toBe('');
    expect(
      restored.prepare('select count(*) from memory_jobs').pluck().get(),
    ).toBe(0);
    expect(
      restored.prepare('select canonical_text from memories').pluck().get(),
    ).toBe('');
    expect(
      restored
        .prepare(
          "select count(*) from memory_fts where memory_fts match 'forgotten'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      restored.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(0);
    restored.close();
    current.close();
  });

  it('replays current context by stable keys, not snapshot-local document IDs', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const eventId = new ConversationStore(database).record({
      attachmentMetadataJson: '[]',
      channelId: 'channel',
      content: 'forgotten current source',
      discordMessageId: 'message-1',
      editedAt: null,
      guildId: 'guild',
      logicalResponseId: null,
      medium: 'text',
      occurredAt: 1,
      platformEventId: 'message-1',
      recentUntil: 1_000,
      replyToMessageId: null,
      requestId: 'message-1',
      responseChunkIndex: null,
      retentionDeadline: 2_000,
      revisionChecksum: 'revision',
      role: 'human',
      speakerId: 'speaker',
      speakerName: 'President',
    });
    const targetId = insertContextDocument(database, 'stable-target', eventId);
    const unrelatedEventId = new ConversationStore(database).record({
      attachmentMetadataJson: '[]',
      channelId: 'channel',
      content: 'unrelated current source',
      discordMessageId: 'message-2',
      editedAt: null,
      guildId: 'guild',
      logicalResponseId: null,
      medium: 'text',
      occurredAt: 2,
      platformEventId: 'message-2',
      recentUntil: 1_000,
      replyToMessageId: null,
      requestId: 'message-2',
      responseChunkIndex: null,
      retentionDeadline: 2_000,
      revisionChecksum: 'revision-2',
      role: 'human',
      speakerId: 'speaker',
      speakerName: 'President',
    });
    const unrelatedId = insertContextDocument(
      database,
      'unrelated-current-row',
      unrelatedEventId,
    );
    const entry = journal({
      documentIds: [unrelatedId],
      documentKeys: ['stable-target'],
    });

    replayForgetJournals(database, [entry], 10);

    expect(
      database
        .prepare('select state from context_documents where id = ?')
        .pluck()
        .get(targetId),
    ).toBe('suppressed');
    expect(
      database
        .prepare('select state from context_documents where id = ?')
        .pluck()
        .get(unrelatedId),
    ).toBe('active');
    expect(
      database
        .prepare('select upload_status from context_forget_journal')
        .pluck()
        .get(),
    ).toBe('uploaded');
    database.close();
  });

  it('loads only checksum-valid schema-versioned journals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-journals-'));
    directories.push(directory);
    const entry = journal();
    await writeFile(
      join(directory, 'valid.json'),
      JSON.stringify({ ...entry, schemaVersion: 1 }),
    );
    await expect(readForgetJournalDirectory(directory)).resolves.toEqual([
      entry,
    ]);
    await writeFile(
      join(directory, 'invalid.json'),
      JSON.stringify({ ...entry, checksum: 'b'.repeat(64), schemaVersion: 1 }),
    );
    await expect(readForgetJournalDirectory(directory)).rejects.toThrow(
      /checksum/u,
    );
    await rm(join(directory, 'invalid.json'));
    await writeFile(
      join(directory, 'contains-text.json'),
      JSON.stringify({
        ...entry,
        deletedText: 'must never enter a recovery journal',
        schemaVersion: 1,
      }),
    );
    await expect(readForgetJournalDirectory(directory)).rejects.toThrow(
      /malformed/u,
    );
  });

  it('creates backup recovery artifacts mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-backup-mode-'));
    directories.push(directory);
    const source = join(directory, 'chief.db');
    const database = openChiefDatabase(source);
    migrateChiefDatabase(database);
    new ConversationStore(database);
    database.close();

    const backup = await backupChiefDatabase(
      source,
      join(directory, 'backups'),
    );

    expect((await stat(backup)).mode & 0o777).toBe(0o600);
  });
});

function journal(
  input: {
    readonly documentIds?: readonly number[];
    readonly documentKeys?: readonly string[];
    readonly memoryIds?: readonly number[];
  } = {},
): ContextForgetJournalEntry {
  const journalKey = 'forget:guild/channel/message-1';
  const occurredAt = 5;
  const payload = {
    documentIds: input.documentIds ?? [],
    documentKeys: input.documentKeys ?? [],
    memoryIds: input.memoryIds ?? [],
    reason: 'locally-forgotten' as const,
    sourceScopeIds: ['guild/channel/message-1'],
    tombstoneKeys: ['source:guild/channel/message-1'],
  };
  return {
    checksum: createHash('sha256')
      .update(JSON.stringify({ journalKey, occurredAt, payload }))
      .digest('hex'),
    journalKey,
    occurredAt,
    payload,
  };
}

function insertContextDocument(
  database: ReturnType<typeof openChiefDatabase>,
  documentKey: string,
  eventId: number,
): number {
  const id = Number(
    database
      .prepare(
        `insert into context_documents
           (document_key, tier, period_start, period_end, timezone, topic_key,
            revision, completeness, state, content_state,
            content_state_reason, summary, confidence, retention_deadline,
            created_at, updated_at, generation_input_tokens,
            generation_output_tokens, generation_usage_usd, is_internal)
         values (?, 'hourly', 0, 10, 'America/New_York', null, 1, 'final',
                 'active', 'available', 'retained', 'searchable summary', 0.9,
                 null, 1, 1, 1, 1, 0, 0)`,
      )
      .run(documentKey).lastInsertRowid,
  );
  database
    .prepare(
      'insert into context_document_events (document_id, event_id) values (?, ?)',
    )
    .run(id, eventId);
  database
    .prepare('insert into context_document_fts (rowid, content) values (?, ?)')
    .run(id, 'searchable summary');
  database
    .prepare(
      'insert into context_document_vectors (document_id, embedding) values (?, ?)',
    )
    .run(BigInt(id), JSON.stringify(Array(1536).fill(0)));
  return id;
}

function recordContextSource(
  database: ReturnType<typeof openChiefDatabase>,
  messageId: string,
): number {
  return new ConversationStore(database).record({
    attachmentMetadataJson: '[]',
    channelId: 'channel',
    content: 'restore verification source',
    discordMessageId: messageId,
    editedAt: null,
    guildId: 'guild',
    logicalResponseId: null,
    medium: 'text',
    occurredAt: 1,
    platformEventId: messageId,
    recentUntil: 1_000,
    replyToMessageId: null,
    requestId: messageId,
    responseChunkIndex: null,
    retentionDeadline: 2_000,
    revisionChecksum: `revision-${messageId}`,
    role: 'human',
    speakerId: 'speaker',
    speakerName: 'President',
  });
}
