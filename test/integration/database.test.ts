import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { repairLegacyData } from '../../scripts/repair-legacy-data.js';

import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ContextBackfillService } from '../../src/context/context-backfill.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
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

async function upgradeLegacyDatabase(
  database: Database.Database,
  throughMigrationId?: string,
): Promise<void> {
  const hasHistory = database
    .prepare("select 1 from sqlite_master where name = 'schema_migrations'")
    .get();
  const previouslyApplied = new Set(
    hasHistory
      ? (database
          .prepare('select id from schema_migrations')
          .pluck()
          .all() as string[])
      : [],
  );
  await migrateChiefDatabase(database, throughMigrationId);
  repairLegacyData(database, previouslyApplied);
}

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

    await migrateChiefDatabase(database, '0012_context_accounting_origin');
    const priorMigrations = database
      .prepare('select id, checksum from schema_migrations order by id')
      .all();
    expect(verifyContextDatabaseSchema(database)).toBe(false);
    await migrateChiefDatabase(database);
    await migrateChiefDatabase(database);

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
      '0010_context_backfill_ownership',
      '0011_usage_reservation_origin',
      '0012_context_accounting_origin',
      '0013_legacy_source_scope',
      '0014_monitoring_alerts',
    ]);
    expect(
      database
        .prepare(
          "select id, checksum from schema_migrations where id not in ('0013_legacy_source_scope', '0014_monitoring_alerts') order by id",
        )
        .all(),
    ).toEqual(priorMigrations);
    expect(verifyContextDatabaseSchema(database)).toBe(true);
    database.close();
  });

  it('adopts legacy history without replaying migrations', async () => {
    const database = openChiefDatabase(':memory:');
    await migrateChiefDatabase(database, '0012_context_accounting_origin');
    const legacyHistory = database
      .prepare('select * from schema_migrations order by id')
      .all();
    database.exec(
      'drop table knex_migrations; drop table knex_migrations_lock',
    );

    await migrateChiefDatabase(database);
    await migrateChiefDatabase(database, '0002_conversation_events');

    expect(
      database
        .prepare('select * from schema_migrations where id <= ? order by id')
        .all('0012_context_accounting_origin'),
    ).toEqual(legacyHistory);
    expect(
      database
        .prepare('select name from knex_migrations order by name')
        .pluck()
        .all(),
    ).toEqual(
      database
        .prepare('select id from schema_migrations order by id')
        .pluck()
        .all(),
    );
    expect(verifyContextDatabaseSchema(database)).toBe(true);
    database.close();
  });

  it('rolls back failed migrations and releases the Knex lock', async () => {
    const database = openChiefDatabase(':memory:');
    await migrateChiefDatabase(database, '0013_legacy_source_scope');
    database.exec('create view monitoring_alerts as select 1 as id');

    await expect(migrateChiefDatabase(database)).rejects.toThrow();

    expect(
      database
        .prepare(
          "select id from schema_migrations where id = '0014_monitoring_alerts'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "select name from knex_migrations where name = '0014_monitoring_alerts'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare('select is_locked from knex_migrations_lock')
        .pluck()
        .get(),
    ).toBe(0);
    expect(database.inTransaction).toBe(false);
    database.exec('drop view monitoring_alerts');
    await migrateChiefDatabase(database);
    expect(verifyContextDatabaseSchema(database)).toBe(true);
    database.close();
  });

  it('rejects changed checksums, missing history and unknown targets', async () => {
    const database = openChiefDatabase(':memory:');
    await migrateChiefDatabase(database, '0002_conversation_events');
    database.exec(
      "update schema_migrations set checksum = 'changed' where id = '0001_initial'",
    );
    await expect(migrateChiefDatabase(database)).rejects.toThrow(
      'migration checksum mismatch for 0001_initial',
    );
    database.exec("delete from schema_migrations where id = '0001_initial'");
    await expect(migrateChiefDatabase(database)).rejects.toThrow(
      'invalid recorded migration history',
    );
    await expect(migrateChiefDatabase(database, 'unknown')).rejects.toThrow(
      'unknown migration target',
    );
    database.close();
  });

  it('rejects Knex records missing their checksum history', async () => {
    const database = openChiefDatabase(':memory:');
    await migrateChiefDatabase(database);
    database.exec(
      "delete from schema_migrations where id = '0014_monitoring_alerts'",
    );
    await expect(migrateChiefDatabase(database)).rejects.toThrow(
      'Knex migration history disagrees with recorded checksums',
    );
    database.close();
  });

  it('keeps legacy repairs out of migrations and runs them explicitly from a backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-manual-repair-'));
    directories.push(directory);
    const databasePath = join(directory, 'chief.db');
    const beforePath = join(directory, 'before.db');
    const afterPath = join(directory, 'after.db');
    const database = openChiefDatabase(databasePath);
    await migrateChiefDatabase(database, '0006_context_backfill');
    const runId = insertMigrationBackfillRun(database, {
      now: 1_000,
      runKey: 'manual-repair',
    });
    await database.backup(beforePath);
    const beforeBytes = await readFile(beforePath);

    await migrateChiefDatabase(database);
    expect(
      database
        .prepare('select status from context_backfills where id = ?')
        .pluck()
        .get(runId),
    ).toBe('active');
    database.close();
    const args = [
      '--import',
      'tsx',
      'scripts/repair-legacy-data.ts',
      '--database',
      databasePath,
      '--before',
      beforePath,
    ];
    const output = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(output).toContain('0008_context_backfill_lifecycle');
    expect(output).toContain('0012_context_accounting_origin');
    expect(await readFile(beforePath)).toEqual(beforeBytes);
    const repaired = openChiefDatabase(databasePath);
    try {
      expect(
        repaired
          .prepare('select status from context_backfills where id = ?')
          .pluck()
          .get(runId),
      ).toBe('paused');
      await repaired.backup(afterPath);
    } finally {
      repaired.close();
    }

    args[args.length - 1] = afterPath;
    expect(
      execFileSync(process.execPath, args, {
        encoding: 'utf8',
        timeout: 20_000,
      }),
    ).toContain('No pending legacy data repairs.');
  });

  it('guards populated 0006 backfill work during accounting upgrade', async () => {
    const database = openChiefDatabase(':memory:');
    const now = Date.UTC(2026, 6, 14, 12);
    await upgradeLegacyDatabase(database, '0006_context_backfill');
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
    const segmentDocumentId = insertLegacyBackfillSegment(database, runId);
    const hourlyDocumentId = insertPublicBackfillDocument(
      database,
      runId,
      segmentDocumentId,
    );
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
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at)
         values ('legacy-induced-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', ?, 100, 200,
                 'legacy-context-reservation', 'leased', ?)`,
      )
      .run(testDigest([{ id: hourlyDocumentId, revision: 1 }]), now - 1);

    await upgradeLegacyDatabase(database, '0007_context_backfill_accounting');
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
    ).toBe(1);

    const accountingAppliedAt = Number(
      database
        .prepare('select applied_at from schema_migrations where id = ?')
        .pluck()
        .get('0007_context_backfill_accounting'),
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

    await upgradeLegacyDatabase(database, '0008_context_backfill_lifecycle');
    await upgradeLegacyDatabase(database, '0011_usage_reservation_origin');

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
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: input.sources.map(({ id }) => id),
            summary: 'Migration-owned context.',
            topicProposals: [],
            usageUsd: 0,
          }),
      },
      timeZone: 'America/New_York',
    });
    expect(context.nextDeadline(now)).not.toBeNull();
    await expect(context.runNext(now)).resolves.toMatchObject({
      status: 'completed',
      tier: 'daily',
    });
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
    await expect(context.runNext(now)).resolves.toMatchObject({
      status: 'completed',
      tier: 'daily',
    });
    await expect(context.runNext(now)).resolves.toMatchObject({
      status: 'completed',
      tier: 'weekly',
    });
    expect(
      database
        .prepare(
          `select job_key as jobKey, status from context_jobs
           where backfill_run_id = ? and status in ('pending', 'leased')`,
        )
        .all(runId),
    ).toEqual([]);
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
    await upgradeLegacyDatabase(database, '0006_context_backfill');
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
    const segmentDocumentId = insertLegacyBackfillSegment(database, runId);
    const hourlyDocumentId = insertPublicBackfillDocument(
      database,
      runId,
      segmentDocumentId,
    );
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
                 'America/New_York', null, 'final', ?, 100, 200,
                 'deployment-interval-reservation', 'leased', ?)`,
      )
      .run(testDigest([{ id: hourlyDocumentId, revision: 1 }]), now - 1);
    await upgradeLegacyDatabase(database, '0007_context_backfill_accounting');
    database
      .prepare(
        `update context_backfills
         set status = 'completed', completed_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(now + 1, now + 1, runId);
    await upgradeLegacyDatabase(database, '0008_context_backfill_lifecycle');

    await upgradeLegacyDatabase(database, '0011_usage_reservation_origin');

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
        summarize: (input) =>
          Promise.resolve({
            confidence: 0.9,
            inputTokens: 1,
            outputTokens: 1,
            sourceIds: input.sources.map(({ id }) => id),
            summary: 'Recovered migration context.',
            topicProposals: [],
            usageUsd: 0,
          }),
      },
      timeZone: 'America/New_York',
    });
    await expect(context.runNext(now)).resolves.toMatchObject({
      status: 'completed',
      tier: 'daily',
    });
    await expect(backfill.runNext(now)).resolves.toEqual({ status: 'idle' });
    await expect(context.runNext(now)).resolves.toMatchObject({
      status: 'completed',
      tier: 'weekly',
    });
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

  it('preserves exact post-0007 backfill ownership and run drain', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0006_context_backfill');
    const runId = insertMigrationBackfillRun(database, {
      maximumUsageUsd: 0.02,
      now,
      runKey: 'post-accounting-owned',
    });
    const segmentDocumentId = insertLegacyBackfillSegment(database, runId);
    const sourceDocumentId = insertPublicBackfillDocument(
      database,
      runId,
      segmentDocumentId,
    );
    await upgradeLegacyDatabase(database, '0007_context_backfill_accounting');
    const accountingAppliedAt = Number(
      database
        .prepare('select applied_at from schema_migrations where id = ?')
        .pluck()
        .get('0007_context_backfill_accounting'),
    );
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('post-accounting-owned-reservation', 'context-rollup',
                 'indexing', 'background', 0.02, null, ?, 0, ?, null)`,
      )
      .run(accountingAppliedAt + 1, runId);
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('post-accounting-owned-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', ?, 100, 200,
                 'post-accounting-owned-reservation', 'leased', ?, ?)`,
      )
      .run(testDigest([{ id: sourceDocumentId, revision: 1 }]), now + 1, runId);

    await upgradeLegacyDatabase(database, '0008_context_backfill_lifecycle');
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    await upgradeLegacyDatabase(database, '0011_usage_reservation_origin');

    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'post-accounting-owned-daily'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    expect(
      database
        .prepare(
          `select backfill_run_id from usage_ledger
           where id = 'post-accounting-owned-reservation'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    expect(
      database
        .prepare(`select maximum_usage_usd from context_backfills where id = ?`)
        .pluck()
        .get(runId),
    ).toBe(0.02);
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
    await expect(backfill.runNext(now)).resolves.toEqual({ status: 'idle' });
    const context = new ChannelContextService({
      backfillPricing: {
        embeddingInputPerMillionUsd: 0,
        summaryInputPerMillionUsd: 0,
        summaryOutputPerMillionUsd: 0,
      },
      budget: new UsageBudget({
        ceilingUsd: 10,
        indexingCeilingUsd: 3,
        ledger: new SqliteUsageLedger(database),
        now: () => now + 2,
        warningUsd: 5,
      }),
      channelId: 'channel',
      conversation: new ConversationStore(database),
      database,
      embed: () => {
        throw new Error('run ceiling must prevent provider work');
      },
      estimateUsd: 0.01,
      guildId: 'guild',
      now: () => now + 2,
      summarizer: {
        summarize: () => {
          throw new Error('run ceiling must prevent provider work');
        },
      },
      timeZone: 'America/New_York',
    });
    await expect(context.runNext(now + 2)).resolves.toMatchObject({
      reason: 'run-budget',
      status: 'budget-deferred',
    });
    expect(
      database
        .prepare(
          `select actual_usage_usd as actualUsageUsd,
                  pause_reason as pauseReason, status
           from context_backfills where id = ?`,
        )
        .get(runId),
    ).toEqual({
      actualUsageUsd: 0.02,
      pauseReason: 'run-budget',
      status: 'paused',
    });
    database.close();
  });

  it('preserves legacy id-ordered ownership with mixed hourly inputs', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'id-ordered-inputs',
    });
    const segmentDocumentId = insertLegacyBackfillSegment(database, runId);
    const backfillDocumentId = insertPublicContextDocument(database, {
      documentKey: 'id-first-backfill-hourly',
      parentDocumentId: segmentDocumentId,
      periodEnd: 90,
      periodStart: 80,
      tier: 'hourly',
    });
    const liveDocumentId = insertPublicContextDocument(database, {
      documentKey: 'id-second-live-hourly',
      parentDocumentId: null,
      periodEnd: 20,
      periodStart: 10,
      tier: 'hourly',
    });
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('id-ordered-reservation', 'context-rollup', 'indexing',
                 'background', 0.02, null, ?, 0, ?, null)`,
      )
      .run(now, runId);
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('id-ordered-daily', 'daily', 0, 100, 'America/New_York',
                 null, 'final', ?, 0, 100, 'id-ordered-reservation', 'leased',
                 ?, ?)`,
      )
      .run(
        testDigest([
          { id: backfillDocumentId, revision: 1 },
          { id: liveDocumentId, revision: 1 },
        ]),
        now + 1,
        runId,
      );

    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'id-ordered-daily'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    expect(
      database
        .prepare(
          `select backfill_run_id from usage_ledger
           where id = 'id-ordered-reservation'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    database.close();
  });

  it('fails closed for an ambiguous detached reservation', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'detached-live-reservation',
    });
    database
      .prepare(
        `update context_backfills
         set status = 'paused', pause_reason = 'run-budget' where id = ?`,
      )
      .run(runId);
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('detached-live-reservation', 'context-rollup', 'indexing',
                 'background', 0.02, null, ?, 0, ?, null)`,
      )
      .run(now, runId);
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('detached-live-hourly', 'hourly', 1000, 2000,
                 'America/New_York', null, 'final', ?, 0, 50,
                 'detached-live-reservation', 'leased', ?, null)`,
      )
      .run(testDigest([]), now - 1);

    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'detached-live-hourly'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
    expect(
      database
        .prepare(
          `select backfill_run_id from usage_ledger
           where id = 'detached-live-reservation'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    const context = emptyMigrationContext(database, now);
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    expect(
      database
        .prepare(`select actual_usage_usd from context_backfills where id = ?`)
        .pluck()
        .get(runId),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select last_error_category as lastErrorCategory, status
           from context_jobs where job_key = 'detached-live-hourly'`,
        )
        .get(),
    ).toEqual({
      lastErrorCategory: 'migration-accounting-ambiguous',
      status: 'failed',
    });
    database.close();
  });

  it('returns an originally live stolen reservation to live accounting', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0011_usage_reservation_origin');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'stolen-live-origin',
    });
    const reservation = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    }).reserve('context-rollup', 0.02, {
      priority: 'background',
      workCategory: 'indexing',
    });
    if (!reservation.allowed) throw new Error('live reservation was denied');
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('stolen-live-hourly', 'hourly', 1000, 2000,
                 'America/New_York', null, 'final', ?, 0, 50, ?, 'leased',
                 ?, null)`,
      )
      .run(testDigest([]), reservation.id, now - 1);

    // Reproduce 0008's mutable-owner theft after origin was recorded.
    database
      .prepare(
        `update context_jobs set backfill_run_id = ?
         where job_key = 'stolen-live-hourly'`,
      )
      .run(runId);
    database
      .prepare(`update usage_ledger set backfill_run_id = ? where id = ?`)
      .run(runId, reservation.id);

    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id as backfillRunId,
                  origin_backfill_run_id as originBackfillRunId,
                  reservation_origin as reservationOrigin
           from usage_ledger where id = ?`,
        )
        .get(reservation.id),
    ).toEqual({
      backfillRunId: null,
      originBackfillRunId: null,
      reservationOrigin: 'live',
    });
    expect(() =>
      database
        .prepare(
          `update usage_ledger set reservation_origin = 'ambiguous'
           where id = ?`,
        )
        .run(reservation.id),
    ).toThrow('usage reservation origin is immutable');
    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'stolen-live-hourly'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
    const context = emptyMigrationContext(database, now);
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    expect(
      database
        .prepare(`select actual_usd from usage_ledger where id = ?`)
        .pluck()
        .get(reservation.id),
    ).toBe(0.02);
    expect(
      database
        .prepare(`select actual_usage_usd from context_backfills where id = ?`)
        .pluck()
        .get(runId),
    ).toBe(0);
    database.close();
  });

  it('retains an originally backfill detached reservation owner', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0011_usage_reservation_origin');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'detached-backfill-origin',
    });
    const reservation = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    }).reserve('context-rollup', 0.02, {
      backfillRunId: runId,
      priority: 'background',
      workCategory: 'indexing',
    });
    if (!reservation.allowed) {
      throw new Error('backfill reservation was denied');
    }
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('detached-backfill-hourly', 'hourly', 1000, 2000,
                 'America/New_York', null, 'final', ?, 0, 50, ?, 'leased',
                 ?, null)`,
      )
      .run(testDigest([]), reservation.id, now - 1);

    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id as backfillRunId,
                  origin_backfill_run_id as originBackfillRunId,
                  reservation_origin as reservationOrigin
           from usage_ledger where id = ?`,
        )
        .get(reservation.id),
    ).toEqual({
      backfillRunId: runId,
      originBackfillRunId: runId,
      reservationOrigin: 'backfill',
    });
    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'detached-backfill-hourly'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
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
    expect(backfill.status(runId)).toMatchObject({
      pauseReason: 'migration-accounting-resume-required',
      status: 'paused',
    });
    await expect(backfill.resume(runId)).resolves.toMatchObject({
      pauseReason: null,
      status: 'active',
    });
    await expect(backfill.runNext(now)).resolves.toEqual({ status: 'idle' });
    const context = emptyMigrationContext(database, now);
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    expect(
      database
        .prepare(`select actual_usage_usd from context_backfills where id = ?`)
        .pluck()
        .get(runId),
    ).toBe(0.02);
    await expect(backfill.runNext(now)).resolves.toEqual({
      runId,
      status: 'completed',
    });
    database.close();
  });

  it('fails closed when reservation origin is truly ambiguous', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0010_context_backfill_ownership');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'ambiguous-accounting',
    });
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('ambiguous-reservation', 'context-rollup', 'indexing',
                 'background', 0.02, null, ?, 0, ?, null)`,
      )
      .run(now, runId);
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at, backfill_run_id)
         values ('ambiguous-hourly', 'hourly', 1000, 2000,
                 'America/New_York', null, 'final', ?, 0, 50,
                 'ambiguous-reservation', 'leased', ?, ?)`,
      )
      .run(testDigest([]), now - 1, runId);

    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select actual_usd as actualUsd,
                  backfill_run_id as backfillRunId,
                  reservation_origin as reservationOrigin
           from usage_ledger where id = 'ambiguous-reservation'`,
        )
        .get(),
    ).toEqual({
      actualUsd: null,
      backfillRunId: runId,
      reservationOrigin: 'ambiguous',
    });
    expect(
      database
        .prepare(
          `select last_error_category as lastErrorCategory, status
           from context_jobs where job_key = 'ambiguous-hourly'`,
        )
        .get(),
    ).toEqual({
      lastErrorCategory: 'migration-accounting-ambiguous',
      status: 'failed',
    });
    expect(
      database
        .prepare(
          `select actual_usage_usd as actualUsageUsd,
                  pause_reason as pauseReason, status
           from context_backfills where id = ?`,
        )
        .get(runId),
    ).toEqual({
      actualUsageUsd: 0,
      pauseReason: 'migration-accounting-rebuild-required',
      status: 'failed',
    });
    expect(
      database
        .prepare(
          `select reason, reservation_id as reservationId
           from context_accounting_holds where job_id = (
             select id from context_jobs where job_key = 'ambiguous-hourly'
           )`,
        )
        .get(),
    ).toEqual({
      reason: 'migration-accounting-ambiguous',
      reservationId: 'ambiguous-reservation',
    });
    const accounting = new UsageBudget({
      ceilingUsd: 10,
      indexingCeilingUsd: 3,
      ledger: new SqliteUsageLedger(database),
      now: () => now,
      warningUsd: 5,
    });
    expect(() => {
      accounting.reconcileConservatively('ambiguous-reservation');
    }).toThrow('usage reservation is held for accounting rebuild');
    expect(accounting.snapshot().reservedUsd).toBe(0.02);
    expect(
      database
        .prepare(
          `select actual_usd as actualUsd,
                  (select actual_usage_usd from context_backfills where id = ?)
                    as runActualUsd,
                  (select count(*) from context_accounting_holds
                   where reservation_id = usage_ledger.id) as holdCount
           from usage_ledger where id = 'ambiguous-reservation'`,
        )
        .get(runId),
    ).toEqual({ actualUsd: null, holdCount: 1, runActualUsd: 0 });
    const context = emptyMigrationContext(database, now);
    expect(context.nextDeadline(now)).toBeNull();
    expect(context.status(now)).toMatchObject({
      degraded: true,
      failedJobs: 1,
      reason: 'migration-accounting-ambiguous',
    });
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
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
    await expect(backfill.resume(runId)).rejects.toThrow(
      'backfill accounting is ambiguous; rebuild required before resume',
    );
    database
      .prepare(
        `update context_jobs
         set status = 'pending', last_error_category = null
         where job_key = 'ambiguous-hourly'`,
      )
      .run();
    expect(context.nextDeadline(now)).toBeNull();
    expect(context.status(now)).toMatchObject({
      degraded: true,
      reason: 'migration-accounting-ambiguous',
    });
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    expect(
      database
        .prepare(
          `select actual_usd from usage_ledger
           where id = 'ambiguous-reservation'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
    database.close();
  });

  it('does not reopen an intentionally replaced exact owner', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'intentional-replacement',
    });
    const segmentDocumentId = insertLegacyBackfillSegment(database, runId);
    const sourceDocumentId = insertPublicBackfillDocument(
      database,
      runId,
      segmentDocumentId,
    );
    database
      .prepare(
        `update context_backfills
         set status = 'failed', pause_reason = 'replaced' where id = ?`,
      )
      .run(runId);
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, backfill_run_id)
         values ('replaced-owner-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', ?, 0, 100, ?)`,
      )
      .run(testDigest([{ id: sourceDocumentId, revision: 1 }]), runId);

    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select status, pause_reason as pauseReason
           from context_backfills where id = ?`,
        )
        .get(runId),
    ).toEqual({ pauseReason: 'replaced', status: 'failed' });
    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'replaced-owner-daily'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    database.close();
  });

  it('recovers a pre-0007 recent-only hourly manifest job', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0006_context_backfill');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'recent-only',
    });
    insertLegacyBackfillPage(database, runId);
    const recent = insertRecentManifestSource(database, {
      messageId: '150',
      occurredAt: 10,
    });
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline)
         values ('recent-only-hourly', 'hourly', 0, 100,
                 'America/New_York', null, 'final', ?, 100, 200)`,
      )
      .run(recent.checksum);

    await upgradeLegacyDatabase(database, '0007_context_backfill_accounting');
    await upgradeLegacyDatabase(database, '0008_context_backfill_lifecycle');
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'recent-only-hourly'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
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
    database.close();
  });

  it('detaches an unreserved live daily job sharing a legacy period', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0006_context_backfill');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'shared-period-live',
    });
    insertLegacyBackfillSegment(database, runId);
    const liveDocumentId = insertPublicBackfillDocument(database, runId, null);
    await upgradeLegacyDatabase(database, '0007_context_backfill_accounting');
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline)
         values ('shared-period-live-daily', 'daily', 0, 100,
                 'America/New_York', null, 'final', ?, 0, 50)`,
      )
      .run(testDigest([{ id: liveDocumentId, revision: 1 }]));

    await upgradeLegacyDatabase(database, '0008_context_backfill_lifecycle');
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'shared-period-live-daily'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
    const context = emptyMigrationContext(database, now);
    expect(context.nextDeadline(now)).not.toBeNull();
    await expect(context.runNext(now)).resolves.toMatchObject({
      status: 'completed',
      tier: 'daily',
    });
    expect(
      database
        .prepare(
          `select status from context_jobs
           where job_key = 'shared-period-live-daily'`,
        )
        .pluck()
        .get(),
    ).toBe('completed');
    database.close();
  });

  it('freezes ambiguous stolen work after a pause reason change', async () => {
    const database = openChiefDatabase(':memory:');
    const now = 1_000;
    await upgradeLegacyDatabase(database, '0006_context_backfill');
    const runId = insertMigrationBackfillRun(database, {
      now,
      runKey: 'changed-pause-reason',
    });
    insertLegacyBackfillPage(database, runId);
    await upgradeLegacyDatabase(database, '0007_context_backfill_accounting');
    const accountingAppliedAt = Number(
      database
        .prepare('select applied_at from schema_migrations where id = ?')
        .pluck()
        .get('0007_context_backfill_accounting'),
    );
    const wrongScopeSource = insertRecentManifestSource(database, {
      guildId: 'other-guild',
      messageId: '150',
      occurredAt: 1_500,
    });
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values ('changed-pause-live-reservation', 'context-rollup',
                 'indexing', 'background', 0.02, null, ?, 0, null, null)`,
      )
      .run(accountingAppliedAt + 1);
    database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, usage_reservation_id, status,
            lease_expires_at)
         values ('changed-pause-live-hourly', 'hourly', 1000, 2000,
                 'America/New_York', null, 'final', ?, 0, 50,
                 'changed-pause-live-reservation', 'leased', ?)`,
      )
      .run(wrongScopeSource.checksum, now - 1);

    await upgradeLegacyDatabase(database, '0008_context_backfill_lifecycle');
    database
      .prepare(
        `update context_backfills set pause_reason = 'run-budget' where id = ?`,
      )
      .run(runId);
    await upgradeLegacyDatabase(database, '0009_context_backfill_targeting');
    await upgradeLegacyDatabase(database);

    expect(
      database
        .prepare(
          `select backfill_run_id from context_jobs
           where job_key = 'changed-pause-live-hourly'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
    expect(
      database
        .prepare(
          `select backfill_run_id from usage_ledger
           where id = 'changed-pause-live-reservation'`,
        )
        .pluck()
        .get(),
    ).toBe(runId);
    const context = emptyMigrationContext(database, now);
    expect(context.nextDeadline(now)).toBeNull();
    expect(context.status(now)).toMatchObject({
      degraded: true,
      reason: 'migration-accounting-ambiguous',
    });
    await expect(context.runNext(now)).resolves.toEqual({ status: 'idle' });
    expect(
      database
        .prepare(
          `select actual_usd from usage_ledger
           where id = 'changed-pause-live-reservation'`,
        )
        .pluck()
        .get(),
    ).toBeNull();
    expect(
      database
        .prepare(`select actual_usage_usd from context_backfills where id = ?`)
        .pluck()
        .get(runId),
    ).toBe(0);
    database.close();
  });

  it('supports contentless FTS delete semantics at startup', async () => {
    const database = openChiefDatabase(':memory:');
    await migrateChiefDatabase(database);

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

    await migrateChiefDatabase(database);

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
    await migrateChiefDatabase(database);

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

function insertMigrationBackfillRun(
  database: ReturnType<typeof openChiefDatabase>,
  input: {
    readonly maximumUsageUsd?: number;
    readonly now: number;
    readonly runKey: string;
  },
): number {
  return Number(
    database
      .prepare(
        `insert into context_backfills
           (run_key, scope_id, status, maximum_usage_usd, created_at,
            updated_at, activated_at, next_page_index)
         values (?, 'guild/channel', 'active', ?, ?, ?, ?, null)`,
      )
      .run(
        input.runKey,
        input.maximumUsageUsd ?? 1,
        input.now,
        input.now,
        input.now,
      ).lastInsertRowid,
  );
}

function insertLegacyBackfillSegment(
  database: ReturnType<typeof openChiefDatabase>,
  runId: number,
): number {
  insertLegacyBackfillPage(database, runId);
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
  return documentId;
}

function insertLegacyBackfillPage(
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
}

function insertPublicBackfillDocument(
  database: ReturnType<typeof openChiefDatabase>,
  runId: number,
  parentDocumentId: number | null,
  tier: 'daily' | 'hourly' = 'hourly',
): number {
  return insertPublicContextDocument(database, {
    documentKey: `public-${tier}-${runId.toString()}`,
    parentDocumentId,
    periodEnd: 100,
    periodStart: 0,
    tier,
  });
}

function insertPublicContextDocument(
  database: ReturnType<typeof openChiefDatabase>,
  input: {
    readonly documentKey: string;
    readonly parentDocumentId: number | null;
    readonly periodEnd: number;
    readonly periodStart: number;
    readonly tier: 'daily' | 'hourly';
  },
): number {
  const documentId = Number(
    database
      .prepare(
        `insert into context_documents
           (document_key, tier, period_start, period_end, timezone, topic_key,
            revision, completeness, state, content_state,
            content_state_reason, summary, confidence, retention_deadline,
            created_at, updated_at, generation_input_tokens,
            generation_output_tokens, generation_usage_usd, is_internal)
         values (?, ?, ?, ?, 'America/New_York', null, 1, 'final',
                 'active', 'available', 'retained', 'Public descendant.', 0.9,
                 null, 100, 100, 1, 1, 0, 0)`,
      )
      .run(input.documentKey, input.tier, input.periodStart, input.periodEnd)
      .lastInsertRowid,
  );
  if (input.parentDocumentId !== null) {
    database
      .prepare(
        `insert into context_document_parents (document_id, parent_document_id)
         values (?, ?)`,
      )
      .run(documentId, input.parentDocumentId);
  }
  return documentId;
}

function insertRecentManifestSource(
  database: ReturnType<typeof openChiefDatabase>,
  input: {
    readonly channelId?: string;
    readonly guildId?: string;
    readonly messageId: string;
    readonly occurredAt: number;
  },
): { readonly checksum: string; readonly eventId: number } {
  const eventId = new ConversationStore(database).record({
    attachmentMetadataJson: '[]',
    channelId: input.channelId ?? 'channel',
    content: 'Recent manifest source.',
    discordMessageId: input.messageId,
    editedAt: null,
    guildId: input.guildId ?? 'guild',
    logicalResponseId: null,
    medium: 'text',
    occurredAt: input.occurredAt,
    platformEventId: input.messageId,
    recentUntil: input.occurredAt + 1_000,
    replyToMessageId: null,
    requestId: null,
    responseChunkIndex: null,
    retentionDeadline: input.occurredAt + 2_000,
    revisionChecksum: 'recent-revision',
    role: 'human',
    speakerId: 'president',
    speakerName: 'President',
  });
  return {
    checksum: testDigest([
      {
        id: eventId,
        discordMessageId: input.messageId,
        content: 'Recent manifest source.',
        editedAt: null,
      },
    ]),
    eventId,
  };
}

function emptyMigrationContext(
  database: ReturnType<typeof openChiefDatabase>,
  now: number,
): ChannelContextService {
  return new ChannelContextService({
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
      summarize: (input) =>
        Promise.resolve({
          confidence: 0.9,
          inputTokens: 1,
          outputTokens: 1,
          sourceIds: input.sources.map(({ id }) => id),
          summary: 'Live migration repair context.',
          topicProposals: [],
          usageUsd: 0,
        }),
    },
    timeZone: 'America/New_York',
  });
}

function testDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
