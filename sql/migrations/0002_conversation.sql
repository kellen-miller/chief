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
  ),
  revision_checksum text not null default '',
  response_chunk_index integer
    check (response_chunk_index is null or response_chunk_index >= 0),
  check (
    (content_state = 'available' and content_state_reason = 'retained')
    or (content_state = 'scrubbed' and content_state_reason != 'retained')
  ),
  unique (guild_id, channel_id, discord_message_id)
);

CREATE INDEX conversation_events_retention_idx
  on conversation_events(retention_deadline);

CREATE INDEX conversation_events_recent_idx
  on conversation_events(recent_until, id desc);

CREATE INDEX conversation_events_logical_response_idx
  on conversation_events(logical_response_id, id);

CREATE VIRTUAL TABLE conversation_event_fts using fts5(
  content,
  content='',
  contentless_delete=1
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

CREATE TABLE discord_reconciliation_seen (
  scope_id text not null,
  pass_key text not null,
  message_id text not null,
  observed_at integer not null,
  revision_checksum text not null,
  primary key (scope_id, pass_key, message_id)
);
