import type Database from 'better-sqlite3';

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
    this.#database
      .prepare('delete from usage_ledger where id = ? and actual_usd is null')
      .run(id);
  }

  public backfillRun(runId: number): {
    readonly actualUsd: number;
    readonly maximumUsd: number;
  } | null {
    return (
      (this.#database
        .prepare(
          `select actual_usage_usd as actualUsd,
                  maximum_usage_usd as maximumUsd
           from context_backfills where id = ?
             and maximum_usage_usd is not null`,
        )
        .get(runId) as
        | { readonly actualUsd: number; readonly maximumUsd: number }
        | undefined) ?? null
    );
  }

  public list(start: number, end: number): UsageLedgerEntry[] {
    const rows = this.#database
      .prepare(
        `select id, operation, reservation_usd as reservationUsd,
                backfill_run_id as backfillRunId,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where occurred_at >= ? and occurred_at < ?`,
      )
      .all(start, end) as UsageLedgerRow[];
    return rows.map(withOptionalRunId);
  }

  public listOutstanding(): UsageLedgerEntry[] {
    const rows = this.#database
      .prepare(
        `select id, operation, reservation_usd as reservationUsd,
                backfill_run_id as backfillRunId,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where actual_usd is null`,
      )
      .all() as UsageLedgerRow[];
    return rows.map(withOptionalRunId);
  }

  public reconcile(id: string, actualUsd: number, reconciledAt: number): void {
    this.#database.transaction(() => {
      const runId = this.#database
        .prepare(
          `select backfill_run_id from usage_ledger
           where id = ? and actual_usd is null`,
        )
        .pluck()
        .get(id) as number | null | undefined;
      if (runId === undefined) throw new Error('unknown usage reservation');
      const result = this.#database
        .prepare(
          `update usage_ledger set actual_usd = ?, reconciled_at = ?
           where id = ? and actual_usd is null`,
        )
        .run(actualUsd, reconciledAt, id);
      if (result.changes !== 1) throw new Error('unknown usage reservation');
      if (runId !== null) {
        const run = this.#database
          .prepare(
            `update context_backfills
             set actual_usage_usd = actual_usage_usd + ?, updated_at = ?
             where id = ?`,
          )
          .run(actualUsd, reconciledAt, runId);
        if (run.changes !== 1) throw new Error('unknown backfill run');
      }
    })();
  }

  public record(entry: UsageLedgerEntry): void {
    this.#database
      .prepare(
        `insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at)
         values (@id, @operation, @workCategory, @priority, @reservationUsd,
                 @actualUsd, @occurredAt, @occurrenceMonth, @backfillRunId,
                 case when @actualUsd is null then null else @occurredAt end)`,
      )
      .run({
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
    priority: row.priority,
    reservationUsd: row.reservationUsd,
    workCategory: row.workCategory,
  };
}
