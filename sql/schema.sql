-- Generated from src/memory/database.ts. DO NOT EDIT.
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
  completed_at integer
, oldest_occurred_at integer, newest_occurred_at integer, already_ingested_count integer not null default 0
    check (already_ingested_count >= 0), eligible_bytes integer not null default 0
    check (eligible_bytes >= 0), eligible_tokens integer not null default 0
    check (eligible_tokens >= 0), page_count integer not null default 0 check (page_count >= 0), next_page_index integer, manifest_checksum text, pause_reason text, activated_at integer);

CREATE TABLE context_deletion_requests (
  id text primary key,
  requester_id text not null,
  scope_type text not null check (scope_type in ('source', 'member', 'topic')),
  scope_id text not null,
  confirmation_checksum text not null,
  status text not null check (status in ('pending', 'confirmed', 'consumed', 'expired')),
  expires_at integer not null,
  created_at integer not null,
  consumed_at integer
, source_ids_json text not null default '[]', document_ids_json text not null default '[]', memory_ids_json text not null default '[]', request_source_id text not null default '');

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
  generation_usage_usd real not null default 0 check (generation_usage_usd >= 0), is_internal integer not null default 0
    check (is_internal in (0, 1)), topic_label text,
  unique (document_key, revision),
  check (tier = 'long-term' or period_end is not null),
  check (period_end is null or period_start < period_end),
  check (
    (content_state = 'available' and content_state_reason = 'retained')
    or (content_state = 'scrubbed' and content_state_reason != 'retained')
  )
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
  last_error_category text
, payload_json text not null default '{}');

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
  last_error_category text
, freshness_deadline integer not null default 0, usage_reservation_id text, topic_label text, source_document_ids_json text not null default '[]', backfill_run_id integer references context_backfills(id)
    on delete restrict);

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

CREATE TABLE "conversation_events" (
  id integer primary key,
  platform_event_id text not null,
  discord_message_id text not null,
  guild_id text not null,
  channel_id text not null,
  request_id text,
  logical_response_id text,
  role text not null check (role in ('human', 'chief')),
  speaker_id text,
  speaker_name text,
  medium text not null check (medium in ('text', 'voice')),
  reply_to_message_id text,
  content text not null,
  attachment_metadata_json text not null,
  occurred_at integer not null,
  edited_at integer,
  deleted_at integer,
  recent_until integer not null,
  retention_deadline integer not null,
  content_state text not null check (content_state in ('available', 'scrubbed')),
  content_state_reason text not null check (
    content_state_reason in (
      'retained', 'retention-expired', 'discord-deleted', 'locally-forgotten'
    )
  ), revision_checksum text not null default '', response_chunk_index integer
    check (response_chunk_index is null or response_chunk_index >= 0),
  check (
    (content_state = 'available' and content_state_reason = 'retained')
    or (content_state = 'scrubbed' and content_state_reason != 'retained')
  ),
  unique (guild_id, channel_id, discord_message_id)
);

CREATE TABLE discord_reconciliation_seen (
  scope_id text not null,
  pass_key text not null,
  message_id text not null,
  observed_at integer not null,
  revision_checksum text not null,
  primary key (scope_id, pass_key, message_id)
);

CREATE TABLE discord_reconciliation_state (
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

CREATE TABLE `knex_migrations` (`id` integer not null primary key autoincrement, `name` varchar(255), `batch` integer, `migration_time` datetime);

CREATE TABLE `knex_migrations_lock` (`index` integer not null primary key autoincrement, `is_locked` integer);

CREATE TABLE maintenance_runs (
  id integer primary key,
  kind text not null,
  started_at integer not null,
  completed_at integer,
  status text not null
);

CREATE TABLE memories (
  id integer primary key,
  source_event_id integer references source_events(id) on delete set null,
  canonical_text text not null,
  kind text not null,
  confidence real not null check (confidence between 0 and 1),
  provenance_json text not null,
  state text not null check (state in ('active', 'superseded')),
  superseded_by integer references memories(id) on delete set null,
  created_at integer not null,
  updated_at integer not null
);

CREATE TABLE memory_conflicts (
  id integer primary key,
  left_memory_id integer not null references memories(id) on delete cascade,
  right_memory_id integer not null references memories(id) on delete cascade,
  created_at integer not null,
  unique (left_memory_id, right_memory_id)
);

CREATE TABLE memory_jobs (
  id integer primary key,
  source_event_id integer references source_events(id) on delete cascade,
  voice_session_id integer references voice_sessions(id) on delete restrict,
  not_before integer not null,
  attempt_count integer not null default 0,
  lease_expires_at integer,
  status text not null default 'pending'
, revision_checksum text not null default '');

CREATE TABLE monitoring_alerts (
  id integer primary key,
  created_at integer not null,
  delivered_at integer,
  report_json text not null
);

CREATE TABLE schema_migrations (id text primary key, checksum text not null, applied_at integer not null);

CREATE TABLE source_events (
  id integer primary key,
  platform_source_id text not null unique,
  speaker_id text not null,
  medium text not null check (medium in ('text', 'voice')),
  content text not null,
  occurred_at integer not null,
  retention_deadline integer not null,
  voice_session_id integer references voice_sessions(id) on delete set null,
  extraction_status text not null default 'pending'
, source_scope_id text not null default '', revision_checksum text not null default '', can_moderate_context integer not null default 0
    check (can_moderate_context in (0, 1)));

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
  reconciled_at integer
, occurrence_month integer not null default 0, backfill_run_id integer references context_backfills(id)
    on delete restrict, reservation_origin text not null default 'ambiguous'
    check (reservation_origin in ('live', 'backfill', 'ambiguous')), origin_backfill_run_id integer
    references context_backfills(id) on delete restrict
    check (
      reservation_origin = 'ambiguous'
      or (reservation_origin = 'live' and origin_backfill_run_id is null)
      or (reservation_origin = 'backfill'
          and origin_backfill_run_id is not null)
    ));

CREATE TABLE voice_sessions (
  id integer primary key,
  started_at integer not null,
  ended_at integer
);

CREATE INDEX context_backfill_segments_page_idx
  on context_backfill_segments(run_id, page_index);

CREATE UNIQUE INDEX context_documents_active_idx
  on context_documents(document_key) where state = 'active';

CREATE INDEX context_documents_period_idx
  on context_documents(tier, timezone, period_start, period_end);

CREATE INDEX context_forget_journal_upload_idx
  on context_forget_journal(upload_status, next_attempt_at);

CREATE INDEX context_jobs_backfill_run_idx
  on context_jobs(backfill_run_id, status, not_before);

CREATE INDEX context_jobs_due_idx
  on context_jobs(status, not_before, lease_expires_at);

CREATE INDEX conversation_events_logical_response_idx
  on conversation_events(logical_response_id, id);

CREATE INDEX conversation_events_recent_idx
  on conversation_events(recent_until, id desc);

CREATE INDEX conversation_events_retention_idx
  on conversation_events(retention_deadline);

CREATE INDEX monitoring_alerts_created_idx
  on monitoring_alerts(created_at);

CREATE INDEX usage_ledger_occurred_idx on usage_ledger(occurred_at);
