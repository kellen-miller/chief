import { describe, expect, it, vi } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const vector = new Float32Array(1_536).fill(0.4);

describe('MemoryService', () => {
  it('commits an explicit proposal at the 0.75 boundary before receipt', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const extract = vi.fn(() =>
      Promise.resolve({
        proposals: [
          {
            action: 'create' as const,
            canonicalText: 'Do not choose a military academy.',
            confidence: 0.75,
            kind: 'preference',
            sensitivity: 'none' as const,
            targetMemoryId: null,
          },
        ],
        usageUsd: 0.002,
      }),
    );
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(() =>
        Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      ),
      estimateUsd: 0.1,
      extract,
      store,
    });
    const source = {
      content: 'This list Chief remember no military academy',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-1',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };
    const sourceEventId = service.observeExplicit(source);

    const receipt = await service.applyExplicit({
      intent: 'remember',
      now: 110,
      source,
      sourceEventId,
    });

    expect(receipt).toMatchObject({ status: 'created' });
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Explicit communal memory request: no military academy',
        explicitIntent: 'remember',
      }),
    );
    expect(
      store.retrieve({
        embedding: vector,
        limit: 3,
        now: 120,
        text: 'military academy',
      }),
    ).toEqual([
      expect.objectContaining({
        canonicalText: 'Do not choose a military academy.',
      }),
    ]);
    expect(
      database.prepare('select count(*) from memory_jobs').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it.each([
    {
      content: 'Oregon and Syracuse — Chief, remember those teams',
      expected:
        'Explicit communal memory request: those teams\nSame-message context before request: Oregon and Syracuse —',
      name: 'same-message referent',
    },
    {
      content: "We're switching to decaf. Chief remember that.",
      expected:
        "Explicit communal memory request: that.\nSame-message context before request: We're switching to decaf.",
      name: 'bare same-message back-reference',
    },
    {
      content: 'Oregon won the game. Chief remember that game.',
      expected:
        'Explicit communal memory request: that game.\nSame-message context before request: Oregon won the game.',
      name: 'qualified same-message back-reference',
    },
    {
      content: 'Oregon and Syracuse — Chief remember both',
      expected:
        'Explicit communal memory request: both\nSame-message context before request: Oregon and Syracuse —',
      name: 'both-items back-reference',
    },
    {
      content: 'Portland and Seattle — Chief remember the two cities',
      expected:
        'Explicit communal memory request: the two cities\nSame-message context before request: Portland and Seattle —',
      name: 'counted back-reference',
    },
    {
      content:
        'Chief remember:\n- no military academies\n- prefer state schools',
      expected:
        'Explicit communal memory request: - no military academies\n- prefer state schools',
      name: 'multiline list',
    },
    {
      content: 'Chief, remember: no military academy',
      expected: 'Explicit communal memory request: no military academy',
      name: 'punctuated request',
    },
  ])('frames a $name without losing content', async ({ content, expected }) => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const extract = vi.fn(() =>
      Promise.resolve({ proposals: [], usageUsd: 0.002 }),
    );
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract,
      store: new SqliteMemoryStore(database),
    });
    const source = {
      content,
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: `explicit-framing-${String(content.length)}`,
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await service.applyExplicit({
      intent: 'remember',
      now: 110,
      source,
      sourceEventId: service.observeExplicit(source),
    });

    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expected,
        explicitIntent: 'remember',
      }),
    );
    database.close();
  });

  it.each([
    'Chief remember that',
    'Chief remember that.',
    'Chief remember: --',
    'Chief remember both',
    'Chief remember that game',
    'Chief remember those teams',
    'Chief remember the two cities',
  ])('short-circuits the empty remember command %j', async (content) => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const extract = vi.fn(() =>
      Promise.resolve({ proposals: [], usageUsd: 0.002 }),
    );
    const embed = vi.fn();
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed,
      estimateUsd: 0.1,
      extract,
      store: new SqliteMemoryStore(database),
    });
    const source = {
      content,
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-empty-framing',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await expect(
      service.applyExplicit({
        intent: 'remember',
        now: 110,
        source,
        sourceEventId: service.observeExplicit(source),
      }),
    ).resolves.toEqual({ status: 'ambiguous' });
    expect(extract).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('truthfully rejects an explicit proposal below 0.75', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const embed = vi.fn(() =>
      Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
    );
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed,
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'create',
              canonicalText: 'Maybe this should be remembered.',
              confidence: 0.74,
              kind: 'fact',
              sensitivity: 'none',
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });
    const source = {
      content: 'Chief remember this maybe',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-low',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await expect(
      service.applyExplicit({
        intent: 'remember',
        now: 110,
        source,
        sourceEventId: service.observeExplicit(source),
      }),
    ).resolves.toEqual({ status: 'ambiguous' });
    expect(embed).not.toHaveBeenCalled();
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('supersedes and conflicts through explicit correction receipts', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const originalId = store.applyMemory({
      canonicalText: 'Dinner is at six.',
      confidence: 0.9,
      embedding: vector,
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    const extract = vi
      .fn()
      .mockResolvedValueOnce({
        proposals: [
          {
            action: 'supersede',
            canonicalText: 'Dinner is at seven.',
            confidence: 0.99,
            kind: 'plan',
            sensitivity: 'none',
            targetMemoryId: originalId,
          },
        ],
        usageUsd: 0.002,
      })
      .mockResolvedValueOnce({
        proposals: [
          {
            action: 'conflict',
            canonicalText: 'Dinner might instead be at eight.',
            confidence: 0.95,
            kind: 'plan',
            sensitivity: 'none',
            targetMemoryId: originalId + 1,
          },
        ],
        usageUsd: 0.002,
      });
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      estimateUsd: 0.1,
      extract,
      store,
    });
    const correction = {
      content: 'Chief correct dinner to seven',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-correction',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await expect(
      service.applyExplicit({
        intent: 'correct',
        now: 110,
        source: correction,
        sourceEventId: service.observeExplicit(correction),
      }),
    ).resolves.toMatchObject({ status: 'superseded' });
    const conflict = {
      ...correction,
      content: 'Chief correct dinner to eight, though that may conflict',
      platformSourceId: 'explicit-conflict',
    };
    await expect(
      service.applyExplicit({
        intent: 'correct',
        now: 120,
        source: conflict,
        sourceEventId: service.observeExplicit(conflict),
      }),
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(
      database.prepare('select count(*) from memory_conflicts').pluck().get(),
    ).toBe(1);
    expect(
      database
        .prepare("select canonical_text from memories where state = 'active'")
        .pluck()
        .all(),
    ).toEqual(['Dinner is at seven.', 'Dinner might instead be at eight.']);
    database.close();
  });

  it('rolls back every prepared proposal when one mutation fails', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'create',
              canonicalText: 'First prepared memory.',
              confidence: 0.99,
              kind: 'fact',
              sensitivity: 'none',
              targetMemoryId: null,
            },
            {
              action: 'supersede',
              canonicalText: 'Replacement for a missing memory.',
              confidence: 0.99,
              kind: 'fact',
              sensitivity: 'none',
              targetMemoryId: 999,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });
    const source = {
      content: 'Chief correct these facts',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-rollback',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await expect(
      service.applyExplicit({
        intent: 'correct',
        now: 110,
        source,
        sourceEventId: service.observeExplicit(source),
      }),
    ).resolves.toEqual({ status: 'failed' });
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    expect(
      database.prepare('select count(*) from memory_fts').pluck().get(),
    ).toBe(0);
    expect(
      database.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('rejects sensitive explicit memory and reports budget pause truthfully', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const budget = new UsageBudget({ ceilingUsd: 1, warningUsd: 0.5 });
    const service = new MemoryService({
      budget,
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'create',
              canonicalText: 'A private credential.',
              confidence: 0.99,
              kind: 'fact',
              sensitivity: 'sensitive',
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });
    const sensitiveSource = {
      content: 'Chief remember a private credential',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-sensitive',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await expect(
      service.applyExplicit({
        intent: 'remember',
        now: 110,
        source: sensitiveSource,
        sourceEventId: service.observeExplicit(sensitiveSource),
      }),
    ).resolves.toEqual({ status: 'rejected-sensitive' });
    budget.recordActual(1);
    const pausedSource = {
      ...sensitiveSource,
      platformSourceId: 'explicit-paused',
    };
    await expect(
      service.applyExplicit({
        intent: 'remember',
        now: 120,
        source: pausedSource,
        sourceEventId: service.observeExplicit(pausedSource),
      }),
    ).resolves.toEqual({ status: 'budget-paused' });
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('forgets a lexical explicit target and reports ambiguity when absent', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const memoryId = store.applyMemory({
      canonicalText: 'Dinner is at seven',
      confidence: 0.99,
      embedding: vector,
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store,
    });
    const forgetSource = {
      canModerateContext: true,
      content: 'Chief forget that dinner is at seven',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'explicit-forget',
      retentionDeadline: 1_000,
      speakerId: 'president-1',
    };

    await expect(
      service.applyExplicit({
        intent: 'forget',
        now: 110,
        source: forgetSource,
        sourceEventId: service.observeExplicit(forgetSource),
      }),
    ).resolves.toEqual({ memoryIds: [memoryId], status: 'forgotten' });
    const missingSource = {
      ...forgetSource,
      content: 'Chief forget that nonexistent banquet',
      platformSourceId: 'explicit-forget-missing',
    };
    await expect(
      service.applyExplicit({
        intent: 'forget',
        now: 120,
        source: missingSource,
        sourceEventId: service.observeExplicit(missingSource),
      }),
    ).resolves.toEqual({ status: 'ambiguous' });
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('requires source authorship or current moderation to forget', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const ownerSource = {
      content: 'Dinner is at seven',
      medium: 'text' as const,
      occurredAt: 1,
      platformSourceId: 'owner-source',
      retentionDeadline: 1_000,
      speakerId: 'president-owner',
    };
    const ownerSourceId = store.observeExplicit(ownerSource);
    const memoryId = store.applyMemory({
      canonicalText: 'Dinner is at seven',
      confidence: 0.99,
      embedding: vector,
      kind: 'plan',
      provenance: {},
      sourceEventId: ownerSourceId,
      timestamp: 1,
    });
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store,
    });
    const request = {
      canModerateContext: false,
      content: 'Chief forget that dinner is at seven',
      medium: 'text' as const,
      occurredAt: 100,
      platformSourceId: 'other-forget',
      retentionDeadline: 1_000,
      speakerId: 'president-other',
    };

    await expect(
      service.applyExplicit({
        intent: 'forget',
        now: 110,
        source: request,
        sourceEventId: service.observeExplicit(request),
      }),
    ).resolves.toEqual({ status: 'ambiguous' });
    expect(database.prepare('select id from memories').pluck().get()).toBe(
      memoryId,
    );

    const moderated = {
      ...request,
      canModerateContext: true,
      platformSourceId: 'admin-forget',
    };
    await expect(
      service.applyExplicit({
        intent: 'forget',
        now: 120,
        source: moderated,
        sourceEventId: service.observeExplicit(moderated),
      }),
    ).resolves.toEqual({ memoryIds: [memoryId], status: 'forgotten' });
    database.close();
  });

  it('preserves self-forget authority after raw source retention', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const ownerSource = {
      content: 'Dinner is at seven',
      medium: 'text' as const,
      occurredAt: 1,
      platformSourceId: 'retained-owner-source',
      retentionDeadline: 10,
      speakerId: 'president-owner',
    };
    const sourceEventId = store.observeExplicit(ownerSource);
    const memoryId = store.applyMemory({
      canonicalText: 'Dinner is at seven',
      confidence: 0.99,
      embedding: vector,
      kind: 'plan',
      provenance: { platformSourceId: ownerSource.platformSourceId },
      sourceEventId,
      timestamp: 2,
    });
    store.maintain(11);
    expect(
      database
        .prepare('select content from source_events where id = ?')
        .pluck()
        .get(sourceEventId),
    ).toBe('');
    expect(
      database
        .prepare('select source_event_id from memories where id = ?')
        .pluck()
        .get(memoryId),
    ).toBe(sourceEventId);
    const service = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store,
    });
    const forgetSource = {
      canModerateContext: false,
      content: 'Chief forget that dinner is at seven',
      medium: 'text' as const,
      occurredAt: 20,
      platformSourceId: 'retained-owner-forget',
      retentionDeadline: 100,
      speakerId: 'president-owner',
    };

    await expect(
      service.applyExplicit({
        intent: 'forget',
        now: 21,
        source: forgetSource,
        sourceEventId: service.observeExplicit(forgetSource),
      }),
    ).resolves.toEqual({ memoryIds: [memoryId], status: 'forgotten' });
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });
});
