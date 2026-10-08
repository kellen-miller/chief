alter table usage_ledger
  add column reservation_origin text not null default 'ambiguous'
    check (reservation_origin in ('live', 'backfill', 'ambiguous'));
alter table usage_ledger
  add column origin_backfill_run_id integer
    references context_backfills(id) on delete restrict
    check (
      reservation_origin = 'ambiguous'
      or (reservation_origin = 'live' and origin_backfill_run_id is null)
      or (reservation_origin = 'backfill'
          and origin_backfill_run_id is not null)
    );
create trigger usage_ledger_origin_immutable
before update of reservation_origin, origin_backfill_run_id on usage_ledger
when new.reservation_origin != old.reservation_origin
  or new.origin_backfill_run_id is not old.origin_backfill_run_id
begin
  select raise(abort, 'usage reservation origin is immutable');
end;
create table context_accounting_holds (
  reservation_id text primary key
    references usage_ledger(id) on delete restrict,
  job_id integer not null unique
    references context_jobs(id) on delete restrict,
  run_id integer references context_backfills(id) on delete restrict,
  reason text not null check (reason = 'migration-accounting-ambiguous'),
  created_at integer not null
);
