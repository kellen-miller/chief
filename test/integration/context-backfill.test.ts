import { describe, expect, it, vi } from 'vitest';

import type { NormalizedTextSource } from '../../src/app/conversation-orchestrator.js';
import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ContextBackfillService } from '../../src/context/context-backfill.js';
import type { ContextSummarizer } from '../../src/context/openai-context.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import type {
  DiscordHistoryFetchInput,
  DiscordHistoryPage,
  DiscordHistorySource,
} from '../../src/discord/discord-reconciliation-service.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteUsageLedger } from '../../src/usage/sqlite-usage-ledger.js';
import { BackgroundScheduler } from '../../src/usage/background-scheduler.js';
import { PaidWorkQueue } from '../../src/usage/paid-work-queue.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const guildId = '12345678901234567';
const channelId = '22345678901234567';

describe('ContextBackfillService', () => {
  it('stores only a content-free reverse manifest during dry-run', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const source = fakeHistory([
      page(
        [
          normalized('42345678901234567', 'Newest private words', 3_000),
          normalized('32345678901234567', 'Middle private words', 2_000),
        ],
        '32345678901234567',
      ),
      page(
        [normalized('22345678901234568', 'Oldest private words', 1_000)],
        null,
      ),
    ]);
    const service = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: source,
      pricing: {
        embeddingInputPerMillionUsd: 0.02,
        summaryInputPerMillionUsd: 0.2,
        summaryOutputPerMillionUsd: 1.25,
      },
    });

    const result = await service.dryRun({ replace: false });

    expect(result).toMatchObject({
      alreadyIngestedCount: 0,
      eligibleCount: 3,
      newestOccurredAt: 3_000,
      oldestOccurredAt: 1_000,
      pageCount: 2,
      status: 'ready',
    });
    expect(
      database
        .prepare(
          `select page_index as pageIndex,
                  request_before_source_id as requestBeforeSourceId,
                  oldest_source_id as oldestSourceId,
                  newest_source_id as newestSourceId
           from context_backfill_pages order by page_index`,
        )
        .all(),
    ).toEqual([
      {
        newestSourceId: '42345678901234567',
        oldestSourceId: '32345678901234567',
        pageIndex: 0,
        requestBeforeSourceId: null,
      },
      {
        newestSourceId: '22345678901234568',
        oldestSourceId: '22345678901234568',
        pageIndex: 1,
        requestBeforeSourceId: '32345678901234567',
      },
    ]);
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(0);
    const persisted = JSON.stringify(
      database
        .prepare(
          `select b.*, p.* from context_backfills b
           join context_backfill_pages p on p.run_id = b.id`,
        )
        .all(),
    );
    expect(persisted).not.toContain('private words');
    expect(source.fetchPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cursor: null, mode: 'backfill' }),
    );
    expect(source.fetchPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: '32345678901234567',
        mode: 'backfill',
      }),
    );
    database.close();
  });

  it('activates only a completed manifest with exact owner confirmation', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([page([], null)]),
      pricing: zeroPricing,
    });

    expect(() =>
      service.activate({ confirmGuildId: guildId, maximumUsageUsd: 0.5 }),
    ).toThrow(/completed dry-run/u);
    const ready = await service.dryRun({ replace: false });
    expect(() =>
      service.activate({
        confirmGuildId: '32345678901234567',
        maximumUsageUsd: 0.5,
      }),
    ).toThrow(/guild confirmation/u);
    expect(() =>
      service.activate({ confirmGuildId: guildId, maximumUsageUsd: 0 }),
    ).toThrow(/positive/u);

    expect(
      service.activate({ confirmGuildId: guildId, maximumUsageUsd: 0.5 }),
    ).toMatchObject({
      maximumUsageUsd: 0.5,
      runId: ready.runId,
      status: 'active',
    });
    database.close();
  });

  it('resumes an interrupted dry-run from its durable page cursor', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const interrupted = fakeHistory([
      page(
        [normalized('42345678901234567', 'First page', 2_000)],
        '42345678901234567',
      ),
      {
        complete: false,
        coverage: null,
        items: [],
        nextCursor: '42345678901234567',
        rateLimited: true,
      },
    ]);
    const service = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: interrupted,
      pricing: zeroPricing,
    });

    await expect(service.dryRun({ replace: false })).rejects.toThrow(
      /rate-limited/u,
    );
    const incomplete = service.status();
    expect(incomplete).toMatchObject({ pageCount: 1, status: 'dry-run' });
    await expect(service.dryRun({ replace: false })).rejects.toThrow(
      /unfinished/u,
    );

    const firstPage = page(
      [normalized('42345678901234567', 'First page', 2_000)],
      '42345678901234567',
    );
    const secondPage = page(
      [normalized('32345678901234567', 'Second page', 1_000)],
      null,
    );
    const resumedHistory = {
      fetchPage: vi.fn((input: DiscordHistoryFetchInput) =>
        Promise.resolve(input.cursor === null ? firstPage : secondPage),
      ),
    };
    service.attachHistorySource(resumedHistory);
    const resumed = await service.resume(incomplete?.runId ?? 0);

    expect(resumed).toMatchObject({
      eligibleCount: 2,
      pageCount: 2,
      status: 'ready',
    });
    expect(resumedHistory.fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '42345678901234567' }),
    );
    database.close();
  });

  it('atomically derives old history without persisting raw text', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const oldHuman = normalized(
      '32345678901234567',
      'A private historical decision with enough words to summarize.',
      1_000,
    );
    const oldChief = {
      ...normalized(
        '22345678901234568',
        'Chief replied with historical context.',
        2_000,
      ),
      authorKind: 'chief' as const,
      requesterId: 'chief-user',
      speakerName: 'Chief',
    };
    const manifest = fakeHistory([page([oldChief, oldHuman], null)]);
    const summarize = vi.fn(
      ({ sources }: { sources: readonly { id: string; text: string }[] }) =>
        Promise.resolve({
          confidence: 0.9,
          inputTokens: 20,
          outputTokens: 10,
          sourceIds: sources.map(({ id }) => id),
          summary: 'The group discussed a historical decision.',
          topicProposals: [],
          usageUsd: 0.02,
        }),
    );
    const embed = vi.fn(() =>
      Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0.01 }),
    );
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const reconcileTransactionStates: boolean[] = [];
    const reconcileWith = budget.reconcileWith.bind(budget);
    vi.spyOn(budget, 'reconcileWith').mockImplementation((...input) => {
      reconcileTransactionStates.push(database.inTransaction);
      return reconcileWith(...input);
    });
    const service = new ContextBackfillService({
      budget,
      channelId,
      database,
      embed,
      estimateUsd: 0.05,
      guildId,
      history: manifest,
      maxSourceTokens: 20,
      now: () => now,
      pricing: zeroPricing,
      summarizer: { summarize },
      timeZone: 'America/New_York',
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    service.attachHistorySource(
      repeatingHistory(page([oldChief, oldHuman], null)),
    );

    for (
      let index = 0;
      index < 5 && service.status()?.status === 'active';
      index += 1
    ) {
      const result = await service.runNext(now);
      expect(['completed', 'idle']).toContain(result.status);
      if (result.status === 'idle') break;
    }

    expect(
      database
        .prepare(
          `select content, content_state as contentState,
                  content_state_reason as contentStateReason
           from conversation_events order by occurred_at`,
        )
        .all(),
    ).toEqual([
      {
        content: '',
        contentState: 'scrubbed',
        contentStateReason: 'retention-expired',
      },
      {
        content: '',
        contentState: 'scrubbed',
        contentStateReason: 'retention-expired',
      },
    ]);
    expect(
      database.prepare('select count(*) from source_events').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select summary from context_documents
           where state = 'active' and is_internal = 0`,
        )
        .pluck()
        .all(),
    ).toEqual(['The group discussed a historical decision.']);
    expect(
      database
        .prepare('select count(*) from context_document_events')
        .pluck()
        .get(),
    ).toBe(2);
    expect(reconcileTransactionStates).not.toContain(true);
    expect(reconcileTransactionStates.length).toBeGreaterThan(0);
    expect(
      JSON.stringify(
        database.prepare('select * from context_backfill_segments').all(),
      ),
    ).not.toContain('private historical');
    expect(
      database
        .serialize()
        .includes(Buffer.from('A private historical decision')),
    ).toBe(false);
    expect(
      summarize.mock.calls.every(([input]) =>
        input.sources.some(({ id }: { id: string }) => id.startsWith('source:'))
          ? input.sources.reduce(
              (total: number, source: { text: string }) =>
                total + Math.ceil(source.text.length / 4),
              0,
            ) <= 20
          : true,
      ),
    ).toBe(true);
    expect(service.status()).toMatchObject({
      actualUsageUsd: 0.08,
      status: 'active',
    });
    database.close();
  });

  it('pauses safely when the approved run budget cannot admit a segment', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const old = normalized('32345678901234567', 'Old private words', 1_000);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const service = new ContextBackfillService({
      budget,
      channelId,
      database,
      embed: vi.fn(),
      estimateUsd: 0.05,
      guildId,
      history: fakeHistory([page([old], null)]),
      now: () => now,
      pricing: zeroPricing,
      summarizer: { summarize: vi.fn() },
      timeZone: 'America/New_York',
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 0.01 });
    service.attachHistorySource(fakeHistory([page([old], null)]));

    await expect(service.runNext(now)).resolves.toEqual({
      reason: 'run-budget',
      status: 'budget-paused',
    });
    expect(service.status()).toMatchObject({
      actualUsageUsd: 0,
      pauseReason: 'run-budget',
      status: 'paused',
    });
    const paused = service.status();
    if (paused === null) throw new Error('expected paused backfill');
    await expect(service.resume(paused.runId)).resolves.toMatchObject({
      pauseReason: null,
      status: 'active',
    });
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('does not commit provider usage above its hard reservation', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const old = normalized('32345678901234567', 'Old private words', 1_000);
    const budget = new UsageBudget({
      ceilingUsd: 0.05,
      indexingCeilingUsd: 0.05,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 0.04,
    });
    const service = new ContextBackfillService({
      budget,
      channelId,
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      estimateUsd: 0.05,
      guildId,
      history: fakeHistory([page([old], null)]),
      now: () => now,
      pricing: zeroPricing,
      summarizer: {
        summarize: ({ sources }) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: sources.map(({ id }) => id),
            summary: 'Over-contract summary',
            topicProposals: [],
            usageUsd: 0.06,
          }),
      },
      timeZone: 'America/New_York',
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 0.05 });
    service.attachHistorySource(repeatingHistory(page([old], null)));

    await expect(service.runNext(now)).resolves.toEqual({
      reason: 'usage-contract',
      status: 'budget-paused',
    });

    expect(service.status()).toMatchObject({
      actualUsageUsd: 0.05,
      pauseReason: 'usage-contract',
      status: 'paused',
    });
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('runs recent backfill through the channel service background lane', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = Date.UTC(2026, 6, 14, 12);
    const recent = normalized(
      '32345678901234567',
      'A recent backfilled discussion.',
      now - 1_000,
    );
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([page([recent], null)]),
      now: () => now,
      pricing: zeroPricing,
    });
    await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const context = new ChannelContextService({
      backfillPricing: zeroPricing,
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1536),
          usageUsd: 0,
        }),
      guildId,
      now: () => now,
      summarizer: {
        summarize: ({ sources }) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: sources.map(({ id }) => id),
            summary: 'summary',
            topicProposals: [],
            usageUsd: 0,
          }),
      },
      timeZone: 'America/New_York',
    });
    context.attachHistorySource(fakeHistory([page([recent], null)]));

    expect(context.nextDeadline(now, 'backfill')).toBeLessThanOrEqual(now);
    await expect(context.runNext(now, 'backfill')).resolves.toMatchObject({
      status: 'completed',
    });

    expect(
      database
        .prepare(
          `select content, content_state as contentState
           from conversation_events where discord_message_id = ?`,
        )
        .get(recent.messageId),
    ).toEqual({
      content: recent.content,
      contentState: 'available',
    });
    expect(setup.status()).toMatchObject({ status: 'active' });
    database.close();
  });

  it('charges the full recent and expired rollup chain to its run', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = Date.UTC(2026, 6, 14, 12);
    const recent = normalized(
      '42345678901234567',
      'Recent attributed discussion.',
      now - 10 * 24 * 60 * 60 * 1_000,
    );
    const expired = normalized(
      '32345678901234567',
      'Expired attributed discussion.',
      now - 40 * 24 * 60 * 60 * 1_000,
    );
    const historyPage = page([recent, expired], null);
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([historyPage]),
      now: () => now,
      pricing: zeroPricing,
    });
    const run = await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const context = new ChannelContextService({
      backfillPricing: zeroPricing,
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1536),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.01,
      guildId,
      now: () => now,
      summarizer: {
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: input.sources.map(({ id }) => id),
            summary: `${input.tier} attributed summary`,
            topicProposals:
              input.tier === 'daily'
                ? [
                    {
                      label: 'Attributed topic',
                      sourceIds: [input.sources[0]?.id ?? 'missing'],
                    },
                  ]
                : [],
            usageUsd: 0.001,
          }),
      },
      timeZone: 'America/New_York',
    });
    context.attachHistorySource(repeatingHistory(historyPage));
    const scheduler = new BackgroundScheduler({
      backfill: {
        nextDeadline: (time) => context.nextDeadline(time, 'backfill'),
        runOne: (time) => context.runNext(time, 'backfill'),
      },
      context: {
        nextDeadline: (time) => context.nextDeadline(time),
        runOne: (time) => context.runNext(time),
      },
      memory: { nextDeadline: () => null, runOne: () => Promise.resolve() },
      queue: new PaidWorkQueue(),
    });

    await scheduler.runBackgroundOne(now);

    expect(setup.status(run.runId)).toMatchObject({ status: 'active' });
    expect(
      database
        .prepare(
          `select distinct backfill_run_id from context_jobs
           where backfill_run_id is not null`,
        )
        .pluck()
        .all(),
    ).toEqual([run.runId]);

    for (
      let attempt = 0;
      attempt < 30 && setup.status(run.runId)?.status === 'active';
      attempt += 1
    ) {
      await scheduler.runBackgroundOne(now);
    }

    expect(setup.status(run.runId)).toMatchObject({ status: 'completed' });
    expect(
      database
        .prepare(
          `select distinct tier from context_jobs
           where backfill_run_id = ? order by tier`,
        )
        .pluck()
        .all(run.runId),
    ).toEqual(['daily', 'hourly', 'long-term', 'weekly']);
    expect(
      database
        .prepare(
          `select count(*) from usage_ledger
           where backfill_run_id = ? and actual_usd is not null`,
        )
        .pluck()
        .get(run.runId),
    ).toBeGreaterThan(0);
    const attributedUsage = Number(
      database
        .prepare(
          `select coalesce(sum(actual_usd), 0) from usage_ledger
           where backfill_run_id = ?`,
        )
        .pluck()
        .get(run.runId),
    );
    expect(setup.status(run.runId)?.actualUsageUsd).toBeCloseTo(
      attributedUsage,
    );
    expect(attributedUsage).toBeGreaterThan(0);
    expect(attributedUsage).toBeLessThanOrEqual(1);
    expect(
      database
        .prepare(
          `select count(*) from context_jobs
           where backfill_run_id = ? and status != 'completed'`,
        )
        .pluck()
        .get(run.runId),
    ).toBe(0);
    database.close();
  });

  it('pauses before an induced rollup can exceed its run ceiling', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = Date.UTC(2026, 6, 14, 12);
    const expired = normalized(
      '32345678901234567',
      'Expired ceiling discussion.',
      now - 40 * 24 * 60 * 60 * 1_000,
    );
    const historyPage = page([expired], null);
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([historyPage]),
      now: () => now,
      pricing: zeroPricing,
    });
    const run = await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 0.015 });
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const context = new ChannelContextService({
      backfillPricing: zeroPricing,
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      estimateUsd: 0.01,
      guildId,
      now: () => now,
      summarizer: {
        summarize: ({ sources }) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: sources.map(({ id }) => id),
            summary: 'Ceiling summary',
            topicProposals: [],
            usageUsd: 0.005,
          }),
      },
      timeZone: 'America/New_York',
    });
    context.attachHistorySource(repeatingHistory(historyPage));
    const scheduler = new BackgroundScheduler({
      backfill: {
        nextDeadline: (time) => context.nextDeadline(time, 'backfill'),
        runOne: (time) => context.runNext(time, 'backfill'),
      },
      context: {
        nextDeadline: (time) => context.nextDeadline(time),
        runOne: (time) => context.runNext(time),
      },
      memory: { nextDeadline: () => null, runOne: () => Promise.resolve() },
      queue: new PaidWorkQueue(),
    });

    for (
      let attempt = 0;
      attempt < 10 && setup.status(run.runId)?.status === 'active';
      attempt += 1
    ) {
      await scheduler.runBackgroundOne(now);
    }

    expect(setup.status(run.runId)).toMatchObject({
      actualUsageUsd: 0.01,
      maximumUsageUsd: 0.015,
      pauseReason: 'run-budget',
      status: 'paused',
    });
    expect(
      database
        .prepare(
          `select count(*) from usage_ledger
           where backfill_run_id = ? and actual_usd is null`,
        )
        .pluck()
        .get(run.runId),
    ).toBe(0);
    database.close();
  });

  it('rejects induced rollup usage above its reservation', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = Date.UTC(2026, 6, 14, 12);
    const expired = normalized(
      '32345678901234567',
      'Expired provider contract discussion.',
      now - 40 * 24 * 60 * 60 * 1_000,
    );
    const historyPage = page([expired], null);
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([historyPage]),
      now: () => now,
      pricing: zeroPricing,
    });
    const run = await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    let summarizeCalls = 0;
    const context = new ChannelContextService({
      backfillPricing: zeroPricing,
      budget,
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      estimateUsd: 0.01,
      guildId,
      now: () => now,
      summarizer: {
        summarize: ({ sources }) => {
          summarizeCalls += 1;
          return Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: sources.map(({ id }) => id),
            summary: 'Provider contract summary',
            topicProposals: [],
            usageUsd: summarizeCalls === 1 ? 0.001 : 0.02,
          });
        },
      },
      timeZone: 'America/New_York',
    });
    context.attachHistorySource(repeatingHistory(historyPage));

    await expect(context.runNext(now, 'backfill')).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(context.runNext(now)).resolves.toMatchObject({
      reason: 'usage-contract',
      status: 'budget-deferred',
    });

    expect(setup.status(run.runId)).toMatchObject({
      actualUsageUsd: 0.011,
      pauseReason: 'usage-contract',
      status: 'paused',
    });
    expect(
      database
        .prepare(
          `select count(*) from context_documents
           where tier = 'daily' and state = 'active'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select last_error_category from context_jobs
           where tier = 'daily' and backfill_run_id = ?`,
        )
        .pluck()
        .get(run.runId),
    ).toBe('usage-contract');
    expect(context.nextDeadline(now + 24 * 60 * 60 * 1_000)).toBeNull();
    database.close();
  });

  it('starts at the oldest manifest page and honors source tombstones', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const newest = normalized('52345678901234567', 'Newest page words', 3_000);
    const tombstoned = normalized(
      '32345678901234567',
      'Deleted words must not return',
      2_000,
    );
    const oldest = normalized('22345678901234568', 'Oldest page words', 1_000);
    const manifestPages = [
      page([newest], '42345678901234567'),
      page([tombstoned, oldest], null),
    ];
    const summarize = vi.fn(
      ({ sources }: { sources: readonly { id: string }[] }) =>
        Promise.resolve({
          confidence: 0.9,
          inputTokens: 1,
          outputTokens: 1,
          sourceIds: sources.map(({ id }) => id),
          summary: 'Oldest safe summary',
          topicProposals: [],
          usageUsd: 0,
        }),
    );
    const service = processingService({
      database,
      history: fakeHistory(manifestPages),
      now,
      summarize,
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values ('old-delete', 'source', ?, 'discord-deleted', ?, 'checksum')`,
      )
      .run(`${guildId}/${channelId}/${tombstoned.messageId}`, now);
    const processing = {
      fetchPage: vi.fn((input: DiscordHistoryFetchInput) =>
        Promise.resolve(
          input.cursor === '42345678901234567'
            ? (manifestPages[1] ?? page([], null))
            : (manifestPages[0] ?? page([], null)),
        ),
      ),
    };
    service.attachHistorySource(processing);

    await service.runNext(now);

    expect(processing.fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '42345678901234567' }),
    );
    expect(
      database
        .prepare(
          `select discord_message_id from conversation_events order by id`,
        )
        .pluck()
        .all(),
    ).toEqual([oldest.messageId]);
    expect(JSON.stringify(summarize.mock.calls)).not.toContain(
      'Deleted words must not return',
    );
    database.close();
  });

  it('does not replace a newer live revision with fetched history', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const fetched = normalized(
      '32345678901234567',
      'Stale fetched text',
      1_000,
    );
    const conversation = new ConversationStore(database);
    const context = new ChannelContextService({
      channelId,
      conversation,
      database,
      guildId,
      now: () => now,
      timeZone: 'America/New_York',
    });
    context.apply({
      content: 'New live edit',
      editedAt: 3_000,
      messageId: fetched.messageId,
      memoryExtraction: 'none',
      occurredAt: fetched.occurredAt,
      requestId: fetched.messageId,
      revisionChecksum: 'newer-live-revision',
      role: 'human',
      speakerId: 'live-author',
      speakerName: 'Live author',
      type: 'upsert',
    });
    const summarize = vi.fn();
    const service = processingService({
      database,
      history: fakeHistory([page([fetched], null)]),
      now,
      summarize,
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    service.attachHistorySource(fakeHistory([page([fetched], null)]));

    await service.runNext(now);

    expect(
      database
        .prepare(
          `select content, revision_checksum as revisionChecksum
           from conversation_events where discord_message_id = ?`,
        )
        .get(fetched.messageId),
    ).toEqual({
      content: 'New live edit',
      revisionChecksum: 'newer-live-revision',
    });
    expect(summarize).not.toHaveBeenCalled();
    database.close();
  });

  it('charges an outstanding reservation before restart resume admission', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const old = normalized('32345678901234567', 'Old words', 1_000);
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([page([old], null)]),
      now: () => now,
      pricing: zeroPricing,
    });
    const ready = await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 0.075 });
    const firstBudget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    expect(
      firstBudget.reserve('context-backfill', 0.05, {
        backfillRunId: ready.runId,
        priority: 'background',
        workCategory: 'indexing',
      }),
    ).toMatchObject({ allowed: true });
    const restartedBudget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const summarize = vi.fn();
    const restarted = new ContextBackfillService({
      budget: restartedBudget,
      channelId,
      database,
      embed: vi.fn(),
      estimateUsd: 0.05,
      guildId,
      history: fakeHistory([page([old], null)]),
      now: () => now,
      pricing: zeroPricing,
      summarizer: { summarize },
      timeZone: 'America/New_York',
    });

    await expect(restarted.runNext(now)).resolves.toEqual({
      reason: 'run-budget',
      status: 'budget-paused',
    });

    expect(restarted.status()).toMatchObject({
      actualUsageUsd: 0.05,
      pauseReason: 'run-budget',
      status: 'paused',
    });
    expect(summarize).not.toHaveBeenCalled();
    database.close();
  });

  it('reconciles a prior-month reservation before finalizing', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const reservedAt = Date.UTC(2026, 6, 31, 23, 59);
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([page([], null)]),
      now: () => reservedAt,
      pricing: zeroPricing,
    });
    const ready = await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    database
      .prepare(
        'update context_backfills set next_page_index = null where id = ?',
      )
      .run(ready.runId);
    const ledger = new SqliteUsageLedger(database);
    const firstBudget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger,
      now: () => reservedAt,
      warningUsd: 5,
    });
    expect(
      firstBudget.reserve('context-backfill', 0.05, {
        backfillRunId: ready.runId,
        priority: 'background',
        workCategory: 'indexing',
      }),
    ).toMatchObject({ allowed: true });
    const restartedAt = Date.UTC(2026, 7, 1, 0, 1);
    const restarted = new ContextBackfillService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger,
        now: () => restartedAt,
        warningUsd: 5,
      }),
      channelId,
      database,
      guildId,
      now: () => restartedAt,
      pricing: zeroPricing,
    });

    await expect(restarted.runNext(restartedAt)).resolves.toEqual({
      runId: ready.runId,
      status: 'completed',
    });
    expect(restarted.status()).toMatchObject({
      actualUsageUsd: 0.05,
      status: 'completed',
    });
    expect(
      database
        .prepare(
          'select actual_usd from usage_ledger where backfill_run_id = ?',
        )
        .pluck()
        .get(ready.runId),
    ).toBe(0.05);
    database.close();
  });

  it('deduplicates overlapping and out-of-order manifest pages', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const newest = normalized('52345678901234567', 'Newest words', 3_000);
    const duplicate = normalized(
      '42345678901234567',
      'Overlapping words',
      2_000,
    );
    const oldest = normalized('22345678901234568', 'Oldest words', 1_000);
    const pages = [
      page([newest, duplicate], duplicate.messageId),
      page([duplicate, oldest], null),
    ];
    const summarizedSourceIds: string[] = [];
    const summarize = vi.fn(
      ({ sources }: { sources: readonly { id: string }[] }) => {
        summarizedSourceIds.push(...sources.map(({ id }) => id));
        return Promise.resolve({
          confidence: 0.9,
          inputTokens: 1,
          outputTokens: 1,
          sourceIds: sources.map(({ id }) => id),
          summary: 'summary',
          topicProposals: [],
          usageUsd: 0,
        });
      },
    );
    const service = processingService({
      database,
      history: fakeHistory(pages),
      now,
      summarize,
    });
    const manifest = await service.dryRun({ replace: false });
    expect(manifest.eligibleCount).toBe(3);
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    service.attachHistorySource({
      fetchPage: (input) =>
        Promise.resolve(
          input.cursor === duplicate.messageId
            ? (pages[1] ?? page([], null))
            : (pages[0] ?? page([], null)),
        ),
    });

    for (
      let index = 0;
      index < 5 && service.status()?.status === 'active';
      index += 1
    ) {
      await service.runNext(now);
    }

    expect(
      summarizedSourceIds.filter((id) =>
        id.startsWith(`source:${duplicate.messageId}`),
      ),
    ).toHaveLength(1);
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(3);
    expect(service.status()).toMatchObject({ status: 'active' });
    database.close();
  });

  it('anchors page zero below creates newer than the manifest ceiling', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = Date.UTC(2026, 6, 14, 12);
    const manifestNewest = normalized(
      '42345678901234567',
      'Manifest newest',
      now - 2_000,
    );
    const manifestOldest = normalized(
      '32345678901234567',
      'Manifest oldest',
      now - 3_000,
    );
    const manifested = [manifestNewest, manifestOldest];
    const manifestPage = page(manifested, null);
    const setup = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([manifestPage]),
      now: () => now,
      pricing: zeroPricing,
    });
    await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    const newer = Array.from({ length: 101 }, (_, index) =>
      normalized(
        (52345678901234567n + BigInt(index)).toString(),
        `Concurrent create ${index.toString()}`,
        now - 1_000 + index,
      ),
    ).reverse();
    const processing = {
      fetchPage: vi.fn((input: DiscordHistoryFetchInput) =>
        Promise.resolve(
          input.scanUpperBoundMessageId === manifestNewest.messageId
            ? page([manifestNewest], manifestNewest.messageId)
            : input.cursor === manifestNewest.messageId
              ? page([manifestOldest], null)
              : page(newer, null),
        ),
      ),
    };
    const context = equivalenceContext(database, now);
    context.attachHistorySource(processing);

    await context.runNext(now, 'backfill');

    expect(processing.fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: null,
        scanUpperBoundMessageId: manifestNewest.messageId,
      }),
    );
    expect(processing.fetchPage).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(
          `select discord_message_id from conversation_events
           order by occurred_at, id`,
        )
        .pluck()
        .all(),
    ).toEqual(manifested.toReversed().map(({ messageId }) => messageId));
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content like 'Concurrent create %'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('commits unprocessed source pieces when page segments shift', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const sources = [
      normalized('42345678901234567', '33333333', 3_000),
      normalized('32345678901234567', '22222222', 2_000),
      normalized('22345678901234568', '11111111', 1_000),
    ];
    const originalPage = page(sources, null);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const service = new ContextBackfillService({
      budget,
      channelId,
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      estimateUsd: 0.01,
      guildId,
      history: fakeHistory([originalPage]),
      maxSourceTokens: 2,
      now: () => now,
      pricing: zeroPricing,
      summarizer: {
        summarize: ({ sources: inputs }) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: inputs.map(({ id }) => id),
            summary: inputs.map(({ id }) => id).join(' '),
            topicProposals: [],
            usageUsd: 0,
          }),
      },
      timeZone: 'America/New_York',
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    service.attachHistorySource(repeatingHistory(originalPage));
    await service.runNext(now);

    service.attachHistorySource(
      repeatingHistory({
        ...page(sources.slice(0, 2), null),
        coverage: {
          newestMessageId: sources[0]?.messageId ?? '0',
          oldestMessageId: sources[2]?.messageId ?? '0',
        },
      }),
    );
    await service.runNext(now);
    await service.runNext(now);

    expect(
      database
        .prepare(
          `select message_id from context_backfill_source_identities
           order by occurred_at`,
        )
        .pluck()
        .all(),
    ).toEqual(sources.toReversed().map(({ messageId }) => messageId));
    expect(
      database
        .prepare('select sum(source_count) from context_backfill_segments')
        .pluck()
        .get(),
    ).toBe(3);
    database.close();
  });

  it('aggregates many same-hour segments through bounded pairs', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = 40 * 24 * 60 * 60 * 1_000;
    const sources = Array.from({ length: 8 }, (_, index) =>
      normalized(
        (22345678901234568n + BigInt(index)).toString(),
        index.toString().repeat(8),
        1_000 + index,
      ),
    ).toReversed();
    const sourceCounts: number[] = [];
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const service = new ContextBackfillService({
      budget,
      channelId,
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      estimateUsd: 0.01,
      guildId,
      history: fakeHistory([page(sources, null)]),
      maxSourceTokens: 2,
      now: () => now,
      pricing: zeroPricing,
      summarizer: {
        summarize: ({ sources: inputs }) => {
          sourceCounts.push(inputs.length);
          return Promise.resolve({
            confidence: 0.9,
            inputTokens: inputs.length,
            outputTokens: 1,
            sourceIds: inputs.map(({ id }) => id),
            summary: `node-${sourceCounts.length.toString()}`,
            topicProposals: [],
            usageUsd: 0,
          });
        },
      },
      timeZone: 'America/New_York',
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    service.attachHistorySource(repeatingHistory(page(sources, null)));

    for (const source of sources) {
      expect(source.content).toHaveLength(8);
      await service.runNext(now);
    }

    expect(sourceCounts.every((count) => count <= 2)).toBe(true);
    expect(sourceCounts.length).toBe(sources.length * 2 - 1);
    expect(
      database
        .prepare(
          `select count(*) from context_documents
           where tier = 'hourly' and is_internal = 1`,
        )
        .pluck()
        .get(),
    ).toBe(sources.length);
    database.close();
  });

  it('produces the same active source and rollup from live and recent backfill', async () => {
    const now = Date.UTC(2026, 6, 14, 12);
    const sources = [
      normalized(
        '42345678901234567',
        'Equivalence topic began here.',
        now - 2 * 60 * 60 * 1_000,
      ),
      {
        ...normalized(
          '32345678901234567',
          'Chief answered about the equivalence topic.',
          now - 2 * 60 * 60 * 1_000 + 1_000,
        ),
        authorKind: 'chief' as const,
        requesterId: 'chief-user',
        speakerName: 'Chief',
      },
    ];
    const liveDatabase = openChiefDatabase(':memory:');
    const backfillDatabase = openChiefDatabase(':memory:');
    migrateChiefDatabase(liveDatabase);
    migrateChiefDatabase(backfillDatabase);
    const live = equivalenceContext(liveDatabase, now);
    const backfill = equivalenceContext(backfillDatabase, now);
    for (const source of sources) applyNormalized(live, source);
    const setup = new ContextBackfillService({
      channelId,
      database: backfillDatabase,
      guildId,
      history: fakeHistory([page(sources, null)]),
      now: () => now,
      pricing: zeroPricing,
    });
    await setup.dryRun({ replace: false });
    setup.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    backfill.attachHistorySource(fakeHistory([page(sources, null)]));
    await backfill.runNext(now, 'backfill');
    await live.runNext(now);
    await backfill.runNext(now);

    const sourceSql = `select discord_message_id as messageId, role, content,
                              occurred_at as occurredAt,
                              revision_checksum as revisionChecksum
                       from conversation_events order by occurred_at, id`;
    const documentSql = `select tier, period_start as periodStart,
                                period_end as periodEnd, completeness, state,
                                summary, confidence
                         from context_documents
                         where is_internal = 0 and state = 'active'
                         order by tier, period_start`;
    expect(liveDatabase.prepare(sourceSql).all()).toEqual(
      backfillDatabase.prepare(sourceSql).all(),
    );
    expect(liveDatabase.prepare(documentSql).all()).toEqual(
      backfillDatabase.prepare(documentSql).all(),
    );
    expect(
      liveDatabase
        .prepare(
          `select d.summary from context_document_fts f
           join context_documents d on d.id = f.rowid
           where context_document_fts match 'equivalence'`,
        )
        .pluck()
        .all(),
    ).toEqual(
      backfillDatabase
        .prepare(
          `select d.summary from context_document_fts f
           join context_documents d on d.id = f.rowid
           where context_document_fts match 'equivalence'`,
        )
        .pluck()
        .all(),
    );
    liveDatabase.close();
    backfillDatabase.close();
  });

  it('validates configuration and resumable lifecycle state', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const options = {
      channelId,
      database,
      guildId,
      pricing: zeroPricing,
    };
    expect(
      () => new ContextBackfillService({ ...options, maxSourceTokens: 0 }),
    ).toThrow(/token limit/u);
    expect(
      () => new ContextBackfillService({ ...options, estimateUsd: Number.NaN }),
    ).toThrow(/estimate/u);
    expect(
      () =>
        new ContextBackfillService({
          ...options,
          pricing: { ...zeroPricing, summaryInputPerMillionUsd: -1 },
        }),
    ).toThrow(/prices/u);
    const missingHistory = new ContextBackfillService(options);
    expect(missingHistory.nextDeadline()).toBeNull();
    await expect(missingHistory.dryRun({ replace: false })).rejects.toThrow(
      /history source/u,
    );
    await expect(missingHistory.resume(0)).rejects.toThrow(/positive integer/u);
    await expect(missingHistory.resume(99)).rejects.toThrow(/not found/u);
    await expect(missingHistory.runNext(1_000)).resolves.toEqual({
      status: 'idle',
    });

    const readyService = new ContextBackfillService({
      ...options,
      history: fakeHistory([
        page([normalized('32345678901234567', 'Words', 1_000)], null),
      ]),
    });
    expect(readyService.nextDeadline()).toBeNull();
    const ready = await readyService.dryRun({ replace: false });
    await expect(readyService.resume(ready.runId)).rejects.toThrow(
      /paused or incomplete/u,
    );
    readyService.activate({
      confirmGuildId: guildId,
      maximumUsageUsd: 1,
    });
    expect(readyService.nextDeadline()).not.toBeNull();
    await expect(readyService.runNext(1_000)).resolves.toEqual({
      status: 'idle',
    });
    database.close();
  });

  it('requires explicit replacement for any unfinished run', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const historyPage = page(
      [normalized('32345678901234567', 'Words', 1_000)],
      null,
    );
    const service = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: repeatingHistory(historyPage),
      pricing: zeroPricing,
    });
    const first = await service.dryRun({ replace: false });

    await expect(service.dryRun({ replace: false })).rejects.toThrow(
      /unfinished/u,
    );
    const replacement = await service.dryRun({ replace: true });

    expect(replacement.runId).not.toBe(first.runId);
    expect(service.status(first.runId)).toMatchObject({
      pauseReason: 'replaced',
      status: 'failed',
    });
    database.close();
  });

  it('retries incomplete processing and missing recent ingestion safely', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const now = Date.UTC(2026, 6, 14, 12);
    const recent = normalized('32345678901234567', 'Recent words', now - 1_000);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    const service = new ContextBackfillService({
      budget,
      channelId,
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      guildId,
      history: fakeHistory([page([recent], null)]),
      now: () => now,
      pricing: zeroPricing,
      summarizer: {
        summarize: () => Promise.reject(new Error('not expected')),
      },
    });
    await service.dryRun({ replace: false });
    service.activate({ confirmGuildId: guildId, maximumUsageUsd: 1 });
    service.attachHistorySource({
      fetchPage: () =>
        Promise.resolve({
          complete: false,
          coverage: null,
          items: [],
          nextCursor: null,
          rateLimited: true,
        }),
    });
    await expect(service.runNext(now)).resolves.toEqual({ status: 'retry' });
    service.attachHistorySource(fakeHistory([page([recent], null)]));
    await expect(service.runNext(now)).resolves.toEqual({ status: 'retry' });
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('rejects invalid dry-run page proofs without advancing the manifest', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const source = normalized('32345678901234567', 'Words', 1_000);
    const stalled = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([
        page([source], source.messageId),
        page([source], source.messageId),
      ]),
      pricing: zeroPricing,
    });
    await expect(stalled.dryRun({ replace: false })).rejects.toThrow(
      /cursor did not advance/u,
    );
    const missingCoverage = new ContextBackfillService({
      channelId,
      database,
      guildId,
      history: fakeHistory([
        {
          complete: true,
          coverage: null,
          items: [
            {
              messageId: source.messageId,
              occurredAt: source.occurredAt,
              revisionChecksum: source.revisionChecksum,
              source,
            },
          ],
          nextCursor: null,
          rateLimited: false,
        },
      ]),
      pricing: zeroPricing,
    });
    await expect(missingCoverage.dryRun({ replace: true })).rejects.toThrow(
      /missing coverage/u,
    );
    database.close();
  });
});

