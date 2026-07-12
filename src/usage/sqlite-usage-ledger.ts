import type Database from 'better-sqlite3';

import type { UsageLedger, UsageLedgerEntry } from './usage-budget.js';

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

  public list(start: number, end: number): UsageLedgerEntry[] {
    return this.#database
      .prepare(
        `select id, operation, reservation_usd as reservationUsd,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where occurred_at >= ? and occurred_at < ?`,
      )
      .all(start, end) as UsageLedgerEntry[];
  }

  public reconcile(id: string, actualUsd: number, reconciledAt: number): void {
    const result = this.#database
      .prepare(
        `update usage_ledger set actual_usd = ?, reconciled_at = ?
         where id = ? and actual_usd is null`,
      )
      .run(actualUsd, reconciledAt, id);
    if (result.changes !== 1) throw new Error('unknown usage reservation');
  }

  public record(entry: UsageLedgerEntry): void {
    this.#database
      .prepare(
        `insert into usage_ledger
           (id, operation, reservation_usd, actual_usd, occurred_at, reconciled_at)
         values (@id, @operation, @reservationUsd, @actualUsd, @occurredAt,
                 case when @actualUsd is null then null else @occurredAt end)`,
      )
      .run(entry);
  }
}
