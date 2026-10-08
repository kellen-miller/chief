CREATE TABLE voice_sessions (
  id integer primary key,
  started_at integer not null,
  ended_at integer
);

CREATE TABLE source_events (
  id integer primary key,
  platform_source_id text not null unique,
  speaker_id text not null,
  medium text not null check (medium in ('text', 'voice')),
  content text not null,
  occurred_at integer not null,
  retention_deadline integer not null,
  voice_session_id integer references voice_sessions(id) on delete set null,
  extraction_status text not null default 'pending',
  source_scope_id text not null default '',
  revision_checksum text not null default '',
  can_moderate_context integer not null default 0
    check (can_moderate_context in (0, 1))
);

CREATE TABLE memory_jobs (
  id integer primary key,
  source_event_id integer references source_events(id) on delete cascade,
  voice_session_id integer references voice_sessions(id) on delete restrict,
  not_before integer not null,
  attempt_count integer not null default 0,
  lease_expires_at integer,
  status text not null default 'pending',
  revision_checksum text not null default ''
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

CREATE VIRTUAL TABLE memory_fts using fts5(canonical_text, content='memories', content_rowid='id');

CREATE VIRTUAL TABLE memory_vectors using vec0(memory_id integer primary key, embedding float[1536]);

CREATE TABLE memory_conflicts (
  id integer primary key,
  left_memory_id integer not null references memories(id) on delete cascade,
  right_memory_id integer not null references memories(id) on delete cascade,
  created_at integer not null,
  unique (left_memory_id, right_memory_id)
);

CREATE TABLE maintenance_runs (
  id integer primary key,
  kind text not null,
  started_at integer not null,
  completed_at integer,
  status text not null
);