const zeroPricing = {
  embeddingInputPerMillionUsd: 0,
  summaryInputPerMillionUsd: 0,
  summaryOutputPerMillionUsd: 0,
};

function normalized(
  messageId: string,
  content: string,
  occurredAt: number,
): NormalizedTextSource {
  return {
    attachmentMetadataJson: '[]',
    authorKind: 'human',
    canModerateContext: false,
    content,
    editedAt: null,
    messageId,
    occurredAt,
    replyToMessageId: null,
    requesterId: `author-${messageId}`,
    revisionChecksum: `revision-${messageId}`,
    speakerName: `Speaker ${messageId}`,
  };
}

function page(
  sources: readonly NormalizedTextSource[],
  nextCursor: string | null,
): DiscordHistoryPage {
  return {
    complete: true,
    coverage:
      sources.length === 0
        ? null
        : {
            newestMessageId: sources[0]?.messageId ?? '0',
            oldestMessageId: sources.at(-1)?.messageId ?? '0',
          },
    items: sources.map((source) => ({
      messageId: source.messageId,
      occurredAt: source.occurredAt,
      revisionChecksum: source.revisionChecksum,
      source,
    })),
    nextCursor,
    rateLimited: false,
  };
}

function fakeHistory(
  pages: readonly DiscordHistoryPage[],
): DiscordHistorySource & {
  readonly fetchPage: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const fetchPage = vi.fn(() => {
    const next = pages[index];
    index += 1;
    if (next === undefined) throw new Error('unexpected history page');
    return Promise.resolve(next);
  });
  return { fetchPage };
}

