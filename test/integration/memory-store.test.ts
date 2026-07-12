import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const directories: string[] = [];
const embedding = (value: number): Float32Array =>
  new Float32Array(1_536).fill(value);

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createStore(): Promise<{
  database: ReturnType<typeof openChiefDatabase>;
  directory: string;
  store: SqliteMemoryStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'chief-memory-'));
  directories.push(directory);
  const database = openChiefDatabase(join(directory, 'chief.db'));
  migrateChiefDatabase(database);
  return { database, directory, store: new SqliteMemoryStore(database) };
}

describe('SqliteMemoryStore', () => {
  it('persists observation and restart-safe extraction work', async () => {
    const { database, store } = await createStore();
    const sourceId = store.observe({
      content: 'We meet at noon',
      medium: 'text',
      occurredAt: 100,
      platformSourceId: 'message-1',
      retentionDeadline: 200,
      speakerId: 'president-1',
    });

    const job = store.leaseNextJob(110, 30);
    expect(job).toMatchObject({ attemptCount: 1, sourceEventId: sourceId });
    if (job === null) throw new Error('expected a leased job');
    store.deferForBudget(job.id, 1_000);

    expect(store.leaseNextJob(999, 30)).toBeNull();
    expect(
      database
        .prepare('select attempt_count from memory_jobs where id = ?')
        .pluck()
        .get(job.id),
    ).toBe(0);
    database.close();
  });

  it('retrieves active memories with lexical and vector evidence', async () => {
    const { database, store } = await createStore();
    const sourceId = store.observe({
      content: 'The cabinet meets at noon',
      medium: 'text',
      occurredAt: 100,
      platformSourceId: 'message-2',
      retentionDeadline: 200,
      speakerId: 'president-1',
    });
    store.applyMemory({
      canonicalText: 'The cabinet meets at noon',
      confidence: 0.95,
      embedding: embedding(0.25),
      kind: 'plan',
      provenance: { platformSourceId: 'message-2' },
      sourceEventId: sourceId,
      timestamp: 120,
    });

    const results = store.retrieve({
      embedding: embedding(0.25),
      limit: 5,
      now: 130,
      text: 'cabinet noon',
    });

    expect(results[0]).toMatchObject({
      canonicalText: 'The cabinet meets at noon',
      kind: 'plan',
    });
    database.close();
  });

  it('preserves pending sources and expires completed raw sources', async () => {
    const { database, store } = await createStore();
    const sourceId = store.observe({
      content: 'A durable fact',
      medium: 'text',
      occurredAt: 1,
      platformSourceId: 'message-3',
      retentionDeadline: 2,
      speakerId: 'president-1',
    });

    expect(store.maintain(3).deletedSources).toBe(0);
    const job = store.leaseNextJob(3, 30);
    if (job === null) throw new Error('expected a leased job');
    store.completeJob(job.id);
    expect(store.maintain(4).deletedSources).toBe(1);
    expect(
      database
        .prepare('select 1 from source_events where id = ?')
        .get(sourceId),
    ).toBeUndefined();
    database.close();
  });

  it('creates a restorable online backup', async () => {
    const { database, directory, store } = await createStore();
    store.observe({
      content: 'Back this up',
      medium: 'text',
      occurredAt: 1,
      platformSourceId: 'message-4',
      retentionDeadline: 100,
      speakerId: 'president-1',
    });
    new ConversationStore(database).record({
      content: 'The cabinet meets at noon.',
      medium: 'text',
      occurredAt: 1,
      platformEventId: 'discord:text:message-4',
      requestId: 'message-4',
      retentionDeadline: 100,
      role: 'human',
      speakerId: 'president-1',
      speakerName: 'President One',
    });
    const backupPath = join(directory, 'backup.db');

    await store.backup(backupPath);
    const restored = openChiefDatabase(backupPath);

    expect(
      restored.prepare('select count(*) from source_events').pluck().get(),
    ).toBe(1);
    expect(
      restored.prepare('select content from conversation_events').pluck().get(),
    ).toBe('The cabinet meets at noon.');
    restored.close();
    database.close();
  });

  it('supersedes corrections and retrieves only the replacement', async () => {
    const { database, store } = await createStore();
    const originalId = store.applyMemory({
      canonicalText: 'Dinner is at six',
      confidence: 0.8,
      embedding: embedding(0.1),
      kind: 'plan',
      provenance: { platformSourceId: 'message-5' },
      sourceEventId: null,
      timestamp: 1,
    });

    const replacementId = store.supersede(originalId, {
      canonicalText: 'Dinner is at seven',
      confidence: 0.99,
      embedding: embedding(0.2),
      kind: 'plan',
      provenance: { platformSourceId: 'message-6' },
      sourceEventId: null,
      timestamp: 2,
    });

    expect(
      database
        .prepare('select state, superseded_by from memories where id = ?')
        .get(originalId),
    ).toEqual({ state: 'superseded', superseded_by: replacementId });
    expect(
      store.retrieve({
        embedding: embedding(0.2),
        limit: 5,
        now: 3,
        text: 'dinner',
      }),
    ).toEqual([
      expect.objectContaining({ canonicalText: 'Dinner is at seven' }),
    ]);
    database.close();
  });

  it('forgets indexes and deletes an otherwise unreferenced source', async () => {
    const { database, store } = await createStore();
    const sourceId = store.observe({
      content: 'Forget this',
      medium: 'text',
      occurredAt: 1,
      platformSourceId: 'message-7',
      retentionDeadline: 100,
      speakerId: 'president-1',
    });
    const job = store.leaseNextJob(1, 30);
    if (job === null) throw new Error('expected a leased job');
    store.completeJob(job.id);
    const memoryId = store.applyMemory({
      canonicalText: 'A regrettable karaoke performance',
      confidence: 0.9,
      embedding: embedding(0.3),
      kind: 'joke',
      provenance: { platformSourceId: 'message-7' },
      sourceEventId: sourceId,
      timestamp: 2,
    });

    expect(store.forget(memoryId)).toEqual({
      deleted: true,
      sourceDeleted: true,
    });
    expect(
      database
        .prepare('select 1 from memory_fts where rowid = ?')
        .get(memoryId),
    ).toBeUndefined();
    expect(
      database
        .prepare('select 1 from memory_vectors where memory_id = ?')
        .get(BigInt(memoryId)),
    ).toBeUndefined();
    expect(
      database
        .prepare('select 1 from source_events where id = ?')
        .get(sourceId),
    ).toBeUndefined();
    database.close();
  });

  it('builds bounded conversational context from hybrid retrieval', async () => {
    const { database, store } = await createStore();
    store.applyMemory({
      canonicalText: 'The trip is in October',
      confidence: 0.9,
      embedding: embedding(0.5),
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    const context = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: () =>
        Promise.resolve({ embedding: embedding(0.5), usageUsd: 0.001 }),
      estimateUsd: 0.1,
      extract: () => Promise.resolve({ proposals: [], usageUsd: 0 }),
      limit: 1,
      store,
    });

    await expect(context.recall('trip October')).resolves.toEqual({
      memories: ['The trip is in October'],
      usageUsd: 0.001,
    });
    database.close();
  });

  it('covers missing, retry, conflict, and invalid supersession paths', async () => {
    const { database, store } = await createStore();
    expect(store.leaseNextJob(1, 10)).toBeNull();
    expect(store.forget(999)).toEqual({ deleted: false, sourceDeleted: false });
    expect(() => store.retryJob(999, 2, 3)).toThrow(/not found/u);

    const left = store.applyMemory({
      canonicalText: 'Dinner is at six',
      confidence: 0.8,
      embedding: embedding(0.1),
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    const right = store.applyMemory({
      canonicalText: 'Dinner is at seven',
      confidence: 0.8,
      embedding: embedding(0.2),
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    store.recordConflict(right, left);
    store.recordConflict(left, right);
    expect(
      database.prepare('select count(*) from memory_conflicts').pluck().get(),
    ).toBe(1);
    expect(() =>
      store.supersede(999, {
        canonicalText: 'missing',
        confidence: 1,
        embedding: embedding(0),
        kind: 'fact',
        provenance: {},
        sourceEventId: null,
        timestamp: 2,
      }),
    ).toThrow(/not found/u);
    database.close();
  });

  it('consolidates exact active duplicates during maintenance', async () => {
    const { database, store } = await createStore();
    for (const confidence of [0.7, 0.95]) {
      store.applyMemory({
        canonicalText: 'The trip is in October',
        confidence,
        embedding: embedding(confidence),
        kind: 'plan',
        provenance: {},
        sourceEventId: null,
        timestamp: confidence * 100,
      });
    }

    expect(store.maintain(1_000).consolidatedMemories).toBe(1);
    expect(
      database
        .prepare("select count(*) from memories where state = 'active'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      database.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(1);
    database.close();
  });
});
