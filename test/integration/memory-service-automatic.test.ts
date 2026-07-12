import { describe, expect, it, vi } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const vector = new Float32Array(1_536).fill(0.4);

describe('MemoryService automatic extraction', () => {
  it('extracts and embeds an accepted durable memory', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    store.observe({
      content: 'Chief, remember that our annual trip is in October.',
      medium: 'text',
      occurredAt: 100,
      platformSourceId: 'message-1',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    });
    const worker = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(() =>
        Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      ),
      estimateUsd: 0.1,
      extract: vi.fn(() =>
        Promise.resolve({
          proposals: [
            {
              action: 'create' as const,
              canonicalText: 'The group annual trip is in October.',
              confidence: 0.99,
              kind: 'plan',
              sensitivity: 'none' as const,
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      ),
      store,
    });

    await expect(worker.runAutomaticOne(110)).resolves.toEqual({
      status: 'completed',
    });
    expect(
      store.retrieve({
        embedding: vector,
        limit: 3,
        now: 120,
        text: 'trip October',
      }),
    ).toEqual([
      expect.objectContaining({
        canonicalText: 'The group annual trip is in October.',
      }),
    ]);
    expect(
      database
        .prepare('select extraction_status from source_events')
        .pluck()
        .get(),
    ).toBe('completed');
    database.close();
  });

  it('rejects sensitive and low-confidence automatic proposals', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    store.observe({
      content: 'Some passing conversation',
      medium: 'text',
      occurredAt: 100,
      platformSourceId: 'message-2',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    });
    const embed = vi.fn(() =>
      Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
    );
    const worker = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed,
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'create' as const,
              canonicalText: 'The exact home address is 1 Secret Lane.',
              confidence: 0.99,
              kind: 'fact',
              sensitivity: 'sensitive' as const,
              targetMemoryId: null,
            },
            {
              action: 'create' as const,
              canonicalText: 'Someone may prefer tea.',
              confidence: 0.6,
              kind: 'preference',
              sensitivity: 'none' as const,
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });

    await worker.runAutomaticOne(110);
    expect(embed).not.toHaveBeenCalled();
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('defers without consuming an attempt when the budget is exhausted', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    store.observe({
      content: 'Remember this later',
      medium: 'text',
      occurredAt: 100,
      platformSourceId: 'message-3',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    });
    const budget = new UsageBudget({ ceilingUsd: 1, warningUsd: 0.5 });
    budget.recordActual(1);
    const extract = vi.fn();
    const worker = new MemoryService({
      budget,
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract,
      store,
    });

    await expect(worker.runAutomaticOne(110)).resolves.toEqual({
      notBefore: Date.UTC(1970, 1, 1),
      status: 'budget-deferred',
    });
    expect(extract).not.toHaveBeenCalled();
    expect(
      database.prepare('select attempt_count from memory_jobs').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('reports idle and terminates a repeatedly failing job', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const worker = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: () => Promise.reject(new Error('transient provider failure')),
      maxAttempts: 1,
      store,
    });
    await expect(worker.runAutomaticOne(1)).resolves.toEqual({
      status: 'idle',
    });
    store.observe({
      content: 'Remember this',
      medium: 'text',
      occurredAt: 2,
      platformSourceId: 'message-failure',
      retentionDeadline: 100,
      speakerId: 'president-1',
    });
    await expect(worker.runAutomaticOne(2)).resolves.toEqual({
      status: 'failed',
    });
    expect(
      database.prepare('select status from memory_jobs').pluck().get(),
    ).toBe('failed');
    database.close();
  });

  it('handles a natural-language forget request without a model call', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    store.applyMemory({
      canonicalText: 'Dinner is at seven',
      confidence: 0.9,
      embedding: vector,
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    store.observe({
      content: 'Chief, forget that dinner is at seven',
      medium: 'text',
      occurredAt: 2,
      platformSourceId: 'message-forget',
      retentionDeadline: 100,
      speakerId: 'president-1',
    });
    const extract = vi.fn();
    const worker = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract,
      store,
    });

    await expect(worker.runAutomaticOne(2)).resolves.toEqual({
      status: 'completed',
    });
    expect(extract).not.toHaveBeenCalled();
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('applies conflict and supersession actions while skipping no-ops', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const originalId = store.applyMemory({
      canonicalText: 'Dinner is at seven',
      confidence: 0.9,
      embedding: vector,
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    store.observe({
      content: 'Dinner changed and another plan conflicts',
      medium: 'text',
      occurredAt: 2,
      platformSourceId: 'message-actions',
      retentionDeadline: 100,
      speakerId: 'president-1',
    });
    const embed = vi.fn(() =>
      Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
    );
    const worker = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed,
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'no-op' as const,
              canonicalText: '',
              confidence: 0,
              kind: 'none',
              sensitivity: 'none' as const,
              targetMemoryId: null,
            },
            {
              action: 'forget' as const,
              canonicalText: '',
              confidence: 1,
              kind: 'none',
              sensitivity: 'none' as const,
              targetMemoryId: null,
            },
            {
              action: 'create' as const,
              canonicalText: '   ',
              confidence: 0.99,
              kind: 'fact',
              sensitivity: 'none' as const,
              targetMemoryId: null,
            },
            {
              action: 'conflict' as const,
              canonicalText: 'Dinner might be at eight',
              confidence: 0.95,
              kind: 'plan',
              sensitivity: 'none' as const,
              targetMemoryId: originalId,
            },
            {
              action: 'supersede' as const,
              canonicalText: 'Dinner is at nine',
              confidence: 0.99,
              kind: 'plan',
              sensitivity: 'none' as const,
              targetMemoryId: originalId,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });

    await expect(worker.runAutomaticOne(3)).resolves.toEqual({
      status: 'completed',
    });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(
      database.prepare('select count(*) from memory_conflicts').pluck().get(),
    ).toBe(1);
    expect(
      database
        .prepare("select count(*) from memories where state = 'active'")
        .pluck()
        .get(),
    ).toBe(2);
    database.close();
  });

  it('completes a forget request when no memory matches', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    store.observe({
      content: 'Chief, forget that nonexistent plan',
      medium: 'text',
      occurredAt: 2,
      platformSourceId: 'message-forget-empty',
      retentionDeadline: 100,
      speakerId: 'president-1',
    });
    const worker = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store,
    });

    await expect(worker.runAutomaticOne(2)).resolves.toEqual({
      status: 'completed',
    });
    database.close();
  });
});