function repeatingHistory(
  next: DiscordHistoryPage,
): DiscordHistorySource & { readonly fetchPage: ReturnType<typeof vi.fn> } {
  return { fetchPage: vi.fn(() => Promise.resolve(next)) };
}

function processingService(input: {
  readonly database: ReturnType<typeof openChiefDatabase>;
  readonly history: DiscordHistorySource;
  readonly now: number;
  readonly summarize: ContextSummarizer['summarize'];
}): ContextBackfillService {
  const budget = new UsageBudget({
    ceilingUsd: 10,
    indexingCeilingUsd: 3,
    ledger: new SqliteUsageLedger(input.database),
    now: () => input.now,
    warningUsd: 5,
  });
  return new ContextBackfillService({
    budget,
    channelId,
    database: input.database,
    embed: () =>
      Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
    estimateUsd: 0.05,
    guildId,
    history: input.history,
    now: () => input.now,
    pricing: zeroPricing,
    summarizer: { summarize: input.summarize },
    timeZone: 'America/New_York',
  });
}

function equivalenceContext(
  database: ReturnType<typeof openChiefDatabase>,
  now: number,
): ChannelContextService {
  return new ChannelContextService({
    backfillPricing: zeroPricing,
    budget: new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    }),
    channelId,
    conversation: new ConversationStore(database),
    database,
    embed: () =>
      Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
    guildId,
    now: () => now,
    summarizer: {
      summarize: ({ sources }) =>
        Promise.resolve({
          confidence: 0.9,
          inputTokens: 1,
          outputTokens: 1,
          sourceIds: sources.map(({ id }) => id),
          summary: sources.map(({ text }) => text).join(' '),
          topicProposals: [],
          usageUsd: 0,
        }),
    },
    timeZone: 'America/New_York',
  });
}

function applyNormalized(
  context: ChannelContextService,
  source: NormalizedTextSource,
): void {
  context.apply({
    attachmentMetadataJson: source.attachmentMetadataJson,
    canModerateContext: source.canModerateContext,
    content: source.content,
    editedAt: source.editedAt,
    memoryExtraction: source.authorKind === 'chief' ? 'none' : 'automatic',
    messageId: source.messageId,
    occurredAt: source.occurredAt,
    platformEventId: source.messageId,
    replyToMessageId: source.replyToMessageId,
    requestId: source.messageId,
    revisionChecksum: source.revisionChecksum,
    role: source.authorKind === 'chief' ? 'chief' : 'human',
    speakerId: source.requesterId,
    speakerName: source.speakerName,
    type: 'upsert',
  });
}
