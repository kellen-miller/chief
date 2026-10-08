-- chief-legacy-checksum: chief-0002-v1
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
