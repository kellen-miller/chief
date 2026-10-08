import type Database from 'better-sqlite3';

import * as queries from '../../gen/sql/application.js';

import type { UsageLedger, UsageLedgerEntry } from './usage-budget.js';

type UsageLedgerRow = UsageLedgerEntry & {
  readonly backfillRunId: number | null;
};

export class SqliteUsageLedger implements UsageLedger {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public cancel(id: string): void {
    queries.usageLedgerCancelDeleteUsageLedger(this.#database).run(id);
  }

  public backfillRun(runId: number): {
    readonly actualUsd: number;
    readonly maximumUsd: number;
  } | null {
    return (
      (queries
        .usageLedgerBackfillRunSelectContextBackfills(this.#database)
        .get(runId) as
        | { readonly actualUsd: number; readonly maximumUsd: number }
        | undefined) ?? null
    );
  }

  public list(start: number, end: number): UsageLedgerEntry[] {
    const rows = queries
      .usageLedgerListSelectUsageLedger(this.#database)
      .all(start, end) as UsageLedgerRow[];
    return rows.map(withOptionalRunId);
  }

  public listOutstanding(): UsageLedgerEntry[] {
    const rows = queries
      .usageLedgerListOutstandingSelectUsageLedger(this.#database)
      .all() as UsageLedgerRow[];
    return rows.map(withOptionalRunId);
  }

  public reconcile(id: string, actualUsd: number, reconciledAt: number): void {
    this.reconcileWith(id, actualUsd, reconciledAt, () => undefined);
  }

  public reconcileWith<T>(
    id: string,
    actualUsd: number,
    reconciledAt: number,
    work: () => T,
  ): T {
    return this.#database.transaction(() => {
      const workResult = work();
      const reservation = queries
        .usageLedgerReconcileWithSelectContextAccountingHolds(this.#database)
        .get(id) as
        | { readonly backfillRunId: number | null; readonly held: 0 | 1 }
        | undefined;
      if (reservation === undefined) {
        throw new Error('unknown usage reservation');
      }
      if (reservation.held === 1) {
        throw new Error('usage reservation is held for accounting rebuild');
      }
      const updateResult = queries
        .usageLedgerReconcileWithUpdateUsageLedger(this.#database)
        .run(actualUsd, reconciledAt, id);
      if (updateResult.changes !== 1) {
        throw new Error('unknown usage reservation');
      }
      if (reservation.backfillRunId !== null) {
        const run = queries
          .usageLedgerReconcileWithUpdateContextBackfills(this.#database)
          .run(actualUsd, reconciledAt, reservation.backfillRunId);
        if (run.changes !== 1) throw new Error('unknown backfill run');
      }
      return workResult;
    })();
  }

  public record(entry: UsageLedgerEntry): void {
    queries.usageLedgerRecordInsertUsageLedger(this.#database).run({
      ...entry,
      backfillRunId: entry.backfillRunId ?? null,
      occurrenceMonth: monthStart(entry.occurredAt),
    });
  }
}

function monthStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function withOptionalRunId(row: UsageLedgerRow): UsageLedgerEntry {
  if (row.backfillRunId !== null) return row;
  return {
    actualUsd: row.actualUsd,
    id: row.id,
    occurredAt: row.occurredAt,
    operation: row.operation,
    originBackfillRunId: row.originBackfillRunId,
    priority: row.priority,
    reservationOrigin: row.reservationOrigin,
    reservationUsd: row.reservationUsd,
    workCategory: row.workCategory,
  };
}
