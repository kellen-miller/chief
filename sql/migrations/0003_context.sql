CREATE TABLE context_documents (
  id integer primary key,
  document_key text not null,
  tier text not null check (tier in ('hourly', 'daily', 'weekly', 'long-term')),
  period_start integer not null,
  period_end integer,
  timezone text not null,
  topic_key text,
  revision integer not null check (revision >= 1),
  completeness text not null check (completeness in ('provisional', 'final')),
  state text not null check (state in ('active', 'superseded', 'suppressed')),
  content_state text not null check (content_state in ('available', 'scrubbed')),
  content_state_reason text not null check (
    content_state_reason in (
      'retained', 'retention-expired', 'discord-deleted', 'locally-forgotten'
    )
  ),
  summary text not null,
  confidence real not null check (confidence between 0 and 1),
  retention_deadline integer,
  created_at integer not null,
  updated_at integer not null,
  generation_input_tokens integer not null default 0 check (generation_input_tokens >= 0),
  generation_output_tokens integer not null default 0 check (generation_output_tokens >= 0),
  generation_usage_usd real not null default 0 check (generation_usage_usd >= 0),
  is_internal integer not null default 0
    check (is_internal in (0, 1)),
  topic_label text,
  unique (document_key, revision),
  check (tier = 'long-term' or period_end is not null),
  check (period_end is null or period_start < period_end),
  check (
    (content_state = 'available' and content_state_reason = 'retained')
    or (content_state = 'scrubbed' and content_state_reason != 'retained')
  )
);

CREATE UNIQUE INDEX context_documents_active_idx
  on context_documents(document_key) where state = 'active';

CREATE INDEX context_documents_period_idx
  on context_documents(tier, timezone, period_start, period_end);

CREATE TABLE context_document_events (
  document_id integer not null references context_documents(id) on delete cascade,
  event_id integer not null references conversation_events(id) on delete restrict,
  primary key (document_id, event_id)
);

CREATE TABLE context_document_parents (
  document_id integer not null references context_documents(id) on delete cascade,
  parent_document_id integer not null references context_documents(id) on delete restrict,
  primary key (document_id, parent_document_id),
  check (document_id != parent_document_id)
);

CREATE TABLE context_jobs (
  id integer primary key,
  job_key text not null unique,
  tier text not null check (tier in ('hourly', 'daily', 'weekly', 'long-term')),
  period_start integer not null,
  period_end integer,
  timezone text not null,
  topic_key text,
  completeness text not null check (completeness in ('provisional', 'final')),
  source_revision_checksum text not null,
  not_before integer not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at integer,
  status text not null default 'pending' check (
    status in ('pending', 'leased', 'completed', 'failed')
  ),
  last_error_category text,
  freshness_deadline integer not null default 0,
  usage_reservation_id text,
  topic_label text,
  source_document_ids_json text not null default '[]',
  backfill_run_id integer references context_backfills(id)
    on delete restrict
);

CREATE INDEX context_jobs_due_idx
  on context_jobs(status, not_before, lease_expires_at);

CREATE TABLE context_tombstones (
  id integer primary key,
  tombstone_key text not null unique,
  scope_type text not null check (scope_type in ('source', 'document', 'topic')),
  scope_id text not null,
  reason text not null check (reason in ('discord-deleted', 'locally-forgotten')),
  occurred_at integer not null,
  checksum text not null,
  unique (scope_type, scope_id)
);

CREATE TABLE context_deletion_requests (
  id text primary key,
  requester_id text not null,
  scope_type text not null check (scope_type in ('source', 'member', 'topic')),
  scope_id text not null,
  confirmation_checksum text not null,
  status text not null check (status in ('pending', 'confirmed', 'consumed', 'expired')),
  expires_at integer not null,
  created_at integer not null,
  consumed_at integer,
  source_ids_json text not null default '[]',
  document_ids_json text not null default '[]',
  memory_ids_json text not null default '[]',
  request_source_id text not null default ''
);

CREATE TABLE context_forget_journal (
  id integer primary key,
  journal_key text not null unique,
  scope_id text not null,
  tombstone_key text not null references context_tombstones(tombstone_key) on delete restrict,
  occurred_at integer not null,
  checksum text not null,
  upload_status text not null default 'pending' check (
    upload_status in ('pending', 'uploaded', 'failed')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at integer,
  uploaded_at integer,
  last_error_category text,
  payload_json text not null default '{}'
);

CREATE INDEX context_forget_journal_upload_idx
  on context_forget_journal(upload_status, next_attempt_at);

CREATE TABLE context_backfills (
  id integer primary key,
  run_key text not null unique,
  scope_id text not null,
  status text not null check (
    status in ('dry-run', 'ready', 'active', 'paused', 'completed', 'failed')
  ),
  oldest_source_id text,
  newest_source_id text,
  cursor_source_id text,
  eligible_count integer not null default 0 check (eligible_count >= 0),
  estimated_usage_usd real not null default 0 check (estimated_usage_usd >= 0),
  maximum_usage_usd real,
  actual_usage_usd real not null default 0 check (actual_usage_usd >= 0),
  created_at integer not null,
  updated_at integer not null,
  completed_at integer,
  oldest_occurred_at integer,
  newest_occurred_at integer,
  already_ingested_count integer not null default 0
    check (already_ingested_count >= 0),
  eligible_bytes integer not null default 0
    check (eligible_bytes >= 0),
  eligible_tokens integer not null default 0
    check (eligible_tokens >= 0),
  page_count integer not null default 0 check (page_count >= 0),
  next_page_index integer,
  manifest_checksum text,
  pause_reason text,
  activated_at integer
);

CREATE VIRTUAL TABLE context_document_fts using fts5(
  content,
  content='',
  contentless_delete=1
);

CREATE VIRTUAL TABLE context_document_vectors using vec0(
  document_id integer primary key,
  embedding float[1536]
);

CREATE TABLE context_backfill_pages (
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

CREATE TABLE context_backfill_segments (
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

CREATE INDEX context_backfill_segments_page_idx
  on context_backfill_segments(run_id, page_index);

CREATE TABLE context_backfill_source_identities (
  run_id integer not null references context_backfills(id) on delete cascade,
  message_id text not null,
  event_id integer not null references conversation_events(id) on delete restrict,
  first_page_index integer not null check (first_page_index >= 0),
  revision_checksum text not null,
  occurred_at integer not null,
  primary key (run_id, message_id),
  unique (run_id, event_id)
);

CREATE INDEX context_jobs_backfill_run_idx
  on context_jobs(backfill_run_id, status, not_before);
