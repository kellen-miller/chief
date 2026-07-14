import { describe, expect, it, vi } from 'vitest';

import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { contextPeriod } from '../../src/context/context-period.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { SqliteUsageLedger } from '../../src/usage/sqlite-usage-ledger.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const timeZone = 'America/New_York';

describe('ChannelContextService rollups', () => {
  it('completes a due provisional hourly rollup atomically', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    const summarize = vi.fn(
      (input: { readonly sources: readonly { readonly id: string }[] }) =>
        Promise.resolve({
          confidence: 0.9,
          inputTokens: 20,
          outputTokens: 8,
          sourceIds: input.sources.map(({ id }) => id),
          summary: 'Project Marigold launches Friday.',
          topicProposals: [],
          usageUsd: 0.02,
        }),
    );
    const embed = vi.fn(() =>
      Promise.resolve({
        embedding: new Float32Array(1_536).fill(0.25),
        usageUsd: 0.001,
      }),
    );
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed,
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: { summarize },
      timeZone,
    });
    const applied = service.apply({
      content: 'Project Marigold launches Friday.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: '52345678901234567',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    if (applied.eventId === null) throw new Error('expected source event');
    expect(
      database
        .prepare(
          `select not_before as notBefore,
                  freshness_deadline as freshnessDeadline
           from context_jobs where completeness = 'provisional'`,
        )
        .get(),
    ).toEqual({
      freshnessDeadline: occurredAt + 1_000 + 5 * 60 * 1_000,
      notBefore: occurredAt + 1_000 + 4 * 60 * 1_000,
    });
    current += 5 * 60 * 1_000;

    await expect(service.runNext(current)).resolves.toMatchObject({
      completeness: 'provisional',
      status: 'completed',
      tier: 'hourly',
    });

    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    expect(
      database
        .prepare(
          `select tier, completeness, state, summary,
                  generation_input_tokens as inputTokens,
                  generation_output_tokens as outputTokens,
                  generation_usage_usd as usageUsd
           from context_documents where state = 'active'`,
        )
        .get(),
    ).toEqual({
      completeness: 'provisional',
      inputTokens: 20,
      outputTokens: 8,
      state: 'active',
      summary: 'Project Marigold launches Friday.',
      tier: 'hourly',
      usageUsd: 0.021,
    });
    expect(
      database
        .prepare('select event_id from context_document_events')
        .pluck()
        .all(),
    ).toEqual([applied.eventId]);
    expect(
      database
        .prepare(
          'select rowid from context_document_fts where context_document_fts match ?',
        )
        .pluck()
        .all('Marigold'),
    ).toHaveLength(1);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      database
        .prepare('select status from context_jobs where completeness = ?')
        .pluck()
        .get('provisional'),
    ).toBe('completed');
    expect(
      database
        .prepare(`select count(*) from context_jobs where tier = 'daily'`)
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database.prepare('select actual_usd from usage_ledger').pluck().get(),
    ).toBe(0.021);
    expect(period.end).toBeGreaterThan(current);
    expect(summarize).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledOnce();
    database.close();
  });

  it('discards a provisional result that crosses the period boundary', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    let releaseSummary = (): void => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let announceSummary = (): void => undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      announceSummary = resolve;
    });
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: {
        summarize: async (input) => {
          announceSummary();
          await summaryGate;
          return {
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: 'Cross-boundary provisional summary.',
            topicProposals: [],
            usageUsd: 0.02,
          };
        },
      },
      timeZone,
    });
    service.apply({
      content: 'Project Marigold crosses the hour.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: 'request-cross-boundary',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    const hour = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    current = hour.end - 10_000;
    const running = service.runNext(current);
    await summaryStarted;
    current = hour.end + 1;
    releaseSummary();

    await expect(running).resolves.toEqual({ status: 'idle' });
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_fts')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select completeness, status, usage_reservation_id as reservationId
           from context_jobs order by completeness desc`,
        )
        .all(),
    ).toEqual([
      { completeness: 'provisional', reservationId: null, status: 'completed' },
      { completeness: 'final', reservationId: null, status: 'pending' },
    ]);
    expect(
      database.prepare('select actual_usd from usage_ledger').pluck().get(),
    ).toBe(0.021);
    expect(service.nextDeadline(current)).toBe(hour.end + 10 * 60 * 1_000);
    expect(
      database
        .prepare("select count(*) from context_jobs where tier = 'daily'")
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('finalizes an hour and schedules its daily parent by deadline', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: 'Project Marigold launches Friday.',
            topicProposals: [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    });
    service.apply({
      content: 'Project Marigold launches Friday.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: '52345678901234567',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;
    await service.runNext(current);
    const hour = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    current = hour.end;

    await expect(service.runNext(current)).resolves.toMatchObject({
      completeness: 'final',
      status: 'completed',
      tier: 'hourly',
    });

    expect(
      database
        .prepare(
          `select revision, completeness, state
           from context_documents order by revision`,
        )
        .all(),
    ).toEqual([
      { completeness: 'provisional', revision: 1, state: 'superseded' },
      { completeness: 'final', revision: 2, state: 'active' },
    ]);
    const day = contextPeriod({ instant: occurredAt, tier: 'daily', timeZone });
    expect(
      database
        .prepare(
          `select tier, period_start as periodStart, period_end as periodEnd,
                  not_before as notBefore,
                  freshness_deadline as freshnessDeadline, status
           from context_jobs where tier = 'daily'`,
        )
        .get(),
    ).toEqual({
      freshnessDeadline: day.end + 30 * 60 * 1_000,
      notBefore: day.end,
      periodEnd: day.end,
      periodStart: day.start,
      status: 'pending',
      tier: 'daily',
    });
    database.close();
  });

  it('rolls final hours into a day and schedules week and topic work', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: `${input.tier} Project Marigold summary.`,
            topicProposals:
              input.tier === 'daily'
                ? [
                    {
                      label: 'Project Marigold',
                      sourceIds: input.sources.map(({ id }) => id),
                    },
                  ]
                : [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    });
    service.apply({
      content: 'Project Marigold launches Friday.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: '52345678901234567',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;
    await service.runNext(current);
    const hour = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    current = hour.end;
    await service.runNext(current);
    const day = contextPeriod({ instant: occurredAt, tier: 'daily', timeZone });
    current = day.end;

    await expect(service.runNext(current)).resolves.toMatchObject({
      completeness: 'final',
      status: 'completed',
      tier: 'daily',
    });

    const dailyId = database
      .prepare(
        `select id from context_documents
         where tier = 'daily' and state = 'active'`,
      )
      .pluck()
      .get() as number;
    expect(
      database
        .prepare(
          `select p.tier from context_document_parents l
           join context_documents p on p.id = l.parent_document_id
           where l.document_id = ?`,
        )
        .pluck()
        .all(dailyId),
    ).toEqual(['hourly']);
    const week = contextPeriod({
      instant: occurredAt,
      tier: 'weekly',
      timeZone,
    });
    expect(
      database
        .prepare(
          `select period_start as periodStart, period_end as periodEnd,
                  freshness_deadline as freshnessDeadline
           from context_jobs where tier = 'weekly'`,
        )
        .get(),
    ).toEqual({
      freshnessDeadline: week.end + 2 * 60 * 60 * 1_000,
      periodEnd: week.end,
      periodStart: week.start,
    });
    const topicJob = database
      .prepare(
        `select tier, topic_key as topicKey, not_before as notBefore,
                freshness_deadline as freshnessDeadline
         from context_jobs where tier = 'long-term'`,
      )
      .get() as {
      readonly freshnessDeadline: number;
      readonly notBefore: number;
      readonly tier: string;
      readonly topicKey: string;
    };
    expect(topicJob).toMatchObject({
      freshnessDeadline: current + 24 * 60 * 60 * 1_000,
      notBefore: current,
      tier: 'long-term',
    });
    expect(topicJob.topicKey).not.toBe('');
    database.close();
  });

  it('defers indexing admission without consuming an attempt', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 0.05,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    const spent = budget.reserve('context-existing', 0.05, {
      priority: 'background',
      workCategory: 'indexing',
    });
    if (!spent.allowed) throw new Error('expected indexing reservation');
    budget.reconcile(spent.id, 0.05);
    const summarize = vi.fn();
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: vi.fn(),
      estimateUsd: 0.01,
      guildId,
      now: () => current,
      summarizer: { summarize },
      timeZone,
    });
    service.apply({
      content: 'Project Marigold launches Friday.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: '52345678901234567',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;

    await expect(service.runNext(current)).resolves.toEqual({
      notBefore: Date.UTC(2026, 7, 1),
      reason: 'indexing-budget',
      status: 'budget-deferred',
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `select attempt_count as attemptCount, status,
                  last_error_category as error
           from context_jobs where completeness = 'provisional'`,
        )
        .get(),
    ).toEqual({ attemptCount: 0, error: 'indexing-budget', status: 'pending' });
    database.close();
  });

  it('persists complete supplied lineage when the model cites a subset', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => current,
        warningUsd: 5,
      }),
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      guildId,
      now: () => current,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: [input.sources[0]?.id ?? 'missing'],
            summary: 'Subset citation summary.',
            topicProposals: [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    });
    const eventIds = [
      ['52345678901234567', 'First supplied source'],
      ['52345678901234568', 'Second supplied source'],
    ].map(([messageId, content], index) => {
      const result = service.apply({
        content: content ?? '',
        messageId: messageId ?? '',
        occurredAt: occurredAt + index,
        requestId: `request-lineage-${String(index)}`,
        role: 'human',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
        type: 'upsert',
      });
      if (result.eventId === null) throw new Error('expected source event');
      return result.eventId;
    });
    current += 5 * 60 * 1_000;

    await expect(service.runNext(current)).resolves.toMatchObject({
      status: 'completed',
    });

    expect(
      database
        .prepare(
          'select event_id from context_document_events order by event_id',
        )
        .pluck()
        .all(),
    ).toEqual(eventIds);
    database.close();
  });

  it('rejects an in-flight result when an omitted input is deleted', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    let releaseSummary = (): void => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let announceSummary = (): void => undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      announceSummary = resolve;
    });
    const service = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => current,
        warningUsd: 5,
      }),
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      guildId,
      now: () => current,
      summarizer: {
        summarize: async (input) => {
          announceSummary();
          await summaryGate;
          return {
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: [input.sources[0]?.id ?? 'missing'],
            summary: 'Raced subset summary.',
            topicProposals: [],
            usageUsd: 0.02,
          };
        },
      },
      timeZone,
    });
    for (const [index, messageId] of [
      '52345678901234567',
      '52345678901234568',
    ].entries()) {
      service.apply({
        content: `Source ${String(index)}`,
        messageId,
        occurredAt: occurredAt + index,
        requestId: `request-race-${String(index)}`,
        role: 'human',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
        type: 'upsert',
      });
    }
    current += 5 * 60 * 1_000;
    const running = service.runNext(current);
    await summaryStarted;
    service.apply({
      deletedAt: current,
      messageId: '52345678901234568',
      reason: 'discord-deleted',
      type: 'delete',
    });
    releaseSummary();

    await expect(running).resolves.toEqual({ status: 'failed' });
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_fts')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare("select count(*) from context_jobs where tier != 'hourly'")
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('rebuilds from remaining lineage after a concurrent local forget', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    let releaseSummary = (): void => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let announceSummary = (): void => undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      announceSummary = resolve;
    });
    let summaryAttempt = 0;
    const service = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => current,
        warningUsd: 5,
      }),
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      guildId,
      memory: new SqliteMemoryStore(database),
      now: () => current,
      summarizer: {
        summarize: async (input) => {
          summaryAttempt += 1;
          if (summaryAttempt === 1) {
            announceSummary();
            await summaryGate;
          }
          return {
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: input.sources.map(({ text }) => text).join(' '),
            topicProposals: [],
            usageUsd: 0.02,
          };
        },
      },
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    const forgotten = service.apply({
      content: 'MarigoldSecret belongs only to the first source.',
      messageId: '52345678901234577',
      occurredAt,
      requestId: 'request-local-race-1',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    const retained = service.apply({
      content: 'JuniperSecret belongs only to the second source.',
      messageId: '52345678901234578',
      occurredAt: occurredAt + 1,
      requestId: 'request-local-race-2',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;
    const running = service.runNext(current);
    await summaryStarted;

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget MarigoldSecret',
        now: current,
        requestMessageId: '62345678901234577',
        requesterId: '42345678901234567',
      }),
    ).resolves.toMatchObject({ sourceCount: 1, status: 'forgotten' });
    releaseSummary();
    await expect(running).resolves.toEqual({ status: 'failed' });

    await expect(service.runNext(current)).resolves.toMatchObject({
      status: 'completed',
      tier: 'hourly',
    });
    expect(
      database
        .prepare(
          `select summary from context_documents
           where state = 'active' and is_internal = 0`,
        )
        .pluck()
        .get(),
    ).toContain('JuniperSecret');
    expect(
      database
        .prepare(
          `select summary from context_documents
           where state = 'active' and is_internal = 0`,
        )
        .pluck()
        .get(),
    ).not.toContain('MarigoldSecret');
    expect(
      database
        .prepare(
          `select event_id from context_document_events
           where document_id in (
             select id from context_documents where state = 'active'
           )`,
        )
        .pluck()
        .all(),
    ).toEqual([retained.eventId]);
    expect(
      database
        .prepare('select content_state from conversation_events where id = ?')
        .pluck()
        .get(forgotten.eventId),
    ).toBe('scrubbed');
    database.close();
  });

  it('fails invalid structured output after five retryable attempts', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: vi.fn(),
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: {
        summarize: () =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: ['event:not-supplied'],
            summary: 'Invalid source reference.',
            topicProposals: [],
            usageUsd: 0.001,
          }),
      },
      timeZone,
    });
    service.apply({
      content: 'Project Marigold launches Friday.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: '52345678901234567',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await service.runNext(current);
      if (attempt < 5) {
        expect(result).toMatchObject({ status: 'retry' });
        if (result.status !== 'retry') throw new Error('expected retry');
        current = result.notBefore;
      } else expect(result).toEqual({ status: 'failed' });
    }

    expect(
      database
        .prepare(
          `select attempt_count as attemptCount, status,
                  last_error_category as error
           from context_jobs where completeness = 'provisional'`,
        )
        .get(),
    ).toEqual({ attemptCount: 5, error: 'provider', status: 'failed' });
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    expect(service.status(current)).toMatchObject({
      degraded: true,
      failedJobs: 1,
      reason: 'provider',
    });
    database.close();
  });

  it('recovers an expired lease and reconciles its stale reservation', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const ledger = new SqliteUsageLedger(database);
    const firstBudget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger,
      now: () => current,
      warningUsd: 5,
    });
    const options = {
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      maxSourceTokens: 8,
      now: () => current,
      summarizer: {
        summarize: (input: {
          readonly sources: readonly { readonly id: string }[];
        }) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: 'S',
            topicProposals: [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    };
    const firstService = new ChannelContextService({
      ...options,
      budget: firstBudget,
    });
    firstService.apply({
      content:
        'Recover this segmented source across several bounded provider calls.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: '52345678901234567',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;
    const stale = firstBudget.reserve('context-rollup', 0.35, {
      priority: 'background',
      workCategory: 'indexing',
    });
    if (!stale.allowed) throw new Error('expected stale reservation');
    database
      .prepare(
        `update context_jobs
         set status = 'leased', attempt_count = 1, lease_expires_at = ?,
             usage_reservation_id = ?
         where completeness = 'provisional'`,
      )
      .run(current - 1, stale.id);

    const restarted = new ChannelContextService({
      ...options,
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger,
        now: () => current,
        warningUsd: 5,
      }),
    });
    await expect(restarted.runNext(current)).resolves.toMatchObject({
      status: 'completed',
      tier: 'hourly',
    });

    expect(
      database
        .prepare('select count(*) from usage_ledger where actual_usd is null')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare('select actual_usd from usage_ledger where id = ?')
        .pluck()
        .get(stale.id),
    ).toBe(0.35);
    expect(
      database
        .prepare(
          `select attempt_count as attemptCount, status
           from context_jobs where completeness = 'provisional'`,
        )
        .get(),
    ).toEqual({ attemptCount: 2, status: 'completed' });
    expect(
      database
        .prepare(
          `select count(*) from context_documents
           where is_internal = 0 and state = 'active'`,
        )
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      database
        .prepare('select count(*) from context_documents where is_internal = 1')
        .pluck()
        .get(),
    ).toBeGreaterThan(1);
    database.close();
  });

  it('rolls back document success when usage reconciliation fails', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => current,
        warningUsd: 5,
      }),
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      guildId,
      now: () => current,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: 'Atomic reconciliation summary.',
            topicProposals: [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    });
    service.apply({
      content: 'Atomic reconciliation source.',
      messageId: '52345678901234567',
      occurredAt,
      requestId: 'request-atomic-usage',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    database.exec(`
      create trigger fail_context_reconciliation
      before update of actual_usd on usage_ledger
      when new.actual_usd is not null
      begin
        select raise(abort, 'injected reconciliation crash');
      end;
    `);
    current += 5 * 60 * 1_000;

    await expect(service.runNext(current)).rejects.toThrow(
      'injected reconciliation crash',
    );

    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_fts')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    const interruptedJob = database
      .prepare(
        `select status, usage_reservation_id as usageReservationId
         from context_jobs where completeness = 'provisional'`,
      )
      .get() as {
      readonly status: string;
      readonly usageReservationId: string;
    };
    expect(interruptedJob.status).toBe('leased');
    expect(interruptedJob.usageReservationId).not.toBe('');
    expect(
      database.prepare('select actual_usd from usage_ledger').pluck().get(),
    ).toBeNull();
    database.close();
  });

  it('segments an oversized hour into internal bounded documents', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => current,
      warningUsd: 5,
    });
    const inputs: {
      readonly sources: readonly {
        readonly id: string;
        readonly text: string;
      }[];
    }[] = [];
    const service = new ChannelContextService({
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      maxSourceTokens: 8,
      now: () => current,
      summarizer: {
        summarize: (input) => {
          inputs.push(input);
          return Promise.resolve({
            confidence: 0.9,
            inputTokens: input.sources.reduce(
              (total, sourceInput) =>
                total + Math.ceil(sourceInput.text.length / 4),
              0,
            ),
            outputTokens: 2,
            sourceIds: input.sources.map(({ id }) => id),
            summary: `Summary ${String(inputs.length)}.`,
            topicProposals: [],
            usageUsd: 0.005,
          });
        },
      },
      timeZone,
    });
    for (const [index, content] of [
      'Marigold launch Friday.',
      'Cabinet reviews Marigold.',
      'Launch owner is Taylor.',
    ].entries()) {
      service.apply({
        content,
        messageId: String(52_345_678_901_234_567n + BigInt(index)),
        occurredAt: occurredAt + index,
        requestId: `request-${String(index)}`,
        role: 'human',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
        type: 'upsert',
      });
    }
    current += 5 * 60 * 1_000;

    await expect(service.runNext(current)).resolves.toMatchObject({
      status: 'completed',
      tier: 'hourly',
    });

    expect(inputs.length).toBeGreaterThan(1);
    expect(
      inputs.every(
        ({ sources }) =>
          sources.reduce(
            (total, sourceInput) =>
              total + Math.ceil(sourceInput.text.length / 4),
            0,
          ) <= 8,
      ),
    ).toBe(true);
    const documents = database
      .prepare(
        `select id, is_internal as isInternal
         from context_documents order by id`,
      )
      .all() as { readonly id: number; readonly isInternal: 0 | 1 }[];
    const internalIds = documents
      .filter(({ isInternal }) => isInternal === 1)
      .map(({ id }) => id);
    const visibleId = documents.find(({ isInternal }) => isInternal === 0)?.id;
    expect(internalIds.length).toBeGreaterThan(1);
    expect(visibleId).toBeTypeOf('number');
    expect(
      database
        .prepare(
          `select parent_document_id from context_document_parents
           where document_id = ? order by parent_document_id`,
        )
        .pluck()
        .all(visibleId),
    ).toEqual(internalIds);
    expect(
      database
        .prepare('select count(*) from context_document_fts')
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });

  it('scrubs expired raw and hourly content without suppressing rollups', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => current,
        warningUsd: 5,
      }),
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: `${input.tier} retained summary`,
            topicProposals: [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    });
    service.apply({
      content: 'Raw Marigold discussion',
      messageId: '52345678901234567',
      occurredAt,
      requestId: 'request-retention',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;
    await service.runNext(current);
    const hour = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    current = hour.end;
    await service.runNext(current);
    const day = contextPeriod({ instant: occurredAt, tier: 'daily', timeZone });
    current = day.end;
    await service.runNext(current);
    const week = contextPeriod({
      instant: occurredAt,
      tier: 'weekly',
      timeZone,
    });
    current = week.end;
    await service.runNext(current);
    const lineageCount = database
      .prepare(
        `select
           (select count(*) from context_document_events) +
           (select count(*) from context_document_parents)`,
      )
      .pluck()
      .get();
    current = hour.end + 30 * 24 * 60 * 60 * 1_000 + 1;

    expect(service.maintain(current)).toEqual({ deletedEvents: 1 });

    expect(
      database
        .prepare(
          `select content, content_state as contentState
           from conversation_events`,
        )
        .get(),
    ).toEqual({ content: '', contentState: 'scrubbed' });
    expect(
      database
        .prepare('select count(*) from conversation_event_fts')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select tier, summary, state, content_state as contentState
           from context_documents where state = 'active' order by id`,
        )
        .all(),
    ).toEqual([
      {
        contentState: 'scrubbed',
        state: 'active',
        summary: '',
        tier: 'hourly',
      },
      {
        contentState: 'available',
        state: 'active',
        summary: 'daily retained summary',
        tier: 'daily',
      },
      {
        contentState: 'available',
        state: 'active',
        summary: 'weekly retained summary',
        tier: 'weekly',
      },
    ]);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database
        .prepare(
          `select
             (select count(*) from context_document_events) +
             (select count(*) from context_document_parents)`,
        )
        .pluck()
        .get(),
    ).toBe(lineageCount);
    database.close();
  });

  it('atomically suppresses descendants of a revised parent rollup', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let current = occurredAt + 1_000;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => current,
        warningUsd: 5,
      }),
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.05,
      guildId,
      now: () => current,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 20,
            outputTokens: 8,
            sourceIds: input.sources.map(({ id }) => id),
            summary: `${input.tier} revision summary`,
            topicProposals: [],
            usageUsd: 0.02,
          }),
      },
      timeZone,
    });
    service.apply({
      content: 'Initial Marigold discussion',
      messageId: '52345678901234567',
      occurredAt,
      requestId: 'request-initial',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });
    current += 5 * 60 * 1_000;
    await service.runNext(current);
    const hour = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    current = hour.end;
    await service.runNext(current);
    const day = contextPeriod({ instant: occurredAt, tier: 'daily', timeZone });
    current = day.end;
    await service.runNext(current);
    const week = contextPeriod({
      instant: occurredAt,
      tier: 'weekly',
      timeZone,
    });
    current = week.end;
    await service.runNext(current);
    service.apply({
      content: 'Late reconciled Marigold evidence',
      messageId: '52345678901234568',
      occurredAt: occurredAt + 1,
      requestId: 'request-late',
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
      type: 'upsert',
    });

    await expect(service.runNext(current)).resolves.toMatchObject({
      completeness: 'final',
      status: 'completed',
      tier: 'hourly',
    });

    expect(
      database
        .prepare(
          `select tier, state, content_state as contentState
           from context_documents
           where tier in ('daily', 'weekly') order by id`,
        )
        .all(),
    ).toEqual([
      { contentState: 'scrubbed', state: 'suppressed', tier: 'daily' },
      { contentState: 'scrubbed', state: 'suppressed', tier: 'weekly' },
    ]);
    expect(
      database
        .prepare(
          `select count(*) from context_document_fts f
           join context_documents d on d.id = f.rowid
           where d.tier in ('daily', 'weekly')`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    current += 5 * 60 * 1_000;
    for (let index = 0; index < 10; index += 1) {
      const result = await service.runNext(current);
      if (result.status === 'idle') break;
    }
    expect(
      database
        .prepare(
          `select completeness from context_documents
           where tier = 'hourly' and state = 'active' and is_internal = 0`,
        )
        .pluck()
        .get(),
    ).toBe('final');
    expect(
      database
        .prepare(
          `select status from context_jobs
           where tier = 'daily' order by id desc limit 1`,
        )
        .pluck()
        .get(),
    ).toBe('completed');
    database.close();
  });
});
