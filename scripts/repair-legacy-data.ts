import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSqliteStatement } from '../src/database/sqlite-statements.js';
import * as queries from '../gen/sql/application.js';

import Database from 'better-sqlite3';

import {
  openChiefDatabase,
  verifyRecordedMigrationSet,
} from '../src/memory/database.js';

function guardLegacyBackfillAccounting(database: Database.Database): void {
  const unfinishedRunIds = queries
    .repairLegacyDataGuardLegacyBackfillAccountingSelectContextBackfills(
      database,
    )
    .pluck()
    .all();
  const guardRunId = unfinishedRunIds[0];
  if (guardRunId === undefined) return;

  const now = Date.now();
  queries
    .repairLegacyDataGuardLegacyBackfillAccountingUpdateContextBackfills(
      database,
    )
    .run(now, guardRunId);
  queries
    .repairLegacyDataGuardLegacyBackfillAccountingUpdateContextBackfills2(
      database,
    )
    .run(now, guardRunId);
  queries
    .repairLegacyDataGuardLegacyBackfillAccountingUpdateContextJobs(database)
    .run(guardRunId);
  database
    .prepare(
      readSqliteStatement(
        'repairLegacyDataGuardLegacyBackfillAccountingUpdateUsageLedger',
      ),
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
    .prepare(
      readSqliteStatement(
        'repairLegacyDataTargetLegacyBackfillAccountingSelectSchemaMigrations',
      ),
    )
    .pluck()
    .get('0007_context_backfill_accounting') as number;
  const jobs = queries
    .repairLegacyDataTargetLegacyBackfillAccountingSelectContextJobs(database)
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
      queries
        .repairLegacyDataTargetLegacyBackfillAccountingUpdateContextJobs(
          database,
        )
        .run(targetRunId, job.id);
      if (job.usageReservationId !== null) {
        queries
          .repairLegacyDataTargetLegacyBackfillAccountingUpdateUsageLedger(
            database,
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
        queries
          .repairLegacyDataTargetLegacyBackfillAccountingUpdateUsageLedger2(
            database,
          )
          .run(job.usageReservationId, job.backfillRunId);
      }
      queries
        .repairLegacyDataTargetLegacyBackfillAccountingUpdateContextJobs2(
          database,
        )
        .run(job.id);
    }
  }

  const now = Date.now();
  const recover =
    queries.repairLegacyDataTargetLegacyBackfillAccountingUpdateContextBackfills(
      database,
    );
  for (const runId of recoveredRunIds) recover.run(now, runId);
}

function provableBackfillRunIds(
  database: Database.Database,
  job: LegacyContextJobRow,
  accountingAppliedAt: number,
): number[] {
  const runIds = queries
    .repairLegacyDataProvableBackfillRunIdsSelectContextBackfillSegments(
      database,
    )
    .pluck()
    .all(accountingAppliedAt, accountingAppliedAt);
  return runIds.filter((runId) => {
    if (
      (job.tier === 'daily' || job.tier === 'weekly') &&
      job.periodEnd !== null &&
      queries
        .repairLegacyDataProvableBackfillRunIdsSelectContextBackfillSegments2(
          database,
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
        readSqliteStatement(
          'repairLegacyDataDocumentDescendsFromRunSelectContextDocumentParents',
        ),
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
    queries
      .repairLegacyDataMigrationGuardedRunSelectContextBackfills(database)
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
  const jobs = queries
    .repairLegacyDataRepairBackfillOwnershipSelectContextJobs(database)
    .all() as OwnershipContextJobRow[];
  const recoveredRunIds = new Set<number>();
  const assignJob =
    queries.repairLegacyDataRepairBackfillOwnershipUpdateContextJobs(database);
  const assignReservation =
    queries.repairLegacyDataRepairBackfillOwnershipUpdateUsageLedger(database);

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
  const recover =
    queries.repairLegacyDataRepairBackfillOwnershipUpdateContextBackfills(
      database,
    );
  for (const runId of recoveredRunIds) recover.run(now, runId);
}

function repairReservationOriginOwnership(database: Database.Database): void {
  const jobs = queries
    .repairLegacyDataRepairReservationOriginOwnershipSelectContextJobs(database)
    .all() as ReservationOriginContextJobRow[];
  const recoveredRunIds = new Set<number>();
  const ambiguousRunIds = new Set<number>();
  const now = Date.now();
  const assignJob =
    queries.repairLegacyDataRepairReservationOriginOwnershipUpdateContextJobs(
      database,
    );
  const assignReservation =
    queries.repairLegacyDataRepairReservationOriginOwnershipUpdateUsageLedger(
      database,
    );
  const failJob =
    queries.repairLegacyDataRepairReservationOriginOwnershipUpdateContextJobs2(
      database,
    );
  const recordHold =
    queries.repairLegacyDataRepairReservationOriginOwnershipInsertContextAccountingHolds(
      database,
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

  const failRun =
    queries.repairLegacyDataRepairReservationOriginOwnershipUpdateContextBackfills(
      database,
    );
  for (const runId of ambiguousRunIds) failRun.run(now, runId);

  const recover =
    queries.repairLegacyDataRepairReservationOriginOwnershipUpdateContextBackfills2(
      database,
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
  const runIds = queries
    .repairLegacyDataExactBackfillRunIdsSelectContextBackfillSegments(database)
    .pluck()
    .all();
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
        readSqliteStatement('selectContextDocumentRevisions', [placeholders]),
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
  const rows = queries
    .repairLegacyDataExactJobDocumentIdsSelectContextDocuments2(database)
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
  const periodEnd = job.periodEnd;
  const runs = queries
    .repairLegacyDataExactHourlyBackfillRunIdsSelectContextBackfills(database)
    .all() as { readonly runId: number; readonly scopeId: string }[];
  return runs.flatMap(({ runId, scopeId }) => {
    const rows = queries
      .repairLegacyDataExactHourlyBackfillRunIdsSelectConversationEvents(
        database,
      )
      .all(scopeId, job.periodStart, periodEnd) as {
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
    const containsSource =
      queries.repairLegacyDataExactHourlyBackfillRunIdsSelectContextBackfillPages(
        database,
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
  const rows = queries
    .repairLegacyDataBackfillContextForgetJournalsSelectContextTombstones(
      database,
    )
    .all() as {
    journalKey: string;
    occurredAt: number;
    reason: 'discord-deleted' | 'locally-forgotten';
    scopeId: string;
    tombstoneKey: string;
  }[];
  const update =
    queries.repairLegacyDataBackfillContextForgetJournalsUpdateContextForgetJournal(
      database,
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
      .prepare(readSqliteStatement('selectLegacyMigrationIds'))
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
        .prepare(readSqliteStatement('selectLegacyMigrationIds'))
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
