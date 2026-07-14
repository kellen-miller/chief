import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ContextAssembler } from '../../src/context/context-assembler.js';
import { ChannelContextService } from '../../src/context/channel-context-service.js';
import type { ContextForgetJournalEntry } from '../../src/context/context-deletion-store.js';
import { contextPeriod } from '../../src/context/context-period.js';
import {
  ContextStore,
  type ContextDocumentRevisionInput,
} from '../../src/context/context-store.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import { discordSourceRevisionChecksum } from '../../src/discord/source-message.js';
import {
  DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID,
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { SqliteUsageLedger } from '../../src/usage/sqlite-usage-ledger.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const timeZone = 'America/New_York';
const sevenDays = 7 * 24 * 60 * 60 * 1_000;
const thirtyDays = 30 * 24 * 60 * 60 * 1_000;

function createHarness(now: number) {
  const database = openChiefDatabase(':memory:');
  let current = now;
  const service = new ChannelContextService({
    channelId,
    conversation: new ConversationStore(database),
    database,
    guildId,
    now: () => current,
    timeZone,
  });
  migrateChiefDatabase(database);
  return {
    contextStore: new ContextStore(database),
    database,
    service,
    setNow: (value: number) => {
      current = value;
    },
  };
}

function source(
  occurredAt: number,
  overrides: Partial<{
    attachmentMetadataJson: string;
    content: string;
    editedAt: number | null;
    messageId: string;
    platformEventId: string;
  }> = {},
) {
  return {
    attachmentMetadataJson: overrides.attachmentMetadataJson ?? '[]',
    content: overrides.content ?? 'Project Marigold launches Friday.',
    editedAt: overrides.editedAt ?? null,
    messageId: overrides.messageId ?? '52345678901234567',
    occurredAt,
    platformEventId: overrides.platformEventId ?? 'live-create-key',
    replyToMessageId: null,
    requestId: '52345678901234567',
    role: 'human' as const,
    speakerId: '42345678901234567',
    speakerName: 'President Test',
    type: 'upsert' as const,
  };
}

function recordLegacySource(
  database: ReturnType<typeof openChiefDatabase>,
  occurredAt: number,
): number {
  const input = source(occurredAt);
  return new ConversationStore(database).record({
    attachmentMetadataJson: input.attachmentMetadataJson,
    channelId,
    content: input.content,
    discordMessageId: input.messageId,
    editedAt: input.editedAt,
    guildId,
    medium: 'text',
    occurredAt: input.occurredAt,
    platformEventId: input.platformEventId,
    recentUntil: occurredAt + sevenDays,
    replyToMessageId: input.replyToMessageId,
    requestId: input.requestId,
    retentionDeadline: occurredAt + thirtyDays,
    role: input.role,
    speakerId: input.speakerId,
    speakerName: input.speakerName,
  });
}

function lexicalIds(
  database: ReturnType<typeof openChiefDatabase>,
  table: 'context_document_fts' | 'conversation_event_fts',
  query: string,
): number[] {
  return database
    .prepare(`select rowid from ${table} where ${table} match ?`)
    .pluck()
    .all(query) as number[];
}

function embedding(value: number): Float32Array {
  const result = new Float32Array(1536);
  result[0] = value;
  return result;
}

function documentInput(
  overrides: Partial<ContextDocumentRevisionInput> = {},
): ContextDocumentRevisionInput {
  return {
    completeness: 'final',
    confidence: 0.9,
    createdAt: 1_000,
    documentKey: 'hourly-cabinet',
    embedding: embedding(0.1),
    eventIds: [],
    generationInputTokens: 10,
    generationOutputTokens: 5,
    generationUsageUsd: 0.01,
    parentDocumentIds: [],
    periodEnd: 2_000,
    periodStart: 1_000,
    retentionDeadline: null,
    revision: 1,
    summary: 'Cabinet meets Friday.',
    tier: 'hourly',
    timeZone,
    topicKey: null,
    ...overrides,
  };
}

function sourceJobInput(
  database: ReturnType<typeof openChiefDatabase>,
  completeness: 'final' | 'provisional' = 'final',
): Pick<
  ContextDocumentRevisionInput,
  'periodEnd' | 'periodStart' | 'sourceRevisionChecksum' | 'timeZone'
> {
  const row = database
    .prepare(
      `select period_start as periodStart, period_end as periodEnd,
              source_revision_checksum as sourceRevisionChecksum,
              timezone as timeZone
       from context_jobs where completeness = ?`,
    )
    .get(completeness) as
    | Pick<
        ContextDocumentRevisionInput,
        'periodEnd' | 'periodStart' | 'sourceRevisionChecksum' | 'timeZone'
      >
    | undefined;
  if (row === undefined) throw new Error('expected a context source job');
  return row;
}

describe('ChannelContextService', () => {
  it('indexes upserts immediately and schedules one hourly job pair', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { database, service, setNow } = createHarness(occurredAt + 1_000);

    const created = service.apply(source(occurredAt));

    expect(created).toMatchObject({ status: 'applied' });
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual([
      created.eventId,
    ]);
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    const jobs = database
      .prepare(
        `select job_key as jobKey, completeness,
                source_revision_checksum as sourceRevisionChecksum,
                not_before as notBefore
         from context_jobs order by completeness desc`,
      )
      .all() as {
      completeness: string;
      jobKey: string;
      notBefore: number;
      sourceRevisionChecksum: string;
    }[];
    expect(jobs).toHaveLength(2);
    expect(jobs.map(({ completeness }) => completeness).sort()).toEqual([
      'final',
      'provisional',
    ]);
    expect(
      jobs.find(({ completeness }) => completeness === 'provisional')
        ?.notBefore,
    ).toBeLessThanOrEqual(occurredAt + 1_000 + 5 * 60 * 1_000);
    expect(
      jobs.find(({ completeness }) => completeness === 'final')?.notBefore,
    ).toBe(period.end);
    expect(jobs.every(({ jobKey }) => jobKey.includes(period.key))).toBe(true);
    const originalChecksum = jobs[0]?.sourceRevisionChecksum;

    setNow(occurredAt + 2_000);
    const edited = service.apply(
      source(occurredAt, {
        content: 'Project Juniper launches Monday.',
        editedAt: occurredAt + 1_500,
        platformEventId: 'reconciliation-key',
      }),
    );

    expect(edited.eventId).toBe(created.eventId);
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(1);
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(lexicalIds(database, 'conversation_event_fts', 'Juniper')).toEqual([
      created.eventId,
    ]);
    expect(
      database
        .prepare('select distinct source_revision_checksum from context_jobs')
        .pluck()
        .all(),
    ).not.toContain(originalChecksum);
    expect(
      database.prepare('select count(*) from context_jobs').pluck().get(),
    ).toBe(2);
    database.close();
  });

  it('keeps the first provisional deadline during continuous activity', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const firstNow = occurredAt + 1_000;
    const { database, service, setNow } = createHarness(firstNow);
    service.apply(source(occurredAt));
    const firstSchedule = database
      .prepare(
        `select not_before as notBefore,
                freshness_deadline as freshnessDeadline
         from context_jobs
         where completeness = 'provisional'`,
      )
      .get() as {
      readonly freshnessDeadline: number;
      readonly notBefore: number;
    };

    setNow(firstNow + 4 * 60 * 1_000);
    service.apply(
      source(occurredAt + 4 * 60 * 1_000, {
        content: 'Project Juniper launches Monday.',
        messageId: '52345678901234568',
        platformEventId: 'second-live-key',
      }),
    );

    expect(
      database
        .prepare(
          `select not_before as notBefore,
                  freshness_deadline as freshnessDeadline
           from context_jobs
           where completeness = 'provisional'`,
        )
        .get(),
    ).toEqual(firstSchedule);
    expect(firstSchedule).toEqual({
      freshnessDeadline: firstNow + 5 * 60 * 1_000,
      notBefore: firstNow + 4 * 60 * 1_000,
    });
    expect(
      database
        .prepare(
          `select not_before from context_jobs where completeness = 'final'`,
        )
        .pluck()
        .get(),
    ).toBe(
      contextPeriod({ instant: occurredAt, tier: 'hourly', timeZone }).end,
    );
    database.close();
  });

  it.each([
    ['paused', 'paused', 'run-budget'],
    ['failed', 'failed', 'induced-job-failed'],
    ['replaced', 'failed', 'replaced'],
  ] as const)(
    'returns live work from a %s backfill to live ownership',
    async (_label, runStatus, pauseReason) => {
      const occurredAt = Date.parse('2026-07-14T15:37:00Z');
      const now = occurredAt + 2 * 60 * 60 * 1_000;
      const database = openChiefDatabase(':memory:');
      migrateChiefDatabase(database);
      const budget = new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => now,
        warningUsd: 5,
      });
      const service = new ChannelContextService({
        backfillPricing: {
          embeddingInputPerMillionUsd: 0,
          summaryInputPerMillionUsd: 0,
          summaryOutputPerMillionUsd: 0,
        },
        budget,
        channelId,
        conversation: new ConversationStore(database),
        database,
        embed: () =>
          Promise.resolve({ embedding: embedding(0.2), usageUsd: 0 }),
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
              summary: 'Live ownership summary.',
              topicProposals: [],
              usageUsd: 0,
            }),
        },
        timeZone,
      });
      service.apply(source(occurredAt));
      const runId = Number(
        database
          .prepare(
            `insert into context_backfills
               (run_key, scope_id, status, maximum_usage_usd, created_at,
                updated_at, pause_reason)
             values (?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            `stale-${pauseReason}`,
            `${guildId}/${channelId}`,
            runStatus,
            now,
            now,
            pauseReason,
          ).lastInsertRowid,
      );
      const staleReservation = budget.reserve('context-rollup', 0.01, {
        backfillRunId: runId,
        priority: 'background',
        workCategory: 'indexing',
      });
      if (!staleReservation.allowed) {
        throw new Error('expected stale backfill reservation');
      }
      database
        .prepare(
          `update context_jobs
           set backfill_run_id = ?, status = 'leased', lease_expires_at = ?,
               usage_reservation_id = ?
           where completeness = 'final'`,
        )
        .run(runId, now + 60_000, staleReservation.id);

      service.apply(
        source(occurredAt + 1_000, {
          content: 'Project Juniper now launches Tuesday.',
          messageId: '52345678901234568',
          platformEventId: 'new-live-source',
        }),
      );

      expect(
        database
          .prepare(
            `select backfill_run_id as backfillRunId, status,
                    usage_reservation_id as usageReservationId
             from context_jobs where completeness = 'final'`,
          )
          .get(),
      ).toEqual({
        backfillRunId: null,
        status: 'pending',
        usageReservationId: staleReservation.id,
      });
      expect(service.nextDeadline(now)).not.toBeNull();
      await expect(service.runNext(now)).resolves.toMatchObject({
        completeness: 'final',
        status: 'completed',
        tier: 'hourly',
      });
      expect(
        database
          .prepare(
            'select actual_usage_usd from context_backfills where id = ?',
          )
          .pluck()
          .get(runId),
      ).toBe(0.01);
      expect(
        database
          .prepare(
            `select actual_usd as actualUsd,
                    backfill_run_id as backfillRunId
             from usage_ledger order by rowid`,
          )
          .all(),
      ).toEqual([
        { actualUsd: 0.01, backfillRunId: runId },
        { actualUsd: 0, backfillRunId: null },
      ]);
      database.close();
    },
  );

  it('rejects context output prepared against a stale source checksum', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(source(occurredAt));
    if (created.status !== 'applied')
      throw new Error('expected a source event');
    const staleChecksum = database
      .prepare(
        `select source_revision_checksum from context_jobs
         where completeness = 'provisional'`,
      )
      .pluck()
      .get() as string;
    service.apply(
      source(occurredAt, {
        content: 'Project Juniper launches Monday.',
        editedAt: occurredAt + 2_000,
      }),
    );
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });

    expect(() =>
      contextStore.activateDocumentRevision({
        ...documentInput({
          createdAt: occurredAt + 3_000,
          eventIds: [created.eventId],
          periodEnd: period.end,
          periodStart: period.start,
        }),
        sourceRevisionChecksum: staleChecksum,
      }),
    ).toThrow('context document source revision changed');
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('rejects source-derived context without a revision checksum', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(source(occurredAt));
    if (created.status !== 'applied') {
      throw new Error('expected a source event');
    }
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });

    expect(() =>
      contextStore.activateDocumentRevision(
        documentInput({
          createdAt: occurredAt + 2_000,
          eventIds: [created.eventId],
          periodEnd: period.end,
          periodStart: period.start,
        }),
      ),
    ).toThrow('context document requires source revision checksum');
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('suppresses active context descendants before applying an edit', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(source(occurredAt));
    if (created.status !== 'applied') {
      throw new Error('expected a source event');
    }
    const documentId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        createdAt: occurredAt + 1_500,
        documentKey: 'hourly-edit-invalidation',
        eventIds: [created.eventId],
        summary: 'Project Marigold launches Friday.',
      }),
    );

    expect(
      service.apply(
        source(occurredAt, {
          content: 'Project Juniper launches Monday.',
          editedAt: occurredAt + 2_000,
        }),
      ),
    ).toMatchObject({ status: 'applied' });

    expect(
      database
        .prepare(
          `select state, content_state as contentState,
                  content_state_reason as contentStateReason, summary
           from context_documents where id = ?`,
        )
        .get(documentId),
    ).toEqual({
      contentState: 'scrubbed',
      contentStateReason: 'retention-expired',
      state: 'suppressed',
      summary: '',
    });
    expect(lexicalIds(database, 'context_document_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(`select distinct status from context_jobs`)
        .pluck()
        .all(),
    ).toEqual(['pending']);
    database.close();
  });

  it('scrubs deletion descendants and blocks resurrection', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(
      source(occurredAt, {
        attachmentMetadataJson: '[{"name":"brief.txt"}]',
        content: 'Delete Project Marigold.',
      }),
    );
    if (created.eventId === null) throw new Error('expected a source event');
    const eventId = created.eventId;
    const documentId = contextStore.activateDocumentRevision({
      ...sourceJobInput(database, 'provisional'),
      completeness: 'provisional',
      confidence: 0.9,
      createdAt: occurredAt + 2_000,
      documentKey: 'hourly-marigold',
      embedding: embedding(0.5),
      eventIds: [eventId],
      generationInputTokens: 10,
      generationOutputTokens: 5,
      generationUsageUsd: 0.01,
      parentDocumentIds: [],
      retentionDeadline: occurredAt + thirtyDays,
      revision: 1,
      summary: 'Project Marigold was discussed.',
      tier: 'hourly',
      topicKey: null,
    });

    const deletedAt = occurredAt + 3_000;
    expect(
      service.apply({
        deletedAt,
        messageId: source(occurredAt).messageId,
        reason: 'discord-deleted',
        type: 'delete',
      }),
    ).toMatchObject({ eventId: created.eventId, status: 'suppressed' });

    expect(
      database
        .prepare(
          `select content, attachment_metadata_json as attachmentMetadataJson,
                  deleted_at as deletedAt, content_state as contentState,
                  content_state_reason as contentStateReason,
                  discord_message_id as discordMessageId
           from conversation_events where id = ?`,
        )
        .get(created.eventId),
    ).toEqual({
      attachmentMetadataJson: '[]',
      content: '',
      contentState: 'scrubbed',
      contentStateReason: 'discord-deleted',
      deletedAt,
      discordMessageId: source(occurredAt).messageId,
    });
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare(
          `select state, content_state as contentState,
                  content_state_reason as contentStateReason, summary
           from context_documents where id = ?`,
        )
        .get(documentId),
    ).toEqual({
      contentState: 'scrubbed',
      contentStateReason: 'discord-deleted',
      state: 'suppressed',
      summary: '',
    });
    expect(lexicalIds(database, 'context_document_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          'select status, last_error_category as error from context_jobs',
        )
        .all(),
    ).toEqual([
      { error: 'rebuild', status: 'pending' },
      { error: 'rebuild', status: 'pending' },
    ]);
    expect(
      database
        .prepare(`select reason, scope_id as scopeId from context_tombstones`)
        .get(),
    ).toEqual({
      reason: 'discord-deleted',
      scopeId: `${guildId}/${channelId}/${source(occurredAt).messageId}`,
    });
    const journal = database
      .prepare('select * from context_forget_journal')
      .get() as Record<string, unknown>;
    expect(journal.upload_status).toBe('pending');
    expect(JSON.stringify(journal)).not.toContain('Delete Project Marigold');

    expect(service.apply(source(occurredAt))).toMatchObject({
      eventId: created.eventId,
      status: 'suppressed',
    });
    expect(
      database
        .prepare('select content from conversation_events where id = ?')
        .pluck()
        .get(created.eventId),
    ).toBe('');
    expect(() =>
      contextStore.activateDocumentRevision({
        ...sourceJobInput(database),
        completeness: 'final',
        confidence: 0.9,
        createdAt: deletedAt + 1,
        documentKey: 'hourly-marigold',
        embedding: embedding(0.6),
        eventIds: [eventId],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        parentDocumentIds: [],
        retentionDeadline: occurredAt + thirtyDays,
        revision: 2,
        summary: 'Project Marigold was discussed.',
        tier: 'hourly',
        topicKey: null,
      }),
    ).toThrow('context document source is unavailable');
    database.close();
  });

  it('distinguishes local forgetting from Discord deletion on replay', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    let captured: ContextForgetJournalEntry | undefined;
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: (entry) => {
        captured = entry;
        return Promise.resolve();
      },
    });
    const created = service.apply(source(occurredAt));

    service.apply({
      deletedAt: occurredAt + 2_000,
      messageId: source(occurredAt).messageId,
      reason: 'locally-forgotten',
      type: 'forget',
    });

    expect(
      database
        .prepare(
          'select content_state_reason from conversation_events where id = ?',
        )
        .pluck()
        .get(created.eventId),
    ).toBe('locally-forgotten');
    expect(
      database.prepare('select reason from context_tombstones').pluck().get(),
    ).toBe('locally-forgotten');
    await expect(
      service.flushForgetJournal(occurredAt + 3_000),
    ).resolves.toEqual({ status: 'uploaded' });
    if (captured === undefined) throw new Error('expected journal upload');

    const restored = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(restored);
      const restoredService = new ChannelContextService({
        channelId,
        conversation: new ConversationStore(restored),
        database: restored,
        guildId,
        memory: new SqliteMemoryStore(restored),
        timeZone,
      });
      const restoredSource = restoredService.apply(source(occurredAt));
      restoredService.replayForgetJournal(captured, occurredAt + 4_000);
      expect(
        restored
          .prepare(
            'select content_state_reason from conversation_events where id = ?',
          )
          .pluck()
          .get(restoredSource.eventId),
      ).toBe('locally-forgotten');
    } finally {
      restored.close();
      database.close();
    }
  });

  it('uploads authoritative deletion journals through the same outbox', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const uploadForgetJournal = vi.fn().mockResolvedValue(undefined);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal,
    });
    service.apply(source(occurredAt));
    service.apply({
      deletedAt: occurredAt + 1_000,
      messageId: source(occurredAt).messageId,
      reason: 'discord-deleted',
      type: 'delete',
    });

    await expect(
      service.flushForgetJournal(occurredAt + 1_000),
    ).resolves.toEqual({ status: 'uploaded' });
    expect(uploadForgetJournal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(uploadForgetJournal.mock.calls)).not.toContain(
      'Marigold',
    );
    expect(
      database
        .prepare('select upload_status from context_forget_journal')
        .pluck()
        .get(),
    ).toBe('uploaded');
    database.close();
  });

  it('scrubs authoritative descendants equivalently live and on replay', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    let captured: ContextForgetJournalEntry | undefined;
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      timeZone,
      uploadForgetJournal: (entry) => {
        captured = entry;
        return Promise.resolve();
      },
    });
    const created = service.apply(
      source(occurredAt, {
        content: 'AuthoritativeDeleteMarker source evidence.',
      }),
    );
    if (created.status !== 'applied' || created.memorySourceEventId === null) {
      throw new Error('expected source and memory provenance');
    }
    const memoryId = memory.applyMemory({
      canonicalText: 'AuthoritativeDeleteMarker durable memory.',
      confidence: 0.95,
      embedding: embedding(0.8),
      kind: 'fact',
      provenance: { platformSourceId: source(occurredAt).messageId },
      sourceEventId: created.memorySourceEventId,
      timestamp: occurredAt + 500,
    });
    const documentId = new ContextStore(database).activateDocumentRevision({
      ...documentInput({
        ...sourceJobInput(database, 'provisional'),
        completeness: 'provisional',
        documentKey: 'authoritative-delete-document',
        eventIds: [created.eventId],
        summary: 'AuthoritativeDeleteMarker topic summary.',
        topicLabel: 'AuthoritativeDeleteTopic',
      }),
    });
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            topic_label, completeness, source_revision_checksum,
            source_document_ids_json, not_before, freshness_deadline, status)
         values ('authoritative-delete-topic', 'long-term', ?, null, ?,
                 'authoritative-delete-topic', 'AuthoritativeDeleteTopic',
                 'final', 'old', ?, ?, ?, 'completed')`,
      )
      .run(
        occurredAt,
        timeZone,
        JSON.stringify([documentId]),
        occurredAt,
        occurredAt,
      );

    service.apply({
      deletedAt: occurredAt + 1_000,
      messageId: source(occurredAt).messageId,
      reason: 'discord-deleted',
      type: 'delete',
    });
    await expect(
      service.flushForgetJournal(occurredAt + 1_000),
    ).resolves.toEqual({ status: 'uploaded' });
    if (captured === undefined) throw new Error('expected journal upload');
    expect(captured.payload.documentKeys).toEqual([
      'authoritative-delete-document',
    ]);
    expect(captured.payload.memoryIds).toEqual([memoryId]);
    expect(
      database
        .prepare(
          `select state, content_state as contentState,
                  content_state_reason as contentStateReason, summary,
                  topic_label as topicLabel
           from context_documents where id = ?`,
        )
        .get(documentId),
    ).toEqual({
      contentState: 'scrubbed',
      contentStateReason: 'discord-deleted',
      state: 'suppressed',
      summary: '',
      topicLabel: null,
    });
    expect(
      database
        .prepare(
          `select topic_label from context_jobs
           where job_key = 'authoritative-delete-topic'`,
        )
        .pluck()
        .get(),
    ).toBeNull();

    const restored = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(restored);
      const restoredMemoryId = new SqliteMemoryStore(restored).applyMemory({
        canonicalText: 'AuthoritativeDeleteMarker restored durable memory.',
        confidence: 0.95,
        embedding: embedding(0.8),
        kind: 'fact',
        provenance: { restored: true },
        sourceEventId: null,
        timestamp: occurredAt,
      });
      expect(restoredMemoryId).toBe(memoryId);
      const restoredDocumentId = Number(
        restored
          .prepare(
            `insert into context_documents
               (document_key, tier, period_start, period_end, timezone,
                topic_key, topic_label, revision, completeness, state,
                content_state, content_state_reason, summary, confidence,
                retention_deadline, created_at, updated_at,
                generation_input_tokens, generation_output_tokens,
                generation_usage_usd, is_internal)
             values ('authoritative-delete-document', 'hourly', ?, ?, ?, null,
                     'AuthoritativeDeleteTopic', 1, 'provisional', 'active',
                     'available', 'retained',
                     'AuthoritativeDeleteMarker restored summary.', 0.9, null,
                     ?, ?, 10, 5, 0.01, 0)`,
          )
          .run(
            occurredAt,
            occurredAt + 60 * 60 * 1_000,
            timeZone,
            occurredAt,
            occurredAt,
          ).lastInsertRowid,
      );
      restored
        .prepare(
          `insert into context_document_fts (rowid, content) values (?, ?)`,
        )
        .run(restoredDocumentId, 'AuthoritativeDeleteMarker restored summary.');
      restored
        .prepare(
          `insert into context_document_vectors (document_id, embedding)
           values (?, ?)`,
        )
        .run(
          BigInt(restoredDocumentId),
          JSON.stringify(Array.from(embedding(0.7))),
        );
      restored
        .prepare(
          `insert into context_jobs
             (job_key, tier, period_start, period_end, timezone, topic_key,
              topic_label, completeness, source_revision_checksum,
              source_document_ids_json, not_before, freshness_deadline, status)
           values ('restored-authoritative-topic', 'long-term', ?, null, ?,
                   'authoritative-delete-topic', 'AuthoritativeDeleteTopic',
                   'final', 'old', ?, ?, ?, 'completed')`,
        )
        .run(
          occurredAt,
          timeZone,
          JSON.stringify([restoredDocumentId]),
          occurredAt,
          occurredAt,
        );
      new ChannelContextService({
        channelId,
        conversation: new ConversationStore(restored),
        database: restored,
        guildId,
        memory: new SqliteMemoryStore(restored),
        timeZone,
      }).replayForgetJournal(captured, occurredAt + 2_000);

      expect(
        restored
          .prepare(
            `select state, content_state as contentState,
                    content_state_reason as contentStateReason, summary,
                    topic_label as topicLabel
             from context_documents where id = ?`,
          )
          .get(restoredDocumentId),
      ).toEqual({
        contentState: 'scrubbed',
        contentStateReason: 'discord-deleted',
        state: 'suppressed',
        summary: '',
        topicLabel: null,
      });
      expect(
        restored
          .prepare(
            `select topic_label from context_jobs
             where job_key = 'restored-authoritative-topic'`,
          )
          .pluck()
          .get(),
      ).toBeNull();
      expect(
        restored
          .prepare('select count(*) from context_document_fts')
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        restored
          .prepare('select count(*) from context_document_vectors')
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        restored.prepare('select count(*) from memories').pluck().get(),
      ).toBe(0);
      expect(
        restored.prepare('select count(*) from memory_fts').pluck().get(),
      ).toBe(0);
      expect(
        restored.prepare('select count(*) from memory_vectors').pluck().get(),
      ).toBe(0);
    } finally {
      restored.close();
      database.close();
    }
  });

  it('upgrades a pending 0004 journal through flush and replay', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database, DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID);
    recordLegacySource(database, occurredAt);
    const scopeId = `${guildId}/${channelId}/${source(occurredAt).messageId}`;
    const tombstoneKey = `source:${scopeId}`;
    const legacyChecksum = createHash('sha256')
      .update(
        JSON.stringify({
          occurredAt: occurredAt + 1_000,
          reason: 'discord-deleted',
          scopeId,
          scopeType: 'source',
        }),
      )
      .digest('hex');
    database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, 'source', ?, 'discord-deleted', ?, ?)`,
      )
      .run(tombstoneKey, scopeId, occurredAt + 1_000, legacyChecksum);
    database
      .prepare(
        `insert into context_forget_journal
           (journal_key, scope_id, tombstone_key, occurred_at, checksum)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        `forget:${scopeId}`,
        scopeId,
        tombstoneKey,
        occurredAt + 1_000,
        legacyChecksum,
      );

    migrateChiefDatabase(database);
    let captured: ContextForgetJournalEntry | undefined;
    const upgraded = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: (entry) => {
        captured = entry;
        return Promise.resolve();
      },
    });
    await expect(
      upgraded.flushForgetJournal(occurredAt + 2_000),
    ).resolves.toEqual({ status: 'uploaded' });
    if (captured === undefined) throw new Error('expected upgraded journal');
    expect(captured.payload).toEqual({
      documentIds: [],
      documentKeys: [],
      memoryIds: [],
      reason: 'discord-deleted',
      sourceScopeIds: [scopeId],
      tombstoneKeys: [tombstoneKey],
    });

    const restored = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(restored);
      const restoredService = new ChannelContextService({
        channelId,
        conversation: new ConversationStore(restored),
        database: restored,
        guildId,
        memory: new SqliteMemoryStore(restored),
        timeZone,
      });
      restoredService.apply(source(occurredAt));
      restoredService.replayForgetJournal(captured, occurredAt + 3_000);
      expect(
        restored
          .prepare('select content_state from conversation_events')
          .pluck()
          .get(),
      ).toBe('scrubbed');
    } finally {
      restored.close();
      database.close();
    }
  });

  it('preserves a pending 0004 local-forget reason through migration', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database, DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID);
    const eventId = recordLegacySource(database, occurredAt);
    const scopeId = `${guildId}/${channelId}/${source(occurredAt).messageId}`;
    const tombstoneKey = `source:${scopeId}`;
    const legacyChecksum = createHash('sha256')
      .update(
        JSON.stringify({
          occurredAt: occurredAt + 1_000,
          reason: 'locally-forgotten',
          scopeId,
          scopeType: 'source',
        }),
      )
      .digest('hex');
    database
      .prepare(
        `update conversation_events
         set content = '', deleted_at = ?, content_state = 'scrubbed',
             content_state_reason = 'locally-forgotten'
         where id = ?`,
      )
      .run(occurredAt + 1_000, eventId);
    database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, 'source', ?, 'locally-forgotten', ?, ?)`,
      )
      .run(tombstoneKey, scopeId, occurredAt + 1_000, legacyChecksum);
    database
      .prepare(
        `insert into context_forget_journal
           (journal_key, scope_id, tombstone_key, occurred_at, checksum)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        `forget:${scopeId}`,
        scopeId,
        tombstoneKey,
        occurredAt + 1_000,
        legacyChecksum,
      );

    migrateChiefDatabase(database);
    let captured: ContextForgetJournalEntry | undefined;
    const upgraded = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: (entry) => {
        captured = entry;
        return Promise.resolve();
      },
    });
    await expect(
      upgraded.flushForgetJournal(occurredAt + 2_000),
    ).resolves.toEqual({ status: 'uploaded' });
    if (captured === undefined) throw new Error('expected upgraded journal');
    expect(captured.payload.reason).toBe('locally-forgotten');

    const restored = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(restored);
      const restoredService = new ChannelContextService({
        channelId,
        conversation: new ConversationStore(restored),
        database: restored,
        guildId,
        memory: new SqliteMemoryStore(restored),
        timeZone,
      });
      const restoredSource = restoredService.apply(source(occurredAt));
      restoredService.replayForgetJournal(captured, occurredAt + 3_000);
      expect(
        restored
          .prepare(
            'select content_state_reason from conversation_events where id = ?',
          )
          .pluck()
          .get(restoredSource.eventId),
      ).toBe('locally-forgotten');
    } finally {
      restored.close();
      database.close();
    }
  });

  it('forgets one authored source across every active store', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    const uploadForgetJournal = vi.fn().mockResolvedValue(undefined);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      now: () => occurredAt + 5_000,
      timeZone,
      uploadForgetJournal,
    });
    const contextStore = new ContextStore(database);
    const created = service.apply(
      source(occurredAt, {
        attachmentMetadataJson: '[{"name":"marigold.txt"}]',
        content: 'Project Marigold launches Friday.',
      }),
    );
    if (created.status !== 'applied' || created.memorySourceEventId === null) {
      throw new Error('expected source and memory provenance');
    }
    const documentId = contextStore.activateDocumentRevision({
      ...sourceJobInput(database, 'provisional'),
      completeness: 'provisional',
      confidence: 0.9,
      createdAt: occurredAt + 2_000,
      documentKey: 'hourly-marigold',
      embedding: embedding(0.5),
      eventIds: [created.eventId],
      generationInputTokens: 10,
      generationOutputTokens: 5,
      generationUsageUsd: 0.01,
      parentDocumentIds: [],
      retentionDeadline: occurredAt + thirtyDays,
      revision: 1,
      summary: 'Project Marigold launches Friday.',
      tier: 'hourly',
      topicKey: null,
    });
    const memoryId = memory.applyMemory({
      canonicalText: 'Project Marigold launches Friday.',
      confidence: 0.95,
      embedding: embedding(0.7),
      kind: 'fact',
      provenance: { platformSourceId: source(occurredAt).messageId },
      sourceEventId: created.memorySourceEventId,
      timestamp: occurredAt + 3_000,
    });

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget that Project Marigold launches Friday',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234567',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({
      documentCount: 1,
      memoryCount: 1,
      sourceCount: 1,
      status: 'forgotten',
    });

    expect(uploadForgetJournal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(uploadForgetJournal.mock.calls)).not.toContain(
      'Marigold',
    );
    expect(
      database
        .prepare(
          `select content, attachment_metadata_json as attachments,
                  content_state as contentState,
                  content_state_reason as reason
           from conversation_events where id = ?`,
        )
        .get(created.eventId),
    ).toEqual({
      attachments: '[]',
      content: '',
      contentState: 'scrubbed',
      reason: 'locally-forgotten',
    });
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare(
          `select state, content_state as contentState, summary
           from context_documents where id = ?`,
        )
        .get(documentId),
    ).toEqual({ contentState: 'scrubbed', state: 'suppressed', summary: '' });
    expect(lexicalIds(database, 'context_document_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select canonical_text as canonicalText, provenance_json as provenance,
                  state from memories where id = ?`,
        )
        .get(memoryId),
    ).toEqual({ canonicalText: '', provenance: '{}', state: 'superseded' });
    expect(
      database
        .prepare('select rowid from memory_fts where memory_fts match ?')
        .pluck()
        .all('Marigold'),
    ).toEqual([]);
    expect(
      database.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare('select content from source_events where id = ?')
        .pluck()
        .get(created.memorySourceEventId),
    ).toBe('');
    expect(
      database
        .prepare(
          'select scope_type from context_tombstones order by scope_type',
        )
        .pluck()
        .all(),
    ).toEqual(['document', 'source']);
    const journal = database
      .prepare(
        `select payload_json as payload, upload_status as uploadStatus
         from context_forget_journal`,
      )
      .get() as { payload: string; uploadStatus: string };
    expect(journal.uploadStatus).toBe('uploaded');
    expect(journal.payload).not.toContain('Marigold');
    expect(
      database
        .prepare(
          `select count(*) from context_jobs
           where status = 'pending' and last_error_category = 'rebuild'`,
        )
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
    const prepared = await new ContextAssembler({
      channelId,
      conversation: new ConversationStore(database),
      database,
      embed: vi.fn().mockResolvedValue({
        embedding: embedding(0.1),
        usageUsd: 0,
      }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memory,
      }),
      timeZone,
    }).assemble({ now: occurredAt + 6_000, prompt: 'Marigold' });
    expect(JSON.stringify(prepared)).not.toContain('Marigold');
    database.close();
  });

  it('requires and consumes one administrator confirmation', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    let now = occurredAt + 5_000;
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      now: () => now,
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    service.apply(source(occurredAt));
    service.apply({
      ...source(occurredAt + 1_000, {
        messageId: '52345678901234568',
        platformEventId: 'second-marigold',
      }),
      speakerId: '42345678901234568',
      speakerName: 'Another Member',
    });

    const requested = await service.forget({
      canModerateContext: true,
      content: 'Chief, forget every message about Project Marigold',
      now,
      requestMessageId: '62345678901234568',
      requesterId: '72345678901234567',
    });
    expect(requested).toMatchObject({
      sourceCount: 2,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected a confirmation request');
    }
    const stored = database
      .prepare(
        `select source_ids_json as sourceIds, document_ids_json as documentIds,
                memory_ids_json as memoryIds, scope_type as scopeType, status
         from context_deletion_requests`,
      )
      .get() as Record<string, unknown>;
    expect(stored.status).toBe('pending');
    expect(stored.scopeType).toBe('topic');
    expect(JSON.stringify(stored)).not.toContain('Marigold');
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available' and content like '%Marigold%'`,
        )
        .pluck()
        .get(),
    ).toBe(2);

    await expect(
      service.forget({
        canModerateContext: true,
        confirmationNonce: requested.confirmationNonce,
        content: `Chief, confirm forget ${requested.confirmationNonce}`,
        now,
        requestMessageId: '62345678901234569',
        requesterId: '72345678901234567',
      }),
    ).resolves.toMatchObject({ sourceCount: 2, status: 'forgotten' });
    await expect(
      service.forget({
        canModerateContext: true,
        confirmationNonce: requested.confirmationNonce,
        content: `Chief, confirm forget ${requested.confirmationNonce}`,
        now,
        requestMessageId: '62345678901234570',
        requesterId: '72345678901234567',
      }),
    ).resolves.toEqual({ status: 'confirmation-invalid' });
    expect(
      database
        .prepare('select status from context_deletion_requests')
        .pluck()
        .get(),
    ).toBe('consumed');

    service.apply({
      ...source(occurredAt + 2_000, {
        content: 'Project Juniper launches Monday.',
        messageId: '52345678901234569',
        platformEventId: 'juniper',
      }),
      speakerId: '42345678901234568',
    });
    const expiring = await service.forget({
      canModerateContext: true,
      content: 'Chief, forget every message about Project Juniper',
      now,
      requestMessageId: '62345678901234571',
      requesterId: '72345678901234567',
    });
    if (expiring.status !== 'confirmation-required') {
      throw new Error('expected an expiring confirmation request');
    }
    now += 5 * 60 * 1_000 + 1;
    await expect(
      service.forget({
        canModerateContext: true,
        confirmationNonce: expiring.confirmationNonce,
        content: `Chief, confirm forget ${expiring.confirmationNonce}`,
        now,
        requestMessageId: '62345678901234572',
        requesterId: '72345678901234567',
      }),
    ).resolves.toEqual({ status: 'confirmation-expired' });
    expect(
      database
        .prepare(
          `select count(*) from context_deletion_requests
           where status = 'pending'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available' and content like '%Juniper%'`,
        )
        .pluck()
        .get(),
    ).toBe(1);

    service.apply({
      ...source(now + 1_000, {
        content: 'Project Kestrel launches Tuesday.',
        messageId: '52345678901234583',
        platformEventId: 'kestrel',
      }),
      speakerId: '42345678901234568',
    });
    await expect(
      service.forget({
        canModerateContext: true,
        content: 'Chief, forget every message about Project Kestrel',
        now,
        requestMessageId: '62345678901234584',
        requesterId: '72345678901234567',
      }),
    ).resolves.toMatchObject({ status: 'confirmation-required' });
    service.maintain(now + 5 * 60 * 1_000 + 1);
    expect(
      database
        .prepare(
          `select count(*) from context_deletion_requests
           where status = 'pending'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('fails closed before revealing a cross-member match', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    service.apply({
      ...source(occurredAt, {
        content: 'HiddenNarrowMarker remains scheduled for Friday.',
      }),
      speakerId: '42345678901234568',
      speakerName: 'Another Member',
    });

    const hiddenNarrow = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget HiddenNarrowMarker',
      now: occurredAt + 4_000,
      requestMessageId: '62345678901234589',
      requesterId: '42345678901234567',
    });
    const absentNarrow = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget AbsentNarrowMarker',
      now: occurredAt + 4_000,
      requestMessageId: '62345678901234590',
      requesterId: '42345678901234567',
    });
    expect(hiddenNarrow).toEqual(absentNarrow);
    expect(hiddenNarrow).toEqual({ status: 'clarification-required' });

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget every message from Another Member',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234573',
        requesterId: '42345678901234567',
      }),
    ).resolves.toEqual({ status: 'unauthorized' });
    expect(
      database
        .prepare('select count(*) from context_deletion_requests')
        .pluck()
        .get(),
    ).toBe(0);
    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget every message about HiddenNoMatchMarker',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234588',
        requesterId: '42345678901234567',
      }),
    ).resolves.toEqual({ status: 'unauthorized' });

    const administratorRequest = await service.forget({
      canModerateContext: true,
      content: 'Chief, forget every message from Another Member',
      now: occurredAt + 5_000,
      requestMessageId: '62345678901234574',
      requesterId: '72345678901234567',
    });
    expect(administratorRequest).toMatchObject({
      sourceCount: 1,
      status: 'confirmation-required',
    });
    if (administratorRequest.status !== 'confirmation-required') {
      throw new Error('expected administrator confirmation');
    }
    expect(
      database
        .prepare('select scope_type from context_deletion_requests')
        .pluck()
        .get(),
    ).toBe('member');
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available'`,
        )
        .pluck()
        .get(),
    ).toBe(1);
    await expect(
      service.forget({
        canModerateContext: false,
        confirmationNonce: administratorRequest.confirmationNonce,
        content: `Chief, confirm forget ${administratorRequest.confirmationNonce}`,
        now: occurredAt + 6_000,
        requestMessageId: '62345678901234575',
        requesterId: '72345678901234567',
      }),
    ).resolves.toEqual({ status: 'unauthorized' });
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available'`,
        )
        .pluck()
        .get(),
    ).toBe(1);
    await expect(
      service.forget({
        canModerateContext: true,
        confirmationNonce: administratorRequest.confirmationNonce,
        content: `Chief, confirm forget ${administratorRequest.confirmationNonce}`,
        now: occurredAt + 7_000,
        requestMessageId: '62345678901234576',
        requesterId: '72345678901234567',
      }),
    ).resolves.toMatchObject({ status: 'forgotten' });
    database.close();
  });

  it('refuses a member label shared by different Discord identities', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    for (const [index, speakerId] of [
      '42345678901234567',
      '42345678901234568',
    ].entries()) {
      service.apply({
        ...source(occurredAt + index, {
          content: `SharedLabelMarker source ${String(index)}.`,
          messageId: String(52345678901234640n + BigInt(index)),
          platformEventId: `shared-label-${String(index)}`,
        }),
        speakerId,
        speakerName: 'Shared Display',
      });
    }

    await expect(
      service.forget({
        canModerateContext: true,
        content: 'Chief, forget every message from Shared Display',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234640',
        requesterId: '72345678901234567',
      }),
    ).resolves.toEqual({ status: 'clarification-required' });
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available'`,
        )
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database
        .prepare('select count(*) from context_deletion_requests')
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('clarifies ambiguous narrow matches before offering broad confirmation', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    for (const [index, messageId] of [
      '52345678901234579',
      '52345678901234580',
    ].entries()) {
      service.apply({
        ...source(occurredAt + index, {
          content: `OrchidMarker appears in source ${String(index)}.`,
          messageId,
          platformEventId: `orchid-${String(index)}`,
        }),
      });
    }

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget OrchidMarker',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234578',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toEqual({ status: 'clarification-required' });
    expect(
      database
        .prepare('select count(*) from context_deletion_requests')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available'`,
        )
        .pluck()
        .get(),
    ).toBe(2);

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget every message about OrchidMarker',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234579',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({
      sourceCount: 2,
      status: 'confirmation-required',
    });
    database.close();
  });

  it('anchors broad deletion to the complete named subject', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    for (const [index, project] of ['Marigold', 'Juniper'].entries()) {
      service.apply(
        source(occurredAt + index, {
          content: `Project ${project} launches Friday.`,
          messageId: String(52345678901234600n + BigInt(index)),
          platformEventId: `project-${project.toLowerCase()}`,
        }),
      );
    }

    const requested = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget every message about Project Marigold',
      now: occurredAt + 5_000,
      requestMessageId: '62345678901234600',
      requesterId: source(occurredAt).speakerId,
    });
    expect(requested).toMatchObject({
      sourceCount: 1,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected broad subject confirmation');
    }
    await service.forget({
      canModerateContext: false,
      confirmationNonce: requested.confirmationNonce,
      content: `Chief, confirm forget ${requested.confirmationNonce}`,
      now: occurredAt + 6_000,
      requestMessageId: '62345678901234601',
      requesterId: source(occurredAt).speakerId,
    });
    expect(
      database
        .prepare(
          `select content, content_state as contentState
           from conversation_events order by id`,
        )
        .all(),
    ).toEqual([
      { content: '', contentState: 'scrubbed' },
      {
        content: 'Project Juniper launches Friday.',
        contentState: 'available',
      },
    ]);
    database.close();
  });

  it('keeps every lowercase subject term as a deletion anchor', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    for (const [index, content] of [
      'alice vacation begins monday.',
      'bob vacation begins tuesday.',
    ].entries()) {
      service.apply(
        source(occurredAt + index, {
          content,
          messageId: String(52345678901234605n + BigInt(index)),
          platformEventId: `lowercase-subject-${String(index)}`,
        }),
      );
    }

    const requested = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget every message about alice vacation',
      now: occurredAt + 5_000,
      requestMessageId: '62345678901234605',
      requesterId: source(occurredAt).speakerId,
    });
    expect(requested).toMatchObject({
      sourceCount: 1,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected lowercase subject confirmation');
    }
    await service.forget({
      canModerateContext: false,
      confirmationNonce: requested.confirmationNonce,
      content: `Chief, confirm forget ${requested.confirmationNonce}`,
      now: occurredAt + 6_000,
      requestMessageId: '62345678901234606',
      requesterId: source(occurredAt).speakerId,
    });
    expect(
      database
        .prepare(
          `select content, content_state as contentState
           from conversation_events order by id`,
        )
        .all(),
    ).toEqual([
      { content: '', contentState: 'scrubbed' },
      { content: 'bob vacation begins tuesday.', contentState: 'available' },
    ]);
    database.close();
  });

  it('does not select a sole raw source only through derived text', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    const created = service.apply(
      source(occurredAt, { content: 'The launch code is Cobalt.' }),
    );
    if (created.eventId === null) throw new Error('expected source event');
    new ContextStore(database).activateDocumentRevision({
      ...documentInput({
        ...sourceJobInput(database, 'final'),
        documentKey: 'derived-only-marigold',
        eventIds: [created.eventId],
        summary: 'Project Marigold uses the launch code.',
      }),
    });

    const requested = await service.forget({
      canModerateContext: true,
      content: 'Chief, forget all records about Project Marigold',
      now: occurredAt + 5_000,
      requestMessageId: '62345678901234607',
      requesterId: 'moderator',
    });
    expect(requested).toMatchObject({
      documentCount: 1,
      sourceCount: 0,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected derived document confirmation');
    }
    await expect(
      service.forget({
        canModerateContext: true,
        confirmationNonce: requested.confirmationNonce,
        content: `Chief, confirm forget ${requested.confirmationNonce}`,
        now: occurredAt + 6_000,
        requestMessageId: '62345678901234608',
        requesterId: 'moderator',
      }),
    ).resolves.toMatchObject({
      documentCount: 1,
      sourceCount: 0,
      status: 'forgotten',
    });
    expect(
      database
        .prepare(
          `select content, content_state as contentState
           from conversation_events where id = ?`,
        )
        .get(created.eventId),
    ).toEqual({
      content: 'The launch code is Cobalt.',
      contentState: 'available',
    });
    database.close();
  });

  it('discovers every exact broad match before acknowledging deletion', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    for (let index = 0; index < 21; index += 1) {
      service.apply(
        source(occurredAt + index, {
          content: `ExactBatchMarker source ${String(index)}.`,
          messageId: String(52345678901234610n + BigInt(index)),
          platformEventId: `exact-batch-${String(index)}`,
        }),
      );
    }

    const requested = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget every message about ExactBatchMarker',
      now: occurredAt + 5_000,
      requestMessageId: '62345678901234610',
      requesterId: source(occurredAt).speakerId,
    });
    expect(requested).toMatchObject({
      sourceCount: 21,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected complete broad confirmation');
    }
    await expect(
      service.forget({
        canModerateContext: false,
        confirmationNonce: requested.confirmationNonce,
        content: `Chief, confirm forget ${requested.confirmationNonce}`,
        now: occurredAt + 6_000,
        requestMessageId: '62345678901234611',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({ sourceCount: 21, status: 'forgotten' });
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'scrubbed'`,
        )
        .pluck()
        .get(),
    ).toBe(21);
    database.close();
  });

  it('refuses broad deletion beyond its complete discovery ceiling', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    for (let index = 0; index < 1_001; index += 1) {
      service.apply(
        source(occurredAt + index, {
          content: `CeilingMarker source ${String(index)}.`,
          messageId: String(52345678901235000n + BigInt(index)),
          platformEventId: `ceiling-${String(index)}`,
        }),
      );
    }

    await expect(
      service.forget({
        canModerateContext: true,
        content: 'Chief, forget every message about CeilingMarker',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901235000',
        requesterId: '72345678901234567',
      }),
    ).resolves.toEqual({ status: 'clarification-required' });
    const hiddenNarrow = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget CeilingMarker',
      now: occurredAt + 6_000,
      requestMessageId: '62345678901235001',
      requesterId: '72345678901234567',
    });
    const absentNarrow = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget AbsentCeilingMarker',
      now: occurredAt + 6_000,
      requestMessageId: '62345678901235002',
      requesterId: '72345678901234567',
    });
    expect(hiddenNarrow).toEqual(absentNarrow);
    expect(hiddenNarrow).toEqual({ status: 'clarification-required' });
    expect(
      database
        .prepare('select count(*) from context_deletion_requests')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select count(*) from conversation_events
           where content_state = 'available'`,
        )
        .pluck()
        .get(),
    ).toBe(1_001);
    database.close();
  });

  it('includes a provenance-free durable memory in an administrator purge', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    let captured: ContextForgetJournalEntry | undefined;
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      timeZone,
      uploadForgetJournal: (entry) => {
        captured = entry;
        return Promise.resolve();
      },
    });
    const memoryId = memory.applyMemory({
      canonicalText: 'StandaloneMarker is a migrated durable fact.',
      confidence: 0.95,
      embedding: embedding(0.8),
      kind: 'fact',
      provenance: { migrated: true },
      sourceEventId: null,
      timestamp: occurredAt,
    });

    const requested = await service.forget({
      canModerateContext: true,
      content: 'Chief, forget all records about StandaloneMarker',
      now: occurredAt + 5_000,
      requestMessageId: '62345678901234580',
      requesterId: '72345678901234567',
    });
    expect(requested).toMatchObject({
      memoryCount: 1,
      sourceCount: 0,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected durable-memory confirmation');
    }
    await expect(
      service.forget({
        canModerateContext: true,
        confirmationNonce: requested.confirmationNonce,
        content: `Chief, confirm forget ${requested.confirmationNonce}`,
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234581',
        requesterId: '72345678901234567',
      }),
    ).resolves.toMatchObject({ memoryCount: 1, status: 'forgotten' });
    expect(
      database
        .prepare('select canonical_text from memories where id = ?')
        .pluck()
        .get(memoryId),
    ).toBe('');
    expect(
      database
        .prepare('select scope_type from context_tombstones')
        .pluck()
        .get(),
    ).toBe('topic');
    if (captured === undefined) throw new Error('expected journal upload');
    const olderBackup = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(olderBackup);
      new ChannelContextService({
        channelId,
        conversation: new ConversationStore(olderBackup),
        database: olderBackup,
        guildId,
        memory: new SqliteMemoryStore(olderBackup),
        timeZone,
      }).replayForgetJournal(captured, occurredAt + 6_000);
      expect(
        olderBackup
          .prepare(
            `select scope_type, upload_status from context_tombstones
             join context_forget_journal using (tombstone_key)`,
          )
          .get(),
      ).toEqual({ scope_type: 'topic', upload_status: 'uploaded' });
    } finally {
      olderBackup.close();
    }
    database.close();
  });

  it('scrubs durable-memory supersession history and private snapshots', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    const originalSource = service.apply({
      ...source(occurredAt, {
        content: 'DinnerMarker is scheduled for six.',
        messageId: '52345678901234581',
        platformEventId: 'dinner-six',
      }),
    });
    const correctionSource = service.apply({
      ...source(occurredAt + 1_000, {
        content: 'Correction: SevenMarker is scheduled for seven.',
        messageId: '52345678901234582',
        platformEventId: 'dinner-seven',
      }),
    });
    if (
      originalSource.status !== 'applied' ||
      originalSource.memorySourceEventId === null ||
      correctionSource.status !== 'applied' ||
      correctionSource.memorySourceEventId === null
    ) {
      throw new Error('expected memory source provenance');
    }
    const originalId = memory.applyMemory({
      canonicalText: 'DinnerMarker is scheduled for six.',
      confidence: 0.95,
      embedding: embedding(0.5),
      kind: 'plan',
      provenance: {},
      sourceEventId: originalSource.memorySourceEventId,
      timestamp: occurredAt + 2_000,
    });
    memory.supersede(originalId, {
      canonicalText: 'SevenMarker is scheduled for seven.',
      confidence: 0.97,
      embedding: embedding(0.6),
      kind: 'plan',
      provenance: {},
      sourceEventId: correctionSource.memorySourceEventId,
      timestamp: occurredAt + 3_000,
    });

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget SevenMarker',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234583',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({ status: 'forgotten' });
    expect(
      database
        .prepare('select canonical_text from memories order by id')
        .pluck()
        .all(),
    ).toEqual(['', '']);
    expect(
      database
        .prepare('select content from source_events order by id')
        .pluck()
        .all(),
    ).toEqual(['', '']);
    database.close();
  });

  it('rolls back every store when journal insertion fails', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    service.apply(source(occurredAt));
    database.exec(`
      create trigger reject_forget_journal
      before insert on context_forget_journal
      begin
        select raise(abort, 'simulated journal failure');
      end;
    `);

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget Project Marigold launches Friday',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234586',
        requesterId: source(occurredAt).speakerId,
      }),
    ).rejects.toThrow('simulated journal failure');
    expect(
      database
        .prepare(
          `select content_state, content from conversation_events
           where discord_message_id = ?`,
        )
        .get(source(occurredAt).messageId),
    ).toMatchObject({
      content: 'Project Marigold launches Friday.',
      content_state: 'available',
    });
    expect(
      database.prepare('select count(*) from context_tombstones').pluck().get(),
    ).toBe(0);
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual([
      1,
    ]);
    database.close();
  });

  it('scrubs every descendant revision and stable document identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-revisions-'));
    const backupPath = join(directory, 'after-revision-forget.db');
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(database);
      const service = new ChannelContextService({
        channelId,
        conversation: new ConversationStore(database),
        database,
        guildId,
        memory: new SqliteMemoryStore(database),
        timeZone,
        uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
      });
      const created = service.apply(
        source(occurredAt, {
          content: 'RevisionLeakMarker source evidence.',
        }),
      );
      if (created.eventId === null) throw new Error('expected source event');
      const store = new ContextStore(database);
      const hourlyOne = store.activateDocumentRevision({
        ...sourceJobInput(database, 'final'),
        completeness: 'final',
        confidence: 0.9,
        createdAt: occurredAt + 1_000,
        documentKey: 'revision-leak-hourly',
        embedding: embedding(0.2),
        eventIds: [created.eventId],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        isInternal: true,
        parentDocumentIds: [],
        retentionDeadline: null,
        revision: 1,
        summary: 'RevisionLeakMarker superseded hourly summary.',
        tier: 'hourly',
        topicKey: null,
        topicLabel: 'RevisionLeakTopicLabel',
      });
      const hourlyTwo = store.activateDocumentRevision({
        ...sourceJobInput(database, 'final'),
        completeness: 'final',
        confidence: 0.9,
        createdAt: occurredAt + 2_000,
        documentKey: 'revision-leak-hourly',
        embedding: embedding(0.3),
        eventIds: [created.eventId],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        parentDocumentIds: [],
        retentionDeadline: null,
        revision: 2,
        summary: 'RevisionLeakMarker active hourly summary.',
        tier: 'hourly',
        topicKey: null,
        topicLabel: 'RevisionLeakTopicLabel',
      });
      const dailyOne = store.activateDocumentRevision({
        completeness: 'final',
        confidence: 0.9,
        createdAt: occurredAt + 3_000,
        documentKey: 'revision-leak-daily',
        embedding: embedding(0.4),
        eventIds: [],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        parentDocumentIds: [hourlyTwo],
        periodEnd: occurredAt + 24 * 60 * 60 * 1_000,
        periodStart: occurredAt - 24 * 60 * 60 * 1_000,
        retentionDeadline: null,
        revision: 1,
        summary: 'RevisionLeakMarker superseded daily summary.',
        tier: 'daily',
        timeZone,
        topicKey: null,
        topicLabel: 'RevisionLeakTopicLabel',
      });
      const dailyTwo = store.activateDocumentRevision({
        completeness: 'final',
        confidence: 0.9,
        createdAt: occurredAt + 4_000,
        documentKey: 'revision-leak-daily',
        embedding: embedding(0.5),
        eventIds: [],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        isInternal: true,
        parentDocumentIds: [hourlyTwo],
        periodEnd: occurredAt + 24 * 60 * 60 * 1_000,
        periodStart: occurredAt - 24 * 60 * 60 * 1_000,
        retentionDeadline: null,
        revision: 2,
        summary: 'RevisionLeakMarker internal daily summary.',
        tier: 'daily',
        timeZone,
        topicKey: null,
        topicLabel: 'RevisionLeakTopicLabel',
      });
      database
        .prepare(
          `insert into context_jobs
             (job_key, tier, period_start, period_end, timezone, topic_key,
              topic_label, completeness, source_revision_checksum,
              source_document_ids_json, not_before, freshness_deadline)
           values ('revision-leak-topic', 'long-term', ?, null, ?,
                   'revision-leak-topic', 'RevisionLeakTopicLabel', 'final',
                   'old', ?, ?, ?)`,
        )
        .run(
          occurredAt,
          timeZone,
          JSON.stringify([dailyOne, dailyTwo]),
          occurredAt,
          occurredAt,
        );

      await expect(
        service.forget({
          canModerateContext: false,
          content: 'Chief, forget RevisionLeakMarker',
          now: occurredAt + 5_000,
          requestMessageId: '62345678901234650',
          requesterId: source(occurredAt).speakerId,
        }),
      ).resolves.toMatchObject({ documentCount: 4, status: 'forgotten' });
      expect(
        database
          .prepare(
            `select id, state, content_state as contentState, summary,
                    topic_label as topicLabel
             from context_documents order by id`,
          )
          .all(),
      ).toEqual(
        [hourlyOne, hourlyTwo, dailyOne, dailyTwo].map((id) => ({
          contentState: 'scrubbed',
          id,
          state: 'suppressed',
          summary: '',
          topicLabel: null,
        })),
      );
      expect(
        database
          .prepare(
            `select topic_label from context_jobs
             where job_key = 'revision-leak-topic'`,
          )
          .pluck()
          .get(),
      ).toBeNull();
      expect(
        database
          .prepare(
            `select scope_id from context_tombstones
             where scope_type = 'document' order by scope_id`,
          )
          .pluck()
          .all(),
      ).toEqual(['revision-leak-hourly']);

      await database.backup(backupPath);
      const backup = openChiefDatabase(backupPath);
      try {
        expect(
          backup
            .prepare(
              `select
                 (select count(*) from context_documents
                  where summary like '%RevisionLeak%'
                     or topic_label like '%RevisionLeak%') +
                 (select count(*) from context_jobs
                  where topic_label like '%RevisionLeak%')`,
            )
            .pluck()
            .get(),
        ).toBe(0);
      } finally {
        backup.close();
      }

      const replacement = service.apply(
        source(occurredAt + 6_000, {
          content: 'Unrelated retained evidence.',
          messageId: '52345678901234651',
          platformEventId: 'replacement-evidence',
        }),
      );
      if (replacement.eventId === null) {
        throw new Error('expected replacement source');
      }
      const replacementEventId = replacement.eventId;
      expect(() =>
        store.activateDocumentRevision({
          ...sourceJobInput(database, 'final'),
          completeness: 'final',
          confidence: 0.9,
          createdAt: occurredAt + 7_000,
          documentKey: 'revision-leak-hourly',
          embedding: embedding(0.6),
          eventIds: [replacementEventId],
          generationInputTokens: 10,
          generationOutputTokens: 5,
          generationUsageUsd: 0.01,
          parentDocumentIds: [],
          retentionDeadline: null,
          revision: 3,
          summary: 'Reintroduced summary.',
          tier: 'hourly',
          topicKey: null,
        }),
      ).toThrow('context document is tombstoned');
    } finally {
      database.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('withholds acknowledgement until a failed journal upload retries', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    const failing = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      timeZone,
      uploadForgetJournal: vi.fn().mockRejectedValue(new Error('unavailable')),
    });
    failing.apply(source(occurredAt));

    await expect(
      failing.forget({
        canModerateContext: false,
        content: 'Chief, forget Project Marigold',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234575',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({ status: 'journal-pending' });
    expect(
      database
        .prepare('select upload_status from context_forget_journal')
        .pluck()
        .get(),
    ).toBe('failed');
    expect(
      database
        .prepare('select content_state from conversation_events')
        .pluck()
        .get(),
    ).toBe('scrubbed');
    expect(failing.status(occurredAt + 5_001)).toMatchObject({
      degraded: true,
      reason: 'forget-journal',
    });

    const upload = vi.fn().mockResolvedValue(undefined);
    const restarted = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      timeZone,
      uploadForgetJournal: upload,
    });
    await expect(
      restarted.flushForgetJournal(occurredAt + 10_000),
    ).resolves.toEqual({ status: 'uploaded' });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(upload.mock.calls)).not.toContain('Marigold');
    expect(
      database
        .prepare('select upload_status from context_forget_journal')
        .pluck()
        .get(),
    ).toBe('uploaded');
    expect(
      database
        .prepare('select content_state from conversation_events')
        .pluck()
        .get(),
    ).toBe('scrubbed');
    database.close();
  });

  it('tombstones expired raw evidence found through retained lineage', async () => {
    const occurredAt = Date.parse('2026-06-01T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new SqliteMemoryStore(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory,
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    const created = service.apply(
      source(occurredAt, { content: 'Project Marigold launches Friday.' }),
    );
    if (created.eventId === null) throw new Error('expected a source event');
    const contextStore = new ContextStore(database);
    contextStore.activateDocumentRevision({
      ...sourceJobInput(database, 'final'),
      completeness: 'final',
      confidence: 0.9,
      createdAt: occurredAt + 2_000,
      documentKey: 'retained-marigold',
      embedding: embedding(0.4),
      eventIds: [created.eventId],
      generationInputTokens: 10,
      generationOutputTokens: 5,
      generationUsageUsd: 0.01,
      parentDocumentIds: [],
      retentionDeadline: null,
      revision: 1,
      summary: 'Project Marigold launches Friday.',
      tier: 'hourly',
      topicKey: null,
    });
    service.maintain(occurredAt + thirtyDays);
    expect(
      database
        .prepare('select content_state_reason from conversation_events')
        .pluck()
        .get(),
    ).toBe('retention-expired');

    await expect(
      service.forget({
        canModerateContext: false,
        content: 'Chief, forget Project Marigold launches Friday',
        now: occurredAt + thirtyDays + 1,
        requestMessageId: '62345678901234576',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({ sourceCount: 1, status: 'forgotten' });
    expect(
      database
        .prepare('select content_state_reason from conversation_events')
        .pluck()
        .get(),
    ).toBe('locally-forgotten');
    expect(
      database
        .prepare(
          `select scope_type from context_tombstones order by scope_type`,
        )
        .pluck()
        .all(),
    ).toEqual(['document', 'source']);
    expect(service.apply(source(occurredAt))).toMatchObject({
      status: 'suppressed',
    });
    database.close();
  });

  it('forgets a self-authored source after raw retention expires', async () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
      uploadForgetJournal: vi.fn().mockResolvedValue(undefined),
    });
    service.apply({
      ...source(occurredAt),
      speakerName: 'Retention Member',
    });
    service.maintain(occurredAt + thirtyDays);

    const requested = await service.forget({
      canModerateContext: false,
      content: 'Chief, forget every message from Retention Member',
      now: occurredAt + thirtyDays + 1,
      requestMessageId: '62345678901234585',
      requesterId: source(occurredAt).speakerId,
    });
    expect(requested).toMatchObject({
      sourceCount: 1,
      status: 'confirmation-required',
    });
    if (requested.status !== 'confirmation-required') {
      throw new Error('expected broad self-delete confirmation');
    }
    await expect(
      service.forget({
        canModerateContext: false,
        confirmationNonce: requested.confirmationNonce,
        content: `Chief, confirm forget ${requested.confirmationNonce}`,
        now: occurredAt + thirtyDays + 2,
        requestMessageId: '62345678901234587',
        requesterId: source(occurredAt).speakerId,
      }),
    ).resolves.toMatchObject({ sourceCount: 1, status: 'forgotten' });
    expect(
      database
        .prepare(
          `select count(*) from context_tombstones
           where scope_type = 'source'`,
        )
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });

  it('replays a forget journal into a restored pre-purge database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-forget-'));
    const backupPath = join(directory, 'before-forget.db');
    const afterForgetBackupPath = join(directory, 'after-forget.db');
    const missingSourceBackupPath = join(directory, 'before-forget-missing.db');
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    let captured: ContextForgetJournalEntry | undefined;
    const database = openChiefDatabase(':memory:');
    try {
      migrateChiefDatabase(database);
      const memory = new SqliteMemoryStore(database);
      const service = new ChannelContextService({
        channelId,
        conversation: new ConversationStore(database),
        database,
        guildId,
        memory,
        timeZone,
        uploadForgetJournal: (entry) => {
          captured = entry;
          return Promise.resolve();
        },
      });
      const created = service.apply(source(occurredAt));
      if (
        created.status !== 'applied' ||
        created.memorySourceEventId === null
      ) {
        throw new Error('expected source provenance');
      }
      new ContextStore(database).activateDocumentRevision({
        ...sourceJobInput(database, 'provisional'),
        completeness: 'provisional',
        confidence: 0.9,
        createdAt: occurredAt + 2_000,
        documentKey: 'restore-marigold',
        embedding: embedding(0.4),
        eventIds: [created.eventId],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        parentDocumentIds: [],
        retentionDeadline: null,
        revision: 1,
        summary: 'Project Marigold launches Friday.',
        tier: 'hourly',
        topicKey: null,
      });
      memory.applyMemory({
        canonicalText: 'Project Marigold launches Friday.',
        confidence: 0.95,
        embedding: embedding(0.7),
        kind: 'fact',
        provenance: {},
        sourceEventId: created.memorySourceEventId,
        timestamp: occurredAt + 3_000,
      });
      await database.backup(backupPath);
      await database.backup(missingSourceBackupPath);
      await service.forget({
        canModerateContext: false,
        content: 'Chief, forget Project Marigold launches Friday',
        now: occurredAt + 5_000,
        requestMessageId: '62345678901234582',
        requesterId: source(occurredAt).speakerId,
      });
      if (captured === undefined) throw new Error('expected journal upload');
      await database.backup(afterForgetBackupPath);

      const afterForget = openChiefDatabase(afterForgetBackupPath);
      try {
        expect(
          afterForget
            .prepare(
              `select
                 (select count(*) from conversation_events
                  where content like '%Marigold%') +
                 (select count(*) from context_documents
                  where summary like '%Marigold%') +
                 (select count(*) from memories
                  where canonical_text like '%Marigold%') +
                 (select count(*) from source_events
                  where content like '%Marigold%')`,
            )
            .pluck()
            .get(),
        ).toBe(0);
        expect(
          lexicalIds(afterForget, 'conversation_event_fts', 'Marigold'),
        ).toEqual([]);
        expect(
          lexicalIds(afterForget, 'context_document_fts', 'Marigold'),
        ).toEqual([]);
      } finally {
        afterForget.close();
      }

      const restored = openChiefDatabase(backupPath);
      try {
        migrateChiefDatabase(restored);
        const restarted = new ChannelContextService({
          channelId,
          conversation: new ConversationStore(restored),
          database: restored,
          guildId,
          memory: new SqliteMemoryStore(restored),
          timeZone,
        });
        restarted.replayForgetJournal(captured, occurredAt + 6_000);
        restarted.replayForgetJournal(captured, occurredAt + 7_000);
        expect(
          restored
            .prepare('select content_state from conversation_events')
            .pluck()
            .get(),
        ).toBe('scrubbed');
        expect(
          restored
            .prepare(
              `select rowid from conversation_event_fts
               where conversation_event_fts match 'Marigold'`,
            )
            .pluck()
            .all(),
        ).toEqual([]);
        expect(
          restored.prepare('select state from context_documents').pluck().get(),
        ).toBe('suppressed');
        expect(
          restored
            .prepare(
              `select scope_id from context_tombstones
               where scope_type = 'document'`,
            )
            .pluck()
            .get(),
        ).toBe('restore-marigold');
        expect(
          restored
            .prepare('select count(*) from context_document_vectors')
            .pluck()
            .get(),
        ).toBe(0);
        expect(
          restored.prepare('select canonical_text from memories').pluck().get(),
        ).toBe('');
        expect(
          restored
            .prepare('select upload_status from context_forget_journal')
            .pluck()
            .get(),
        ).toBe('uploaded');
      } finally {
        restored.close();
      }

      const missingSource = openChiefDatabase(missingSourceBackupPath);
      try {
        migrateChiefDatabase(missingSource);
        const sourceId = missingSource
          .prepare('select id from conversation_events')
          .pluck()
          .get() as number;
        missingSource
          .prepare('delete from conversation_event_fts where rowid = ?')
          .run(sourceId);
        missingSource
          .prepare('delete from context_document_events where event_id = ?')
          .run(sourceId);
        missingSource
          .prepare('delete from conversation_events where id = ?')
          .run(sourceId);
        new ChannelContextService({
          channelId,
          conversation: new ConversationStore(missingSource),
          database: missingSource,
          guildId,
          memory: new SqliteMemoryStore(missingSource),
          timeZone,
        }).replayForgetJournal(captured, occurredAt + 8_000);
        expect(
          missingSource
            .prepare(
              `select count(*) from context_tombstones
               where scope_type = 'source' and scope_id = ?`,
            )
            .pluck()
            .get(captured.payload.sourceScopeIds[0]),
        ).toBe(1);
      } finally {
        missingSource.close();
      }
    } finally {
      database.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('ignores snapshot-local document IDs during journal replay', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const service = new ChannelContextService({
      channelId,
      conversation: new ConversationStore(database),
      database,
      guildId,
      memory: new SqliteMemoryStore(database),
      timeZone,
    });
    const created = service.apply(
      source(occurredAt, {
        content: 'Project Juniper remains unrelated.',
      }),
    );
    if (created.eventId === null) throw new Error('expected unrelated source');
    const unrelatedDocumentId = new ContextStore(
      database,
    ).activateDocumentRevision({
      ...documentInput({
        ...sourceJobInput(database, 'provisional'),
        completeness: 'provisional',
        documentKey: 'collision-juniper',
        eventIds: [created.eventId],
        summary: 'Project Juniper remains unrelated.',
      }),
    });
    const targetScopeId = `${guildId}/${channelId}/52345678901234999`;
    const payload = {
      documentIds: [unrelatedDocumentId],
      documentKeys: ['missing-marigold-document'],
      memoryIds: [],
      sourceScopeIds: [targetScopeId],
      tombstoneKeys: [`source:${targetScopeId}`],
    };
    const journalKey = 'forget:numeric-document-collision';
    const checksum = createHash('sha256')
      .update(JSON.stringify({ journalKey, occurredAt, payload }))
      .digest('hex');

    service.replayForgetJournal(
      { checksum, journalKey, occurredAt, payload },
      occurredAt + 1_000,
    );

    expect(
      database
        .prepare(
          `select state, content_state as contentState, summary
           from context_documents where id = ?`,
        )
        .get(unrelatedDocumentId),
    ).toEqual({
      contentState: 'available',
      state: 'active',
      summary: 'Project Juniper remains unrelated.',
    });
    database.close();
  });

  it('removes retained text from lexical search at raw expiry', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { database, service } = createHarness(occurredAt + 1_000);
    service.apply(source(occurredAt));

    expect(service.maintain(occurredAt + thirtyDays)).toEqual({
      deletedEvents: 1,
    });

    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select content_state_reason from conversation_events')
        .pluck()
        .get(),
    ).toBe('retention-expired');
    database.close();
  });

  it('records delivered chunks once with Discord identity and time', () => {
    const { database, service, setNow } = createHarness(1_000);
    const chunks = [
      {
        content: 'First chunk. ',
        messageId: '62345678901234567',
        occurredAt: 1_100,
      },
      {
        content: 'Second chunk.',
        messageId: '62345678901234568',
        occurredAt: 1_200,
      },
    ];
    const [firstChunk, secondChunk] = chunks;
    if (firstChunk === undefined || secondChunk === undefined) {
      throw new Error('expected reply chunks');
    }

    service.recordDeliveredReply({
      chunks: [firstChunk],
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });
    setNow(2_000);
    service.recordDeliveredReply({
      chunks: [firstChunk, secondChunk],
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });

    expect(
      database
        .prepare(
          `select discord_message_id as discordMessageId, content, occurred_at as occurredAt,
                  recent_until as recentUntil, retention_deadline as retentionDeadline,
                  logical_response_id as logicalResponseId,
                  platform_event_id as platformEventId,
                  reply_to_message_id as replyToMessageId,
                  response_chunk_index as responseChunkIndex,
                  revision_checksum as revisionChecksum,
                  speaker_id as speakerId
           from conversation_events order by id`,
        )
        .all(),
    ).toEqual(
      chunks.map((chunk) => ({
        content: chunk.content,
        discordMessageId: chunk.messageId,
        logicalResponseId: 'response-1',
        occurredAt: chunk.occurredAt,
        platformEventId: chunk.messageId,
        recentUntil: chunk.occurredAt + sevenDays,
        replyToMessageId: '52345678901234567',
        responseChunkIndex: chunks.indexOf(chunk),
        revisionChecksum: discordSourceRevisionChecksum({
          attachmentMetadataJson: '[]',
          authorKind: 'chief',
          content: chunk.content,
          editedAt: null,
          messageId: chunk.messageId,
          occurredAt: chunk.occurredAt,
          replyToMessageId: '52345678901234567',
          requesterId: '12345678901234567',
        }),
        retentionDeadline: chunk.occurredAt + thirtyDays,
        speakerId: '12345678901234567',
      })),
    );

    setNow(3_000);
    service.recordDeliveredReply({
      chunks,
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: 'retry-caller-key',
      speakerId: '12345678901234567',
    });
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database
        .prepare('select occurred_at from conversation_events order by id')
        .pluck()
        .all(),
    ).toEqual([1_100, 1_200]);
    database.close();
  });

  it('attaches callback lineage when reconciliation won the source race', () => {
    const { database, service } = createHarness(1_000);
    const messageId = '62345678901234567';
    const revisionChecksum = discordSourceRevisionChecksum({
      attachmentMetadataJson: '[]',
      authorKind: 'chief',
      content: 'Delivered answer.',
      editedAt: null,
      messageId,
      occurredAt: 1_100,
      replyToMessageId: '52345678901234567',
      requesterId: '12345678901234567',
    });
    service.apply({
      attachmentMetadataJson: '[]',
      content: 'Delivered answer.',
      editedAt: null,
      messageId,
      occurredAt: 1_100,
      platformEventId: messageId,
      replyToMessageId: '52345678901234567',
      requestId: messageId,
      revisionChecksum,
      role: 'chief',
      speakerId: '12345678901234567',
      speakerName: 'Chief',
      type: 'upsert',
    });

    service.recordDeliveredReply({
      chunks: [{ content: 'Delivered answer.', messageId, occurredAt: 1_100 }],
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });

    expect(
      database
        .prepare(
          `select count(*) as count,
                  max(logical_response_id) as logicalResponseId,
                  max(request_id) as requestId
           from conversation_events where discord_message_id = ?`,
        )
        .get(messageId),
    ).toEqual({
      count: 1,
      logicalResponseId: 'response-1',
      requestId: '52345678901234567',
    });
    database.close();
  });

  it('repairs durable delivered order after reverse reconciliation', () => {
    const { database, service } = createHarness(1_000);
    const chunks = [
      {
        content: 'First chunk. ',
        messageId: '62345678901234567',
        occurredAt: 1_100,
      },
      {
        content: 'Second chunk.',
        messageId: '62345678901234568',
        occurredAt: 1_200,
      },
    ];
    for (const chunk of [...chunks].reverse()) {
      service.apply({
        attachmentMetadataJson: '[]',
        content: chunk.content,
        editedAt: null,
        messageId: chunk.messageId,
        occurredAt: chunk.occurredAt,
        platformEventId: chunk.messageId,
        replyToMessageId: null,
        requestId: chunk.messageId,
        role: 'chief',
        speakerId: '12345678901234567',
        speakerName: 'Chief',
        type: 'upsert',
      });
    }

    service.recordDeliveredReply({
      chunks,
      logicalResponseId: 'response-ordered',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });

    expect(
      database
        .prepare(
          `select discord_message_id as messageId,
                  response_chunk_index as chunkIndex
           from conversation_events order by response_chunk_index`,
        )
        .all(),
    ).toEqual([
      { chunkIndex: 0, messageId: chunks[0]?.messageId },
      { chunkIndex: 1, messageId: chunks[1]?.messageId },
    ]);
    expect(
      new ConversationStore(database).recent({ now: 2_000 }).events,
    ).toEqual([
      expect.objectContaining({ content: 'First chunk. Second chunk.' }),
    ]);
    database.close();
  });
});

