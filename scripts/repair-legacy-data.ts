import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import {
  openChiefDatabase,
  verifyRecordedMigrationSet,
} from '../src/memory/database.js';

function guardLegacyBackfillAccounting(database: Database.Database): void {
  const unfinishedRunIds = database
    .prepare(
      `select id from context_backfills
       where status in ('active', 'paused')
       order by id desc`,
    )
    .pluck()
    .all() as number[];
  const guardRunId = unfinishedRunIds[0];
  if (guardRunId === undefined) return;

  const now = Date.now();
  database
    .prepare(
      `update context_backfills
       set status = 'failed',
           pause_reason = 'migration-accounting-rebuild-required',
           updated_at = ?
       where status in ('active', 'paused') and id != ?`,
    )
    .run(now, guardRunId);
  database
    .prepare(
      `update context_backfills
       set status = 'paused',
           pause_reason = 'migration-accounting-resume-required',
           updated_at = ?
       where id = ? and status in ('active', 'paused')`,
    )
    .run(now, guardRunId);
  database
    .prepare(
      `update context_jobs set backfill_run_id = ?
       where backfill_run_id is null and status in ('pending', 'leased')`,
    )
    .run(guardRunId);
  database
    .prepare(
      `update usage_ledger set backfill_run_id = ?
       where actual_usd is null and backfill_run_id is null
         and id in (
           select usage_reservation_id from context_jobs
           where backfill_run_id = ? and usage_reservation_id is not null
         )`,
    )
    .run(guardRunId, guardRunId);
}

interface LegacyContextJobRow {
  readonly backfillRunId: number | null;
  readonly id: number;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly reservationOccurredAt: number | null;
  readonly sourceDocumentIdsJson: string;
  readonly tier: string;
  readonly usageReservationId: string | null;
}

function targetLegacyBackfillAccounting(database: Database.Database): void {
  const accountingAppliedAt = database
    .prepare('select applied_at from schema_migrations where id = ?')
    .pluck()
    .get('0007_context_backfill_accounting') as number;
  const jobs = database
    .prepare(
      `select j.id, j.tier, j.period_start as periodStart,
              j.period_end as periodEnd,
              j.source_document_ids_json as sourceDocumentIdsJson,
              j.usage_reservation_id as usageReservationId,
              j.backfill_run_id as backfillRunId,
              l.occurred_at as reservationOccurredAt
       from context_jobs j
       left join usage_ledger l on l.id = j.usage_reservation_id
       where j.status in ('pending', 'leased')`,
    )
    .all() as LegacyContextJobRow[];
  const recoveredRunIds = new Set<number>();

  for (const job of jobs) {
    const createdAfterAccounting =
      job.reservationOccurredAt !== null &&
      job.reservationOccurredAt > accountingAppliedAt;
    const provableRunIds = createdAfterAccounting
      ? []
      : provableBackfillRunIds(database, job, accountingAppliedAt);
    const targetRunId = provableRunIds[0];
    if (targetRunId !== undefined) {
      database
        .prepare('update context_jobs set backfill_run_id = ? where id = ?')
        .run(targetRunId, job.id);
      if (job.usageReservationId !== null) {
        database
          .prepare(
            `update usage_ledger set backfill_run_id = ?
             where id = ? and actual_usd is null`,
          )
          .run(targetRunId, job.usageReservationId);
      }
      recoveredRunIds.add(targetRunId);
      continue;
    }

    if (
      job.backfillRunId !== null &&
      migrationGuardedRun(database, job.backfillRunId)
    ) {
      if (job.usageReservationId !== null) {
        database
          .prepare(
            `update usage_ledger set backfill_run_id = null
             where id = ? and actual_usd is null
               and backfill_run_id = ?`,
          )
          .run(job.usageReservationId, job.backfillRunId);
      }
      database
        .prepare('update context_jobs set backfill_run_id = null where id = ?')
        .run(job.id);
    }
  }

  const now = Date.now();
  const recover = database.prepare(
    `update context_backfills
     set status = 'paused', completed_at = null,
         pause_reason = 'migration-accounting-resume-required',
         updated_at = ?
     where id = ? and (
       status in ('active', 'paused', 'completed')
       or pause_reason = 'migration-accounting-rebuild-required'
     )`,
  );
  for (const runId of recoveredRunIds) recover.run(now, runId);
}

