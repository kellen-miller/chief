import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ContextBackfillService } from '../../src/context/context-backfill.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID,
  CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID,
  CONTEXT_BACKFILL_MIGRATION_ID,
  migrateChiefDatabase,
  openChiefDatabase,
  verifyContextDatabaseSchema,
} from '../../src/memory/database.js';
import { backupChiefDatabase } from '../../src/memory/backup.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { SqliteUsageLedger } from '../../src/usage/sqlite-usage-ledger.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Chief database', () => {
  it('takes a pre-migration backup without changing the source schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-pre-migration-'));
    directories.push(directory);
    const source = join(directory, 'chief.db');
    const database = openChiefDatabase(source);
    database.exec('create table legacy_marker (value text not null)');
    database.prepare('insert into legacy_marker values (?)').run('original');
    database.close();

    const backup = await backupChiefDatabase(
      source,
      join(directory, 'backups'),
    );
    const reopenedSource = openChiefDatabase(source);
    const copied = openChiefDatabase(backup);

    expect(
      reopenedSource
        .prepare(
          "select count(*) from sqlite_master where name = 'schema_migrations'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      copied.prepare('select value from legacy_marker').pluck().get(),
    ).toBe('original');
    reopenedSource.close();
    copied.close();
  });

  it('loads sqlite-vec and migrates idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-database-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));

    migrateChiefDatabase(database);
    migrateChiefDatabase(database);

    const version = database
      .prepare('select vec_version() as version')
      .get() as {
      version: string;
    };
    expect(version.version).toBe('v0.1.9');
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(
      database
        .prepare('select id from schema_migrations order by id')
        .pluck()
        .all(),
    ).toEqual([
      '0001_initial',
      '0002_conversation_events',
      '0003_channel_context',
      '0004_discord_source_lifecycle',
      '0005_context_forgetting',
      '0006_context_backfill',
      '0007_context_backfill_accounting',
      '0008_context_backfill_lifecycle',
      '0009_context_backfill_targeting',
    ]);
    expect(verifyContextDatabaseSchema(database)).toBe(true);
    database.close();
  });

  it('guards populated 0006 backfill work during accounting upgrade', async () => {
    const database = openChiefDatabase(':memory:');
    const now = Date.UTC(2026, 6, 14, 12);
    migrateChiefDatabase(database, CONTEXT_BACKFILL_MIGRATION_ID);
    const runId = Number(
      database
        .prepare(
          `insert into context_backfills
             (run_key, scope_id, status, maximum_usage_usd, created_at,
              updated_at, activated_at, next_page_index)
           values ('legacy-active', 'guild/channel', 'active', 0.1, ?, ?, ?,
                   null)`,
        )
        .run(now, now, now).lastInsertRowid,
    );
    insertLegacyBackfillSegment(database, runId);
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('legacy-context-reservation', 'context-rollup', 'indexing',
                 'background', 0.05, null, ?, ?, null, null)`,
      )
      .run(now, Date.UTC(2026, 6, 1));
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline)
         values ('legacy-induced-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', 'legacy-checksum', 100,
                 200)`,
      )
      .run();
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at)
         values ('legacy-induced-weekly', 'weekly', 0, 100,
                 'America/New_York', null, 'final', 'legacy-checksum', 100,
                 300, 'legacy-context-reservation', 'leased', ?)`,
      )
      .run(now - 1);

    migrateChiefDatabase(database, CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID);
    expect(
      database
        .prepare('select status from context_backfills where id = ?')
        .pluck()
        .get(runId),
    ).toBe('active');
    expect(
      database
        .prepare(
          `select count(*) from context_jobs where backfill_run_id is null`,
        )
        .pluck()
        .get(),
    ).toBe(2);

    const accountingAppliedAt = Number(
      database
        .prepare('select applied_at from schema_migrations where id = ?')
        .pluck()
        .get(CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID),
    );
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('post-0007-live-reservation', 'context-rollup', 'indexing',
                 'background', 0.02, null, ?, ?, null, null)`,
      )
      .run(accountingAppliedAt + 1, Date.UTC(2026, 6, 1));
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('post-0007-live-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', 'live-checksum', 0, 50,
                 'post-0007-live-reservation', 'leased', ?, null)`,
      )
      .run(now - 1);

    migrateChiefDatabase(database, CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID);
    migrateChiefDatabase(database);

    expect(
      database
        .prepare(
          `select status, pause_reason as pauseReason
           from context_backfills where id = ?`,
        )
        .get(runId),
    ).toEqual({
      pauseReason: 'migration-accounting-resume-required',
      status: 'paused',
    });
    expect(
      database
        .prepare(
          `select job_key as jobKey, backfill_run_id as backfillRunId
           from context_jobs order by job_key`,
        )
        .all(),
    ).toEqual([
      { backfillRunId: runId, jobKey: 'legacy-induced-daily' },
      { backfillRunId: runId, jobKey: 'legacy-induced-weekly' },
      { backfillRunId: null, jobKey: 'post-0007-live-daily' },
    ]);
    expect(
      database
        .prepare(
          `select actual_usd as actualUsd,
                  backfill_run_id as backfillRunId
           from usage_ledger where id = 'legacy-context-reservation'`,
        )
        .get(),
    ).toEqual({ actualUsd: null, backfillRunId: runId });

    const context = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => now,
        warningUsd: 5,
      }),
      channelId: 'channel',
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      guildId: 'guild',
      now: () => now,
      summarizer: {
        summarize: () => {
          throw new Error('empty legacy job must not call the provider');
        },
      },
      timeZone: 'America/New_York',
    });
    expect(context.nextDeadline(now)).not.toBeNull();
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    expect(
      database
        .prepare(
          `select actual_usd as actualUsd,
                  backfill_run_id as backfillRunId
           from usage_ledger where id = 'post-0007-live-reservation'`,
        )
        .get(),
    ).toEqual({ actualUsd: 0.02, backfillRunId: null });

    const backfill = new ContextBackfillService({
      channelId: 'channel',
      database,
      guildId: 'guild',
      now: () => now,
      pricing: {
        embeddingInputPerMillionUsd: 0,
        summaryInputPerMillionUsd: 0,
        summaryOutputPerMillionUsd: 0,
      },
    });
    await expect(backfill.resume(runId)).resolves.toMatchObject({
      pauseReason: null,
      status: 'active',
    });
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    await expect(backfill.runNext(now)).resolves.toEqual({
      runId,
      status: 'completed',
    });
    expect(
      database
        .prepare(
          `select actual_usage_usd as actualUsageUsd, status
           from context_backfills where id = ?`,
        )
        .get(runId),
    ).toEqual({ actualUsageUsd: 0.05, status: 'completed' });
    database.close();
  });

  it('reopens a run falsely completed between 0007 and 0008', async () => {
    const database = openChiefDatabase(':memory:');
    const now = Date.UTC(2026, 6, 14, 12);
    migrateChiefDatabase(database, CONTEXT_BACKFILL_MIGRATION_ID);
    const runId = Number(
      database
        .prepare(
          `insert into context_backfills
             (run_key, scope_id, status, maximum_usage_usd, created_at,
              updated_at, activated_at, next_page_index)
           values ('deployment-interval', 'guild/channel', 'active', 0.1,
                   ?, ?, ?, null)`,
        )
        .run(now, now, now).lastInsertRowid,
    );
    insertLegacyBackfillSegment(database, runId);
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('deployment-interval-reservation', 'context-rollup',
                 'indexing', 'background', 0.03, null, ?, ?, null, null)`,
      )
      .run(now, Date.UTC(2026, 6, 1));
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at)
         values ('deployment-interval-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', 'legacy-checksum', 100,
                 200, 'deployment-interval-reservation', 'leased', ?)`,
      )
      .run(now - 1);
    migrateChiefDatabase(database, CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID);
    database
      .prepare(
        `update context_backfills
         set status = 'completed', completed_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(now + 1, now + 1, runId);
    migrateChiefDatabase(database, CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID);

    migrateChiefDatabase(database);

    expect(
      database
        .prepare(
          `select completed_at as completedAt, pause_reason as pauseReason,
                  status
           from context_backfills where id = ?`,
        )
        .get(runId),
    ).toEqual({
      completedAt: null,
      pauseReason: 'migration-accounting-resume-required',
      status: 'paused',
    });
    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'deployment-interval-daily'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    expect(
      database
        .prepare(
          `select backfill_run_id from usage_ledger
           where id = 'deployment-interval-reservation'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);

    const backfill = new ContextBackfillService({
      channelId: 'channel',
      database,
      guildId: 'guild',
      now: () => now,
      pricing: {
        embeddingInputPerMillionUsd: 0,
        summaryInputPerMillionUsd: 0,
        summaryOutputPerMillionUsd: 0,
      },
    });
    await backfill.resume(runId);
    const context = new ChannelContextService({
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => now,
        warningUsd: 5,
      }),
      channelId: 'channel',
      conversation: new ConversationStore(database),
      database,
      embed: () =>
        Promise.resolve({ embedding: new Float32Array(1536), usageUsd: 0 }),
      guildId: 'guild',
      now: () => now,
      summarizer: {
        summarize: () => {
          throw new Error('empty legacy job must not call the provider');
        },
      },
      timeZone: 'America/New_York',
    });
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    await expect(backfill.runNext(now)).resolves.toEqual({
      runId,
      status: 'completed',
    });
    expect(
      database
        .prepare(`select actual_usage_usd from context_backfills where id = ?`)
        .pluck()
        .get(runId),
    ).toBe(0.03);
    database.close();
  });

  it('supports contentless FTS delete semantics at startup', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);

    for (const table of ['conversation_event_fts', 'context_document_fts']) {
      database
        .prepare(`insert into ${table} (rowid, content) values (1, 'visible')`)
        .run();
      database.prepare(`delete from ${table} where rowid = 1`).run();
      expect(
        database.prepare(`select count(*) from ${table}`).pluck().get(),
      ).toBe(0);
    }
    database.close();
  });

  it('migrates production-shaped data without loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-upgrade-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));
    database.exec(
      await readFile(
        new URL('../fixtures/production-0002.sql', import.meta.url),
        'utf8',
      ),
    );
    database
      .prepare(
        'insert into memory_vectors (memory_id, embedding) values (?, ?)',
      )
      .run(1n, JSON.stringify(Array.from(embedding(0.25))));

    expect(
      new SqliteMemoryStore(database).retrieve({
        embedding: embedding(0.25),
        limit: 5,
        now: 200,
        text: 'Project Marigold',
      })[0]?.canonicalText,
    ).toBe('Project Marigold launches Friday');

    migrateChiefDatabase(database);

    expect(
      database.prepare('select count(*) from source_events').pluck().get(),
    ).toBe(1);
    expect(
      database.prepare('select count(*) from memory_jobs').pluck().get(),
    ).toBe(1);
    expect(
      database.prepare('select count(*) from usage_ledger').pluck().get(),
    ).toBe(1);
    expect(
      database
        .prepare(
          `select work_category as workCategory, priority
           from usage_ledger where id = 'usage-pending'`,
        )
        .get(),
    ).toEqual({ priority: 'background', workCategory: 'memory' });
    expect(
      database
        .prepare(
          `select recent_until as recentUntil, guild_id as guildId,
                  channel_id as channelId,
                  discord_message_id as discordMessageId,
                  attachment_metadata_json as attachmentMetadataJson,
                  content_state as contentState,
                  content_state_reason as contentStateReason,
                  response_chunk_index as responseChunkIndex
           from conversation_events where id = 1`,
        )
        .get(),
    ).toEqual({
      attachmentMetadataJson: '[]',
      channelId: '',
      contentState: 'available',
      contentStateReason: 'retained',
      discordMessageId: 'discord:text:1280000000000000001',
      guildId: '',
      recentUntil: 700,
      responseChunkIndex: null,
    });
    expect(
      new SqliteMemoryStore(database).retrieve({
        embedding: embedding(0.25),
        limit: 5,
        now: 200,
        text: 'Project Marigold',
      })[0]?.canonicalText,
    ).toBe('Project Marigold launches Friday');
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(1);
    for (const table of [
      'conversation_event_fts',
      'context_document_fts',
      'context_document_vectors',
    ]) {
      expect(
        database.prepare(`select count(*) from ${table}`).pluck().get(),
      ).toBe(0);
    }
    database.close();
  });

  it('retains copied memory provenance after raw source deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-retention-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));
    migrateChiefDatabase(database);

    database
      .prepare(
        `insert into source_events
           (id, platform_source_id, speaker_id, medium, content, occurred_at, retention_deadline)
         values (1, 'message-1', 'president-1', 'text', 'Meet at noon', 1, 2)`,
      )
      .run();
    database
      .prepare(
        `insert into memories
           (id, source_event_id, canonical_text, kind, confidence, provenance_json, state, created_at, updated_at)
         values (1, 1, 'The group meets at noon', 'plan', 0.9,
                 '{"platformSourceId":"message-1"}', 'active', 1, 1)`,
      )
      .run();

    database.prepare('delete from source_events where id = 1').run();

    expect(
      database
        .prepare(
          'select source_event_id, provenance_json from memories where id = 1',
        )
        .get(),
    ).toEqual({
      provenance_json: '{"platformSourceId":"message-1"}',
      source_event_id: null,
    });
    database.close();
  });
});

function embedding(value: number): Float32Array {
  const result = new Float32Array(1536);
  result[0] = value;
  return result;
}

function insertLegacyBackfillSegment(
  database: ReturnType<typeof openChiefDatabase>,
  runId: number,
): void {
  database
    .prepare(
      `insert into context_backfill_pages
         (run_id, page_index, request_before_source_id, oldest_source_id,
          newest_source_id, eligible_count, eligible_bytes, eligible_tokens,
          identity_checksum, completed_at)
       values (?, 0, null, '100', '200', 1, 8, 2, 'legacy-page', 100)`,
    )
    .run(runId);
  const documentId = Number(
    database
      .prepare(
        `insert into context_documents
           (document_key, tier, period_start, period_end, timezone, topic_key,
            revision, completeness, state, content_state,
            content_state_reason, summary, confidence, retention_deadline,
            created_at, updated_at, generation_input_tokens,
            generation_output_tokens, generation_usage_usd, is_internal)
         values ('legacy-segment', 'hourly', 10, 20, 'America/New_York', null,
                 1, 'final', 'active', 'available', 'retained',
                 'Legacy segment summary.', 0.9, null, 100, 100, 1, 1, 0,
                 1)`,
      )
      .run().lastInsertRowid,
  );
  database
    .prepare(
      `insert into context_backfill_segments
         (run_id, segment_key, page_index, period_start, period_end,
          source_checksum, source_count, document_id, actual_usage_usd,
          committed_at)
       values (?, 'legacy-segment', 0, 10, 20, 'legacy-source', 1, ?, 0,
               100)`,
    )
    .run(runId, documentId);
}
