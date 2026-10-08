-- chief-legacy-checksum: chief-0003-v2
alter table conversation_events add column recent_until__migration integer;
alter table conversation_events add column guild_id__migration text;
alter table conversation_events add column channel_id__migration text;
alter table conversation_events add column discord_message_id__migration text;
alter table conversation_events add column reply_to_message_id__migration text;
alter table conversation_events add column edited_at__migration integer;
alter table conversation_events add column deleted_at__migration integer;
alter table conversation_events add column attachment_metadata_json__migration text;
alter table conversation_events add column logical_response_id__migration text;
alter table conversation_events add column content_state__migration text;
alter table conversation_events add column content_state_reason__migration text;

update conversation_events set
  recent_until__migration = retention_deadline,
  guild_id__migration = '',
  channel_id__migration = '',
  discord_message_id__migration = platform_event_id,
  attachment_metadata_json__migration = '[]',
  content_state__migration = 'available',
  content_state_reason__migration = 'retained';

create table migration_0003_conversation_validation (
  valid integer not null check (valid = 1)
);
insert into migration_0003_conversation_validation (valid)
select case when exists (
  select 1 from conversation_events
  where recent_until__migration is null
     or guild_id__migration is null
     or channel_id__migration is null
     or discord_message_id__migration is null
     or attachment_metadata_json__migration is null
     or content_state__migration is null
     or content_state_reason__migration is null
) then 0 else 1 end;
drop table migration_0003_conversation_validation;

create table conversation_events_0003 (
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
  ),
  check (
    (content_state = 'available' and content_state_reason = 'retained')
    or (content_state = 'scrubbed' and content_state_reason != 'retained')
  ),
  unique (guild_id, channel_id, discord_message_id)
);

insert into conversation_events_0003
  (id, platform_event_id, discord_message_id, guild_id, channel_id, request_id,
   logical_response_id, role, speaker_id, speaker_name, medium,
   reply_to_message_id, content, attachment_metadata_json, occurred_at,
   edited_at, deleted_at, recent_until, retention_deadline, content_state,
   content_state_reason)
select id, platform_event_id, discord_message_id__migration,
       guild_id__migration, channel_id__migration, request_id,
       logical_response_id__migration, role, speaker_id, speaker_name, medium,
       reply_to_message_id__migration, content,
       attachment_metadata_json__migration, occurred_at,
       edited_at__migration, deleted_at__migration, recent_until__migration,
       retention_deadline, content_state__migration,
       content_state_reason__migration
from conversation_events;

drop table conversation_events;
alter table conversation_events_0003 rename to conversation_events;
create index conversation_events_retention_idx
  on conversation_events(retention_deadline);
create index conversation_events_recent_idx
  on conversation_events(recent_until, id desc);
create index conversation_events_logical_response_idx
  on conversation_events(logical_response_id, id);

alter table usage_ledger add column work_category__migration text;
alter table usage_ledger add column priority__migration text;
update usage_ledger set
  work_category__migration = case
    when operation like 'context-%' then 'indexing'
    when operation like 'memory-%' then 'memory'
    else 'interaction'
  end,
  priority__migration = case
    when operation like 'context-%'
      or operation like 'memory-%'
      or operation = 'voice-suffix-generation'
    then 'background'
    else 'interactive'
  end;

create table migration_0003_usage_validation (
  valid integer not null check (valid = 1)
);
insert into migration_0003_usage_validation (valid)
select case when exists (
  select 1 from usage_ledger
  where work_category__migration is null or priority__migration is null
) then 0 else 1 end;
drop table migration_0003_usage_validation;

create table usage_ledger_0003 (
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
);
insert into usage_ledger_0003
  (id, operation, work_category, priority, reservation_usd, actual_usd,
   occurred_at, reconciled_at)
select id, operation, work_category__migration, priority__migration,
       reservation_usd, actual_usd, occurred_at, reconciled_at
from usage_ledger;
drop table usage_ledger;
alter table usage_ledger_0003 rename to usage_ledger;
create index usage_ledger_occurred_idx on usage_ledger(occurred_at);

create table context_documents (
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
  unique (document_key, revision),
  check (tier = 'long-term' or period_end is not null),
  check (period_end is null or period_start < period_end),
  check (
    (content_state = 'available' and content_state_reason = 'retained')
    or (content_state = 'scrubbed' and content_state_reason != 'retained')
  )
);
create unique index context_documents_active_idx
  on context_documents(document_key) where state = 'active';
create index context_documents_period_idx
  on context_documents(tier, timezone, period_start, period_end);

create table context_document_events (
  document_id integer not null references context_documents(id) on delete cascade,
  event_id integer not null references conversation_events(id) on delete restrict,
  primary key (document_id, event_id)
);

create table context_document_parents (
  document_id integer not null references context_documents(id) on delete cascade,
  parent_document_id integer not null references context_documents(id) on delete restrict,
  primary key (document_id, parent_document_id),
  check (document_id != parent_document_id)
);

create table context_jobs (
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
);
create index context_jobs_due_idx
  on context_jobs(status, not_before, lease_expires_at);

create table context_tombstones (
  id integer primary key,
  tombstone_key text not null unique,
  scope_type text not null check (scope_type in ('source', 'document', 'topic')),
  scope_id text not null,
  reason text not null check (reason in ('discord-deleted', 'locally-forgotten')),
  occurred_at integer not null,
  checksum text not null,
  unique (scope_type, scope_id)
);

create table context_deletion_requests (
  id text primary key,
  requester_id text not null,
  scope_type text not null check (scope_type in ('source', 'member', 'topic')),
  scope_id text not null,
  confirmation_checksum text not null,
  status text not null check (status in ('pending', 'confirmed', 'consumed', 'expired')),
  expires_at integer not null,
  created_at integer not null,
  consumed_at integer
);

create table context_forget_journal (
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
);
create index context_forget_journal_upload_idx
  on context_forget_journal(upload_status, next_attempt_at);

create table context_backfills (
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
);

create virtual table conversation_event_fts using fts5(
  content,
  content='',
  contentless_delete=1
);
create virtual table context_document_fts using fts5(
  content,
  content='',
  contentless_delete=1
);
create virtual table context_document_vectors using vec0(
  document_id integer primary key,
  embedding float[1536]
);
