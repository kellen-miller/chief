-- chief-legacy-checksum: chief-0006-v2
alter table context_backfills add column oldest_occurred_at integer;
alter table context_backfills add column newest_occurred_at integer;
alter table context_backfills
  add column already_ingested_count integer not null default 0
    check (already_ingested_count >= 0);
alter table context_backfills
  add column eligible_bytes integer not null default 0
    check (eligible_bytes >= 0);
alter table context_backfills
  add column eligible_tokens integer not null default 0
    check (eligible_tokens >= 0);
alter table context_backfills
  add column page_count integer not null default 0 check (page_count >= 0);
alter table context_backfills add column next_page_index integer;
alter table context_backfills add column manifest_checksum text;
alter table context_backfills add column pause_reason text;
alter table context_backfills add column activated_at integer;

create table context_backfill_pages (
  run_id integer not null references context_backfills(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  request_before_source_id text,
  oldest_source_id text not null,
  newest_source_id text not null,
  eligible_count integer not null check (eligible_count >= 0),
  eligible_bytes integer not null check (eligible_bytes >= 0),
  eligible_tokens integer not null check (eligible_tokens >= 0),
  identity_checksum text not null,
  completed_at integer,
  primary key (run_id, page_index)
);

create table context_backfill_segments (
  run_id integer not null references context_backfills(id) on delete cascade,
  segment_key text not null,
  page_index integer not null check (page_index >= 0),
  period_start integer not null,
  period_end integer not null,
  source_checksum text not null,
  source_count integer not null check (source_count > 0),
  document_id integer references context_documents(id) on delete restrict,
  actual_usage_usd real not null default 0 check (actual_usage_usd >= 0),
  committed_at integer not null,
  primary key (run_id, segment_key),
  foreign key (run_id, page_index)
    references context_backfill_pages(run_id, page_index) on delete cascade
);
create index context_backfill_segments_page_idx
  on context_backfill_segments(run_id, page_index);

create table context_backfill_source_identities (
  run_id integer not null references context_backfills(id) on delete cascade,
  message_id text not null,
  event_id integer not null references conversation_events(id) on delete restrict,
  first_page_index integer not null check (first_page_index >= 0),
  revision_checksum text not null,
  occurred_at integer not null,
  primary key (run_id, message_id),
  unique (run_id, event_id)
);