function provableBackfillRunIds(
  database: Database.Database,
  job: LegacyContextJobRow,
  accountingAppliedAt: number,
): number[] {
  const runIds = database
    .prepare(
      `select distinct s.run_id
       from context_backfill_segments s
       join context_backfills b on b.id = s.run_id
       where b.created_at <= ? and s.committed_at <= ?
       order by s.run_id desc`,
    )
    .pluck()
    .all(accountingAppliedAt, accountingAppliedAt) as number[];
  return runIds.filter((runId) => {
    if (
      (job.tier === 'daily' || job.tier === 'weekly') &&
      job.periodEnd !== null &&
      database
        .prepare(
          `select exists(
             select 1 from context_backfill_segments
             where run_id = ? and period_start >= ? and period_end <= ?
           )`,
        )
        .pluck()
        .get(runId, job.periodStart, job.periodEnd) === 1
    ) {
      return true;
    }
    return legacySourceDocumentIds(job.sourceDocumentIdsJson).some(
      (documentId) => documentDescendsFromRun(database, documentId, runId),
    );
  });
}

function legacySourceDocumentIds(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is number => Number.isSafeInteger(item) && item > 0,
    );
  } catch {
    return [];
  }
}

function documentDescendsFromRun(
  database: Database.Database,
  documentId: number,
  runId: number,
): boolean {
  return (
    database
      .prepare(
        `with recursive ancestry(id) as (
           select ?
           union
           select p.parent_document_id
           from context_document_parents p
           join ancestry a on a.id = p.document_id
         )
         select exists(
           select 1 from ancestry a
           join context_backfill_segments s on s.document_id = a.id
           where s.run_id = ?
         )`,
      )
      .pluck()
      .get(documentId, runId) === 1
  );
}

function migrationGuardedRun(
  database: Database.Database,
  runId: number,
): boolean {
  return (
    database
      .prepare(
        `select exists(
           select 1 from context_backfills where id = ? and pause_reason in (
             'migration-accounting-resume-required',
             'migration-accounting-rebuild-required'
           )
         )`,
      )
      .pluck()
      .get(runId) === 1
  );
}

interface OwnershipContextJobRow {
  readonly backfillRunId: number | null;
  readonly id: number;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly sourceDocumentIdsJson: string;
  readonly sourceRevisionChecksum: string;
  readonly tier: string;
  readonly usageReservationId: string | null;
}

interface ReservationOriginContextJobRow extends OwnershipContextJobRow {
  readonly ledgerReservationId: string | null;
  readonly originBackfillRunId: number | null;
  readonly reservationActualUsd: number | null;
  readonly reservationBackfillRunId: number | null;
  readonly reservationOrigin: 'ambiguous' | 'backfill' | 'live' | null;
}

function repairBackfillOwnership(database: Database.Database): void {
  const jobs = database
    .prepare(
      `select id, tier, period_start as periodStart, period_end as periodEnd,
              source_revision_checksum as sourceRevisionChecksum,
              source_document_ids_json as sourceDocumentIdsJson,
              usage_reservation_id as usageReservationId,
              backfill_run_id as backfillRunId
       from context_jobs where status in ('pending', 'leased')`,
    )
    .all() as OwnershipContextJobRow[];
  const recoveredRunIds = new Set<number>();
  const assignJob = database.prepare(
    'update context_jobs set backfill_run_id = ? where id = ?',
  );
  const assignReservation = database.prepare(
    `update usage_ledger set backfill_run_id = ?
     where id = ? and actual_usd is null`,
  );

  for (const job of jobs) {
    const provenRunIds = exactBackfillRunIds(database, job);
    const targetRunId =
      job.backfillRunId !== null && provenRunIds.includes(job.backfillRunId)
        ? job.backfillRunId
        : provenRunIds[0];
    if (targetRunId !== undefined) {
      assignJob.run(targetRunId, job.id);
      if (job.usageReservationId !== null) {
        assignReservation.run(targetRunId, job.usageReservationId);
      }
      recoveredRunIds.add(targetRunId);
      continue;
    }

    assignJob.run(null, job.id);
  }

  const now = Date.now();
  const recover = database.prepare(
    `update context_backfills
     set status = 'paused', completed_at = null,
         pause_reason = 'migration-accounting-resume-required',
         updated_at = ?
     where id = ? and (
       status in ('active', 'paused', 'completed')
       or pause_reason in (
         'migration-accounting-resume-required',
         'migration-accounting-rebuild-required'
       )
     )`,
  );
  for (const runId of recoveredRunIds) recover.run(now, runId);
}

