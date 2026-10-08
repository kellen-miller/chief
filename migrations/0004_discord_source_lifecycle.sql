-- chief-legacy-checksum: chief-0004-v7
alter table conversation_events
  add column revision_checksum text not null default '';
alter table conversation_events
  add column response_chunk_index integer
    check (response_chunk_index is null or response_chunk_index >= 0);
alter table source_events
  add column source_scope_id text not null default '';
alter table source_events
  add column revision_checksum text not null default '';
alter table source_events
  add column can_moderate_context integer not null default 0
    check (can_moderate_context in (0, 1));
alter table memory_jobs
  add column revision_checksum text not null default '';

update memory_jobs set revision_checksum = coalesce(
  (select revision_checksum from source_events
   where source_events.id = memory_jobs.source_event_id),
  ''
);

alter table usage_ledger
  add column occurrence_month integer not null default 0;
alter table usage_ledger
  add column backfill_run_id integer references context_backfills(id)
    on delete restrict;
update usage_ledger set occurrence_month =
  cast(strftime('%s', occurred_at / 1000, 'unixepoch', 'start of month')
       as integer) * 1000;
alter table context_jobs
  add column freshness_deadline integer not null default 0;
alter table context_jobs add column usage_reservation_id text;
alter table context_jobs add column topic_label text;
alter table context_jobs
  add column source_document_ids_json text not null default '[]';
alter table context_documents
  add column is_internal integer not null default 0
    check (is_internal in (0, 1));
alter table context_documents add column topic_label text;

create table discord_reconciliation_state (
  scope_id text primary key,
  high_water_message_id text,
  phase text,
  pass_key text,
  cursor_message_id text,
  covered_oldest_message_id text,
  covered_newest_message_id text,
  scan_upper_bound_message_id text,
  last_complete_at integer,
  last_full_scan_at integer,
  updated_at integer not null
);

create table discord_reconciliation_seen (
  scope_id text not null,
  pass_key text not null,
  message_id text not null,
  observed_at integer not null,
  revision_checksum text not null,
  primary key (scope_id, pass_key, message_id)
);