describe('ContextStore', () => {
  it('rejects a document without source or parent lineage atomically', () => {
    const { contextStore, database } = createHarness(1_000);

    expect(() =>
      contextStore.activateDocumentRevision(documentInput()),
    ).toThrow('context document requires lineage');
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
    database.close();
  });

  it('replaces an active document and its search rows atomically', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const base = {
      ...documentInput(),
      ...sourceJobInput(database),
      eventIds: [created.eventId],
    };
    const firstId = contextStore.activateDocumentRevision({
      ...base,
      embedding: embedding(0.1),
      revision: 1,
      summary: 'Cabinet meets Friday.',
    });
    const secondId = contextStore.activateDocumentRevision({
      ...base,
      createdAt: 2_000,
      embedding: embedding(0.2),
      revision: 2,
      summary: 'Cabinet meets Monday.',
    });

    expect(
      database
        .prepare('select id, state from context_documents order by id')
        .all(),
    ).toEqual([
      { id: firstId, state: 'superseded' },
      { id: secondId, state: 'active' },
    ]);
    expect(lexicalIds(database, 'context_document_fts', 'Friday')).toEqual([]);
    expect(lexicalIds(database, 'context_document_fts', 'Monday')).toEqual([
      secondId,
    ]);
    expect(
      database
        .prepare('select document_id from context_document_vectors')
        .pluck()
        .all(),
    ).toEqual([secondId]);
    database.close();
  });

  it.each(['daily', 'weekly', 'long-term'] as const)(
    'rejects raw source lineage for $tier documents atomically',
    (tier) => {
      const { contextStore, database, service } = createHarness(1_000);
      const created = service.apply(source(500));
      if (created.eventId === null) throw new Error('expected a source event');
      const eventId = created.eventId;

      expect(() =>
        contextStore.activateDocumentRevision(
          documentInput({
            documentKey: `${tier}-raw-source`,
            eventIds: [eventId],
            parentDocumentIds: [],
            periodEnd: tier === 'long-term' ? null : 3_000,
            summary: 'Raw source must not bypass hierarchy.',
            tier,
          }),
        ),
      ).toThrow('higher context tier requires parent lineage');
      for (const table of [
        'context_documents',
        'context_document_fts',
        'context_document_vectors',
        'context_document_events',
        'context_document_parents',
      ]) {
        expect(
          database.prepare(`select count(*) from ${table}`).pluck().get(),
        ).toBe(0);
      }
      database.close();
    },
  );

  it('rejects mixed raw and parent lineage for a higher tier atomically', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const eventId = created.eventId;
    const finalParentId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        completeness: 'final',
        documentKey: 'hourly-final-parent',
        eventIds: [eventId],
        summary: 'Final hourly parent.',
      }),
    );
    const tables = [
      'context_documents',
      'context_document_fts',
      'context_document_vectors',
      'context_document_events',
      'context_document_parents',
    ] as const;
    const countsBefore = tables.map((table) =>
      database.prepare(`select count(*) from ${table}`).pluck().get(),
    );

    expect(() =>
      contextStore.activateDocumentRevision(
        documentInput({
          documentKey: 'daily-mixed-lineage',
          eventIds: [eventId],
          parentDocumentIds: [finalParentId],
          periodEnd: 3_000,
          summary: 'Mixed lineage must not bypass hierarchy.',
          tier: 'daily',
        }),
      ),
    ).toThrow('higher context tier requires parent-only lineage');
    expect(
      tables.map((table) =>
        database.prepare(`select count(*) from ${table}`).pluck().get(),
      ),
    ).toEqual(countsBefore);
    expect(lexicalIds(database, 'context_document_fts', 'Mixed')).toEqual([]);
    expect(
      database
        .prepare(
          `select count(*) from context_documents
           where document_key = 'daily-mixed-lineage'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('requires final parents for every higher context tier', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const provisionalId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database, 'provisional'),
        completeness: 'provisional',
        documentKey: 'hourly-source',
        eventIds: [created.eventId],
        summary: 'Provisional hourly rollup.',
      }),
    );

    for (const tier of ['daily', 'weekly', 'long-term'] as const) {
      expect(() =>
        contextStore.activateDocumentRevision(
          documentInput({
            documentKey: `${tier}-rejected`,
            eventIds: [],
            parentDocumentIds: [provisionalId],
            periodEnd: tier === 'long-term' ? null : 3_000,
            summary: 'Rejected higher rollup.',
            tier,
          }),
        ),
      ).toThrow('higher context tier requires final parents');
    }
    expect(lexicalIds(database, 'context_document_fts', 'Rejected')).toEqual(
      [],
    );

    const finalId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        completeness: 'final',
        createdAt: 2_000,
        documentKey: 'hourly-source',
        embedding: embedding(0.2),
        eventIds: [created.eventId],
        revision: 2,
        summary: 'Final hourly rollup.',
      }),
    );
    const dailyId = contextStore.activateDocumentRevision(
      documentInput({
        documentKey: 'daily-accepted',
        eventIds: [],
        parentDocumentIds: [finalId],
        periodEnd: 3_000,
        summary: 'Accepted daily rollup.',
        tier: 'daily',
      }),
    );
    expect(lexicalIds(database, 'context_document_fts', 'Accepted')).toEqual([
      dailyId,
    ]);
    database.close();
  });

  it('rejects a revision below the maximum without replacing search state', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const eventId = created.eventId;
    const secondId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        documentKey: 'hourly-monotonic',
        eventIds: [eventId],
        revision: 2,
        summary: 'Revision two remains searchable.',
      }),
    );

    expect(() =>
      contextStore.activateDocumentRevision(
        documentInput({
          ...sourceJobInput(database),
          createdAt: 2_000,
          documentKey: 'hourly-monotonic',
          embedding: embedding(0.2),
          eventIds: [eventId],
          revision: 1,
          summary: 'Revision one must not replace it.',
        }),
      ),
    ).toThrow('context document revision must increase');
    expect(
      database
        .prepare(
          `select id, revision, state from context_documents
           where document_key = 'hourly-monotonic'`,
        )
        .all(),
    ).toEqual([{ id: secondId, revision: 2, state: 'active' }]);
    expect(lexicalIds(database, 'context_document_fts', 'remains')).toEqual([
      secondId,
    ]);
    expect(lexicalIds(database, 'context_document_fts', 'replace')).toEqual([]);
    expect(
      database
        .prepare('select document_id from context_document_vectors')
        .pluck()
        .all(),
    ).toContain(secondId);
    database.close();
  });
});
