alter table context_jobs
  add column backfill_run_id integer references context_backfills(id)
    on delete restrict;
create index context_jobs_backfill_run_idx
  on context_jobs(backfill_run_id, status, not_before);