function repairReservationOriginOwnership(database: Database.Database): void {
  const jobs = database
    .prepare(
      `select j.id, j.tier, j.period_start as periodStart,
              j.period_end as periodEnd,
              j.source_revision_checksum as sourceRevisionChecksum,
              j.source_document_ids_json as sourceDocumentIdsJson,
              j.usage_reservation_id as usageReservationId,
              j.backfill_run_id as backfillRunId,
              l.id as ledgerReservationId,
              l.actual_usd as reservationActualUsd,
              l.backfill_run_id as reservationBackfillRunId,
              l.reservation_origin as reservationOrigin,
              l.origin_backfill_run_id as originBackfillRunId
       from context_jobs j
       left join usage_ledger l on l.id = j.usage_reservation_id
       where j.status in ('pending', 'leased')`,
    )
    .all() as ReservationOriginContextJobRow[];
  const recoveredRunIds = new Set<number>();
  const ambiguousRunIds = new Set<number>();
  const now = Date.now();
  const assignJob = database.prepare(
    'update context_jobs set backfill_run_id = ? where id = ?',
  );
  const assignReservation = database.prepare(
    `update usage_ledger set backfill_run_id = ?
     where id = ? and actual_usd is null`,
  );
  const failJob = database.prepare(
    `update context_jobs
     set status = 'failed', lease_expires_at = null,
         last_error_category = 'migration-accounting-ambiguous'
     where id = ?`,
  );
  const recordHold = database.prepare(
    `insert into context_accounting_holds
       (reservation_id, job_id, run_id, reason, created_at)
     values (?, ?, ?, 'migration-accounting-ambiguous', ?)`,
  );

  for (const job of jobs) {
    const provenRunIds = exactBackfillRunIds(database, job);
    const targetRunId =
      job.backfillRunId !== null && provenRunIds.includes(job.backfillRunId)
        ? job.backfillRunId
        : provenRunIds[0];
    const hasOutstandingReservation =
      job.ledgerReservationId !== null && job.reservationActualUsd === null;
    if (hasOutstandingReservation && job.reservationOrigin === 'ambiguous') {
      failJob.run(job.id);
      recordHold.run(
        job.ledgerReservationId,
        job.id,
        job.reservationBackfillRunId ??
          job.backfillRunId ??
          targetRunId ??
          null,
        now,
      );
      for (const runId of [
        job.backfillRunId,
        job.reservationBackfillRunId,
        targetRunId ?? null,
      ]) {
        if (runId !== null) ambiguousRunIds.add(runId);
      }
      continue;
    }

    assignJob.run(targetRunId ?? null, job.id);
    if (hasOutstandingReservation) {
      const reservationOwner =
        job.reservationOrigin === 'backfill' ? job.originBackfillRunId : null;
      assignReservation.run(reservationOwner, job.ledgerReservationId);
      if (reservationOwner !== null) recoveredRunIds.add(reservationOwner);
    }
    if (targetRunId !== undefined) recoveredRunIds.add(targetRunId);
  }

  const failRun = database.prepare(
    `update context_backfills
     set status = 'failed', completed_at = null,
         pause_reason = 'migration-accounting-rebuild-required',
         updated_at = ?
     where id = ?`,
  );
  for (const runId of ambiguousRunIds) failRun.run(now, runId);

  const recover = database.prepare(
    `update context_backfills
     set status = 'paused', completed_at = null,
         pause_reason = 'migration-accounting-resume-required',
         updated_at = ?
     where id = ? and (
       status in ('active', 'paused', 'completed')
       or pause_reason in (
         'migration-accounting-resume-required',
         'migration-accounting-rebuild-required'
       )
     )`,
  );
  for (const runId of recoveredRunIds) {
    if (!ambiguousRunIds.has(runId)) recover.run(now, runId);
  }
}

