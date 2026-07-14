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
                origin_backfill_run_id as originBackfillRunId,
                reservation_origin as reservationOrigin,
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
                origin_backfill_run_id as originBackfillRunId,
                reservation_origin as reservationOrigin,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where actual_usd is null`,
      )
      .all() as UsageLedgerRow[];
    return rows.map(withOptionalRunId);
  }

  public reconcile(id: string, actualUsd: number, reconciledAt: number): void {
    this.#database.transaction(() => {
      const reservation = this.#database
        .prepare(
          `select l.backfill_run_id as backfillRunId,
                  exists(
                    select 1 from context_accounting_holds h
                    where h.reservation_id = l.id
                  ) as held
           from usage_ledger l where l.id = ? and l.actual_usd is null`,
        )
        .get(id) as
        | { readonly backfillRunId: number | null; readonly held: 0 | 1 }
        | undefined;
      if (reservation === undefined) {
        throw new Error('unknown usage reservation');
      }
      if (reservation.held === 1) {
        throw new Error('usage reservation is held for accounting rebuild');
      }
      const result = this.#database
        .prepare(
          `update usage_ledger set actual_usd = ?, reconciled_at = ?
           where id = ? and actual_usd is null`,
        )
        .run(actualUsd, reconciledAt, id);
      if (result.changes !== 1) throw new Error('unknown usage reservation');
      if (reservation.backfillRunId !== null) {
        const run = this.#database
          .prepare(
            `update context_backfills
             set actual_usage_usd = actual_usage_usd + ?, updated_at = ?
             where id = ?`,
          )
          .run(actualUsd, reconciledAt, reservation.backfillRunId);
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
            reconciled_at, reservation_origin, origin_backfill_run_id)
         values (@id, @operation, @workCategory, @priority, @reservationUsd,
                 @actualUsd, @occurredAt, @occurrenceMonth, @backfillRunId,
                 case when @actualUsd is null then null else @occurredAt end,
                 @reservationOrigin, @originBackfillRunId)`,
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
    originBackfillRunId: row.originBackfillRunId,
    priority: row.priority,
    reservationOrigin: row.reservationOrigin,
    reservationUsd: row.reservationUsd,
    workCategory: row.workCategory,
  };
}
