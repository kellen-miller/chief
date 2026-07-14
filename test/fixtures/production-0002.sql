create table schema_migrations (
  id text primary key,
  checksum text not null,
  applied_at integer not null
);

insert into schema_migrations (id, checksum, applied_at) values
  ('0001_initial', 'chief-0001-v3', 1),
  ('0002_conversation_events', 'chief-0002-v1', 2);

create table voice_sessions (
  id integer primary key,
  started_at integer not null,
  ended_at integer
);

create table source_events (
  id integer primary key,
  platform_source_id text not null unique,
  speaker_id text not null,
  medium text not null check (medium in ('text', 'voice')),
  content text not null,
  occurred_at integer not null,
  retention_deadline integer not null,
  voice_session_id integer references voice_sessions(id) on delete set null,
  extraction_status text not null default 'pending'
);

create table memory_jobs (
  id integer primary key,
  source_event_id integer references source_events(id) on delete cascade,
  voice_session_id integer references voice_sessions(id) on delete restrict,
  not_before integer not null,
  attempt_count integer not null default 0,
  lease_expires_at integer,
  status text not null default 'pending'
);

create table memories (
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

create virtual table memory_fts using fts5(canonical_text, content='memories', content_rowid='id');
create virtual table memory_vectors using vec0(memory_id integer primary key, embedding float[1536]);

create table memory_conflicts (
  id integer primary key,
  left_memory_id integer not null references memories(id) on delete cascade,
  right_memory_id integer not null references memories(id) on delete cascade,
  created_at integer not null,
  unique (left_memory_id, right_memory_id)
);

create table usage_ledger (
  id text primary key,
  operation text not null,
  reservation_usd real not null,
  actual_usd real,
  occurred_at integer not null,
  reconciled_at integer
);

create table maintenance_runs (
  id integer primary key,
  kind text not null,
  started_at integer not null,
  completed_at integer,
  status text not null
);

create table conversation_events (
  id integer primary key,
  platform_event_id text not null unique,
  request_id text,
  role text not null check (role in ('human', 'chief')),
  speaker_id text,
  speaker_name text,
  medium text not null check (medium in ('text', 'voice')),
  content text not null,
  occurred_at integer not null,
  retention_deadline integer not null
);

create index conversation_events_retention_idx
  on conversation_events(retention_deadline);
create index conversation_events_recent_idx
  on conversation_events(id desc);

insert into source_events
  (id, platform_source_id, speaker_id, medium, content, occurred_at,
   retention_deadline, extraction_status)
values
  (1, '1280000000000000001', 'president', 'text',
   'Project Marigold launches Friday', 100, 3000, 'pending');

insert into memory_jobs
  (id, source_event_id, not_before, attempt_count, status)
values (1, 1, 100, 0, 'pending');

insert into memories
  (id, source_event_id, canonical_text, kind, confidence, provenance_json,
   state, created_at, updated_at)
values
  (1, 1, 'Project Marigold launches Friday', 'plan', 0.95,
   '{"platformSourceId":"1280000000000000001"}', 'active', 100, 100);

insert into memory_fts (rowid, canonical_text)
values (1, 'Project Marigold launches Friday');

insert into usage_ledger
  (id, operation, reservation_usd, occurred_at)
values ('usage-pending', 'memory-extraction', 0.25, 100);

insert into conversation_events
  (id, platform_event_id, request_id, role, speaker_id, speaker_name, medium,
   content, occurred_at, retention_deadline)
values
  (1, 'discord:text:1280000000000000001', 'request-1', 'human', 'president',
   'President', 'text', 'What launches Friday?', 100, 700),
  (2, 'chief:request-1', 'request-1', 'chief', null, 'Chief', 'text',
   'Project Marigold launches Friday.', 110, 710);
