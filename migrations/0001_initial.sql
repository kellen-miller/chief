-- chief-legacy-checksum: chief-0001-v3
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