function exactBackfillRunIds(
  database: Database.Database,
  job: OwnershipContextJobRow,
): number[] {
  if (job.tier === 'hourly') {
    return exactHourlyBackfillRunIds(database, job);
  }
  const documentIds = exactJobDocumentIds(database, job);
  if (documentIds.length === 0) return [];
  const runIds = database
    .prepare(
      `select distinct run_id from context_backfill_segments
       order by run_id desc`,
    )
    .pluck()
    .all() as number[];
  return runIds.filter((runId) =>
    documentIds.some((documentId) =>
      documentDescendsFromRun(database, documentId, runId),
    ),
  );
}

function exactJobDocumentIds(
  database: Database.Database,
  job: OwnershipContextJobRow,
): number[] {
  if (job.tier === 'long-term') {
    const documentIds = [
      ...new Set(legacySourceDocumentIds(job.sourceDocumentIdsJson)),
    ];
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `select id, revision from context_documents
         where id in (${placeholders}) order by id`,
      )
      .all(...documentIds) as {
      readonly id: number;
      readonly revision: number;
    }[];
    return rows.length === documentIds.length &&
      migrationDigest(rows) === job.sourceRevisionChecksum
      ? rows.map(({ id }) => id)
      : [];
  }
  const childTier = job.tier === 'daily' ? 'hourly' : 'daily';
  if (job.tier !== 'daily' && job.tier !== 'weekly') return [];
  if (job.periodEnd === null) return [];
  const rows = database
    .prepare(
      `select id, revision from context_documents
       where tier = ? and completeness = 'final' and state = 'active'
         and content_state = 'available' and is_internal = 0
         and period_start >= ? and period_end <= ?
       order by period_start, id`,
    )
    .all(childTier, job.periodStart, job.periodEnd) as {
    readonly id: number;
    readonly revision: number;
  }[];
  if (rows.length === 0) return [];
  const revisionRows = rows.map(({ id, revision }) => ({ id, revision }));
  const legacyIdOrderedRows = [...revisionRows].sort(
    (left, right) => left.id - right.id,
  );
  return migrationDigest(revisionRows) === job.sourceRevisionChecksum ||
    migrationDigest(legacyIdOrderedRows) === job.sourceRevisionChecksum
    ? rows.map(({ id }) => id)
    : [];
}

function exactHourlyBackfillRunIds(
  database: Database.Database,
  job: OwnershipContextJobRow,
): number[] {
  if (job.periodEnd === null) return [];
  const runs = database
    .prepare(
      `select distinct b.id as runId, b.scope_id as scopeId
       from context_backfills b
       join context_backfill_pages p on p.run_id = b.id
       order by b.id desc`,
    )
    .all() as { readonly runId: number; readonly scopeId: string }[];
  return runs.flatMap(({ runId, scopeId }) => {
    const rows = database
      .prepare(
        `select id, discord_message_id as discordMessageId, content,
                edited_at as editedAt
         from conversation_events
         where guild_id || '/' || channel_id = ? and medium = 'text'
           and content_state = 'available'
           and occurred_at >= ? and occurred_at < ?
         order by id`,
      )
      .all(scopeId, job.periodStart, job.periodEnd) as {
      readonly content: string;
      readonly discordMessageId: string;
      readonly editedAt: number | null;
      readonly id: number;
    }[];
    if (
      rows.length === 0 ||
      migrationDigest(rows) !== job.sourceRevisionChecksum
    ) {
      return [];
    }
    const containsSource = database.prepare(
      `select exists(
         select 1 from context_backfill_pages
         where run_id = ? and cast(? as integer) between
           min(cast(oldest_source_id as integer),
               cast(newest_source_id as integer)) and
           max(cast(oldest_source_id as integer),
               cast(newest_source_id as integer))
       )`,
    );
    return rows.some(
      ({ discordMessageId }) =>
        containsSource.pluck().get(runId, discordMessageId) === 1,
    )
      ? [runId]
      : [];
  });
}

function migrationDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function backfillContextForgetJournals(database: Database.Database): void {
  const rows = database
    .prepare(
      `select journal_key as journalKey, occurred_at as occurredAt,
              scope_id as scopeId, tombstone_key as tombstoneKey,
              coalesce(
                (select t.reason from context_tombstones t
                 where t.tombstone_key = context_forget_journal.tombstone_key
                   and t.reason in ('discord-deleted', 'locally-forgotten')),
                (select c.content_state_reason from conversation_events c
                 where c.guild_id || '/' || c.channel_id || '/' ||
                       c.discord_message_id = context_forget_journal.scope_id
                   and c.content_state_reason in (
                     'discord-deleted', 'locally-forgotten'
                   )
                 order by c.id desc limit 1),
                'locally-forgotten'
              ) as reason
       from context_forget_journal where payload_json = '{}'`,
    )
    .all() as {
    journalKey: string;
    occurredAt: number;
    reason: 'discord-deleted' | 'locally-forgotten';
    scopeId: string;
    tombstoneKey: string;
  }[];
  const update = database.prepare(
    `update context_forget_journal
     set payload_json = ?, checksum = ? where journal_key = ?`,
  );
  for (const row of rows) {
    const payload = {
      documentIds: [] as number[],
      documentKeys: [] as string[],
      memoryIds: [] as number[],
      reason: row.reason,
      sourceScopeIds: [row.scopeId],
      tombstoneKeys: [row.tombstoneKey],
    };
    const checksum = createHash('sha256')
      .update(
        JSON.stringify({
          journalKey: row.journalKey,
          occurredAt: row.occurredAt,
          payload,
        }),
      )
      .digest('hex');
    update.run(JSON.stringify(payload), checksum, row.journalKey);
  }
}

export function repairLegacyData(
  database: Database.Database,
  previouslyApplied: ReadonlySet<string>,
): string[] {
  if (!verifyRecordedMigrationSet(database)) {
    throw new Error('legacy repair requires a migrated database');
  }

  const applied = new Set(
    database
      .prepare('select id from schema_migrations')
      .pluck()
      .all() as string[],
  );
  if ([...previouslyApplied].some((id) => !applied.has(id))) {
    throw new Error('pre-update backup is newer than the target database');
  }

  const repairs: readonly [string, (database: Database.Database) => void][] = [
    ['0005_context_forgetting', backfillContextForgetJournals],
    ['0008_context_backfill_lifecycle', guardLegacyBackfillAccounting],
    ['0009_context_backfill_targeting', targetLegacyBackfillAccounting],
    ['0010_context_backfill_ownership', repairBackfillOwnership],
    ['0012_context_accounting_origin', repairReservationOriginOwnership],
  ];
  return database.transaction(() => {
    const completed: string[] = [];
    for (const [id, repair] of repairs) {
      if (!previouslyApplied.has(id) && applied.has(id)) {
        repair(database);
        completed.push(id);
      }
    }

    return completed;
  })();
}

function main(): void {
  const args = process.argv.slice(2);
  const [databaseFlag, databasePath, beforeFlag, beforePath] = args;
  if (
    args.length !== 4 ||
    databaseFlag !== '--database' ||
    !databasePath ||
    beforeFlag !== '--before' ||
    !beforePath
  ) {
    throw new Error(
      'usage: repair-legacy-data.ts --database UPDATED.db --before PRE-UPDATE.db',
    );
  }

  if (resolve(databasePath) === resolve(beforePath))
    throw new Error('pre-update backup must be a separate file');
  if (!existsSync(databasePath) || !existsSync(beforePath))
    throw new Error('database and pre-update backup must exist');
  const before = new Database(beforePath, {
    readonly: true,
    fileMustExist: true,
  });
  let previouslyApplied: Set<string>;
  try {
    if (!verifyRecordedMigrationSet(before))
      throw new Error('invalid pre-update migration history');
    previouslyApplied = new Set(
      before
        .prepare('select id from schema_migrations')
        .pluck()
        .all() as string[],
    );
  } finally {
    before.close();
  }

  const database = openChiefDatabase(databasePath);
  try {
    const repaired = repairLegacyData(database, previouslyApplied);
    process.stdout.write(
      repaired.length
        ? `Repaired: ${repaired.join(', ')}\n`
        : 'No pending legacy data repairs.\n',
    );
  } finally {
    database.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
