CREATE TABLE "usage_ledger" (
  id text primary key,
  operation text not null,
  work_category text not null check (
    work_category in ('interaction', 'memory', 'indexing')
  ),
  priority text not null check (priority in ('interactive', 'background')),
  reservation_usd real not null,
  actual_usd real,
  occurred_at integer not null,
  reconciled_at integer,
  occurrence_month integer not null default 0,
  backfill_run_id integer references context_backfills(id)
    on delete restrict,
  reservation_origin text not null default 'ambiguous'
    check (reservation_origin in ('live', 'backfill', 'ambiguous')),
  origin_backfill_run_id integer
    references context_backfills(id) on delete restrict
    check (
      reservation_origin = 'ambiguous'
      or (reservation_origin = 'live' and origin_backfill_run_id is null)
      or (reservation_origin = 'backfill'
          and origin_backfill_run_id is not null)
    )
);

CREATE INDEX usage_ledger_occurred_idx on usage_ledger(occurred_at);

CREATE TRIGGER usage_ledger_origin_immutable
before update of reservation_origin, origin_backfill_run_id on usage_ledger
when new.reservation_origin != old.reservation_origin
  or new.origin_backfill_run_id is not old.origin_backfill_run_id
begin
  select raise(abort, 'usage reservation origin is immutable');
end;

CREATE TABLE context_accounting_holds (
  reservation_id text primary key
    references usage_ledger(id) on delete restrict,
  job_id integer not null unique
    references context_jobs(id) on delete restrict,
  run_id integer references context_backfills(id) on delete restrict,
  reason text not null check (reason = 'migration-accounting-ambiguous'),
  created_at integer not null
);
