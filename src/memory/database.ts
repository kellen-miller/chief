import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const INITIAL_MIGRATION = `
create table schema_migrations (
  id text primary key,
  checksum text not null,
  applied_at integer not null
);

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
`;

const MIGRATION_ID = '0001_initial';
const MIGRATION_CHECKSUM = 'chief-0001-v3';

const CONVERSATION_MIGRATION = `
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
`;

const CHANNEL_CONTEXT_MIGRATION = `
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
`;

export const CHANNEL_CONTEXT_MIGRATION_ID = '0003_channel_context';
export const CHANNEL_CONTEXT_MIGRATION_CHECKSUM = 'chief-0003-v2';

const DISCORD_SOURCE_LIFECYCLE_MIGRATION = `
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
`;

export const DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID =
  '0004_discord_source_lifecycle';
export const DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM = 'chief-0004-v7';

const CONTEXT_FORGETTING_MIGRATION = `
alter table context_deletion_requests
  add column source_ids_json text not null default '[]';
alter table context_deletion_requests
  add column document_ids_json text not null default '[]';
alter table context_deletion_requests
  add column memory_ids_json text not null default '[]';
alter table context_deletion_requests
  add column request_source_id text not null default '';
alter table context_forget_journal
  add column payload_json text not null default '{}';
`;

export const CONTEXT_FORGETTING_MIGRATION_ID = '0005_context_forgetting';
export const CONTEXT_FORGETTING_MIGRATION_CHECKSUM = 'chief-0005-v4';

const CONTEXT_BACKFILL_MIGRATION = `
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
`;

export const CONTEXT_BACKFILL_MIGRATION_ID = '0006_context_backfill';
export const CONTEXT_BACKFILL_MIGRATION_CHECKSUM = 'chief-0006-v2';

const CONTEXT_BACKFILL_ACCOUNTING_MIGRATION = `
alter table context_jobs
  add column backfill_run_id integer references context_backfills(id)
    on delete restrict;
create index context_jobs_backfill_run_idx
  on context_jobs(backfill_run_id, status, not_before);
`;

export const CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID =
  '0007_context_backfill_accounting';
export const CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM = 'chief-0007-v1';

const CONTEXT_BACKFILL_LIFECYCLE_MIGRATION = `select 1;`;

export const CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID =
  '0008_context_backfill_lifecycle';
export const CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM = 'chief-0008-v1';

const CONTEXT_BACKFILL_TARGETING_MIGRATION = `select 1;`;

export const CONTEXT_BACKFILL_TARGETING_MIGRATION_ID =
  '0009_context_backfill_targeting';
export const CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM = 'chief-0009-v1';

const CONTEXT_BACKFILL_OWNERSHIP_MIGRATION = `select 1;`;

export const CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID =
  '0010_context_backfill_ownership';
export const CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM = 'chief-0010-v1';

interface Migration {
  readonly checksum: string;
  readonly id: string;
  readonly migrate?: (database: Database.Database) => void;
  readonly sql: string;
  readonly validate?: (database: Database.Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    checksum: MIGRATION_CHECKSUM,
    id: MIGRATION_ID,
    sql: INITIAL_MIGRATION.replace(
      /create table schema_migrations[\s\S]*?;\n/u,
      '',
    ),
  },
  {
    checksum: 'chief-0002-v1',
    id: '0002_conversation_events',
    sql: CONVERSATION_MIGRATION,
  },
  {
    checksum: CHANNEL_CONTEXT_MIGRATION_CHECKSUM,
    id: CHANNEL_CONTEXT_MIGRATION_ID,
    sql: CHANNEL_CONTEXT_MIGRATION,
    validate: assertContentlessDeleteSupport,
  },
  {
    checksum: DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM,
    id: DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID,
    sql: DISCORD_SOURCE_LIFECYCLE_MIGRATION,
  },
  {
    checksum: CONTEXT_FORGETTING_MIGRATION_CHECKSUM,
    id: CONTEXT_FORGETTING_MIGRATION_ID,
    migrate: backfillContextForgetJournals,
    sql: CONTEXT_FORGETTING_MIGRATION,
  },
  {
    checksum: CONTEXT_BACKFILL_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_MIGRATION_ID,
    sql: CONTEXT_BACKFILL_MIGRATION,
  },
  {
    checksum: CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID,
    sql: CONTEXT_BACKFILL_ACCOUNTING_MIGRATION,
  },
  {
    checksum: CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID,
    migrate: guardLegacyBackfillAccounting,
    sql: CONTEXT_BACKFILL_LIFECYCLE_MIGRATION,
  },
  {
    checksum: CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_TARGETING_MIGRATION_ID,
    migrate: targetLegacyBackfillAccounting,
    sql: CONTEXT_BACKFILL_TARGETING_MIGRATION,
  },
  {
    checksum: CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID,
    migrate: repairBackfillOwnership,
    sql: CONTEXT_BACKFILL_OWNERSHIP_MIGRATION,
  },
];

export function openChiefDatabase(path: string): Database.Database {
  const database = new Database(path);
  sqliteVec.load(database);
  const vectorVersion = database.prepare('select vec_version()').pluck().get();
  if (vectorVersion !== 'v0.1.9') {
    database.close();
    throw new Error(`unsupported sqlite-vec version: ${String(vectorVersion)}`);
  }
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  database.pragma('temp_store = MEMORY');
  return database;
}

export function migrateChiefDatabase(
  database: Database.Database,
  throughMigrationId?: string,
): void {
  if (
    throughMigrationId !== undefined &&
    !MIGRATIONS.some(({ id }) => id === throughMigrationId)
  ) {
    throw new Error(`unknown migration target: ${throughMigrationId}`);
  }
  database.exec(
    'create table if not exists schema_migrations (id text primary key, checksum text not null, applied_at integer not null)',
  );
  for (const migration of MIGRATIONS) {
    const applied = database
      .prepare('select checksum from schema_migrations where id = ?')
      .get(migration.id) as { checksum: string } | undefined;
    if (applied !== undefined) {
      if (applied.checksum !== migration.checksum) {
        throw new Error(`migration checksum mismatch for ${migration.id}`);
      }
    } else {
      database.transaction(() => {
        database.exec(migration.sql);
        migration.migrate?.(database);
        migration.validate?.(database);
        database
          .prepare(
            'insert into schema_migrations (id, checksum, applied_at) values (?, ?, ?)',
          )
          .run(migration.id, migration.checksum, Date.now());
      })();
    }
    if (migration.id === throughMigrationId) break;
  }
}

function guardLegacyBackfillAccounting(database: Database.Database): void {
  const unfinishedRunIds = database
    .prepare(
      `select id from context_backfills
       where status in ('active', 'paused')
       order by id desc`,
    )
    .pluck()
    .all() as number[];
  const guardRunId = unfinishedRunIds[0];
  if (guardRunId === undefined) return;

  const now = Date.now();
  database
    .prepare(
      `update context_backfills
       set status = 'failed',
           pause_reason = 'migration-accounting-rebuild-required',
           updated_at = ?
       where status in ('active', 'paused') and id != ?`,
    )
    .run(now, guardRunId);
  database
    .prepare(
      `update context_backfills
       set status = 'paused',
           pause_reason = 'migration-accounting-resume-required',
           updated_at = ?
       where id = ? and status in ('active', 'paused')`,
    )
    .run(now, guardRunId);
  database
    .prepare(
      `update context_jobs set backfill_run_id = ?
       where backfill_run_id is null and status in ('pending', 'leased')`,
    )
    .run(guardRunId);
  database
    .prepare(
      `update usage_ledger set backfill_run_id = ?
       where actual_usd is null and backfill_run_id is null
         and id in (
           select usage_reservation_id from context_jobs
           where backfill_run_id = ? and usage_reservation_id is not null
         )`,
    )
    .run(guardRunId, guardRunId);
}

interface LegacyContextJobRow {
  readonly backfillRunId: number | null;
  readonly id: number;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly reservationOccurredAt: number | null;
  readonly sourceDocumentIdsJson: string;
  readonly tier: string;
  readonly usageReservationId: string | null;
}

function targetLegacyBackfillAccounting(database: Database.Database): void {
  const accountingAppliedAt = database
    .prepare('select applied_at from schema_migrations where id = ?')
    .pluck()
    .get(CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID) as number;
  const jobs = database
    .prepare(
      `select j.id, j.tier, j.period_start as periodStart,
              j.period_end as periodEnd,
              j.source_document_ids_json as sourceDocumentIdsJson,
              j.usage_reservation_id as usageReservationId,
              j.backfill_run_id as backfillRunId,
              l.occurred_at as reservationOccurredAt
       from context_jobs j
       left join usage_ledger l on l.id = j.usage_reservation_id
       where j.status in ('pending', 'leased')`,
    )
    .all() as LegacyContextJobRow[];
  const recoveredRunIds = new Set<number>();

  for (const job of jobs) {
    const createdAfterAccounting =
      job.reservationOccurredAt !== null &&
      job.reservationOccurredAt > accountingAppliedAt;
    const provableRunIds = createdAfterAccounting
      ? []
      : provableBackfillRunIds(database, job, accountingAppliedAt);
    const targetRunId = provableRunIds[0];
    if (targetRunId !== undefined) {
      database
        .prepare('update context_jobs set backfill_run_id = ? where id = ?')
        .run(targetRunId, job.id);
      if (job.usageReservationId !== null) {
        database
          .prepare(
            `update usage_ledger set backfill_run_id = ?
             where id = ? and actual_usd is null`,
          )
          .run(targetRunId, job.usageReservationId);
      }
      recoveredRunIds.add(targetRunId);
      continue;
    }

    if (
      job.backfillRunId !== null &&
      migrationGuardedRun(database, job.backfillRunId)
    ) {
      if (job.usageReservationId !== null) {
        database
          .prepare(
            `update usage_ledger set backfill_run_id = null
             where id = ? and actual_usd is null
               and backfill_run_id = ?`,
          )
          .run(job.usageReservationId, job.backfillRunId);
      }
      database
        .prepare('update context_jobs set backfill_run_id = null where id = ?')
        .run(job.id);
    }
  }

  const now = Date.now();
  const recover = database.prepare(
    `update context_backfills
     set status = 'paused', completed_at = null,
         pause_reason = 'migration-accounting-resume-required',
         updated_at = ?
     where id = ? and (
       status in ('active', 'paused', 'completed')
       or pause_reason = 'migration-accounting-rebuild-required'
     )`,
  );
  for (const runId of recoveredRunIds) recover.run(now, runId);
}

function provableBackfillRunIds(
  database: Database.Database,
  job: LegacyContextJobRow,
  accountingAppliedAt: number,
): number[] {
  const runIds = database
    .prepare(
      `select distinct s.run_id
       from context_backfill_segments s
       join context_backfills b on b.id = s.run_id
       where b.created_at <= ? and s.committed_at <= ?
       order by s.run_id desc`,
    )
    .pluck()
    .all(accountingAppliedAt, accountingAppliedAt) as number[];
  return runIds.filter((runId) => {
    if (
      (job.tier === 'daily' || job.tier === 'weekly') &&
      job.periodEnd !== null &&
      database
        .prepare(
          `select exists(
             select 1 from context_backfill_segments
             where run_id = ? and period_start >= ? and period_end <= ?
           )`,
        )
        .pluck()
        .get(runId, job.periodStart, job.periodEnd) === 1
    ) {
      return true;
    }
    return legacySourceDocumentIds(job.sourceDocumentIdsJson).some(
      (documentId) => documentDescendsFromRun(database, documentId, runId),
    );
  });
}

function legacySourceDocumentIds(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is number => Number.isSafeInteger(item) && item > 0,
    );
  } catch {
    return [];
  }
}

function documentDescendsFromRun(
  database: Database.Database,
  documentId: number,
  runId: number,
): boolean {
  return (
    database
      .prepare(
        `with recursive ancestry(id) as (
           select ?
           union
           select p.parent_document_id
           from context_document_parents p
           join ancestry a on a.id = p.document_id
         )
         select exists(
           select 1 from ancestry a
           join context_backfill_segments s on s.document_id = a.id
           where s.run_id = ?
         )`,
      )
      .pluck()
      .get(documentId, runId) === 1
  );
}

function migrationGuardedRun(
  database: Database.Database,
  runId: number,
): boolean {
  return (
    database
      .prepare(
        `select exists(
           select 1 from context_backfills where id = ? and pause_reason in (
             'migration-accounting-resume-required',
             'migration-accounting-rebuild-required'
           )
         )`,
      )
      .pluck()
      .get(runId) === 1
  );
}

interface OwnershipContextJobRow {
  readonly backfillRunId: number | null;
  readonly id: number;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly sourceDocumentIdsJson: string;
  readonly sourceRevisionChecksum: string;
  readonly tier: string;
  readonly usageReservationId: string | null;
}

function repairBackfillOwnership(database: Database.Database): void {
  const jobs = database
    .prepare(
      `select id, tier, period_start as periodStart, period_end as periodEnd,
              source_revision_checksum as sourceRevisionChecksum,
              source_document_ids_json as sourceDocumentIdsJson,
              usage_reservation_id as usageReservationId,
              backfill_run_id as backfillRunId
       from context_jobs where status in ('pending', 'leased')`,
    )
    .all() as OwnershipContextJobRow[];
  const recoveredRunIds = new Set<number>();
  const assignJob = database.prepare(
    'update context_jobs set backfill_run_id = ? where id = ?',
  );
  const assignReservation = database.prepare(
    `update usage_ledger set backfill_run_id = ?
     where id = ? and actual_usd is null`,
  );

  for (const job of jobs) {
    const provenRunIds = exactBackfillRunIds(database, job);
    const targetRunId =
      job.backfillRunId !== null && provenRunIds.includes(job.backfillRunId)
        ? job.backfillRunId
        : provenRunIds[0];
    if (targetRunId !== undefined) {
      assignJob.run(targetRunId, job.id);
      if (job.usageReservationId !== null) {
        assignReservation.run(targetRunId, job.usageReservationId);
      }
      recoveredRunIds.add(targetRunId);
      continue;
    }

    assignJob.run(null, job.id);
  }

  const now = Date.now();
  const recover = database.prepare(
    `update context_backfills
     set status = 'paused', completed_at = null,
         pause_reason = 'migration-accounting-resume-required',
         updated_at = ?
     where id = ? and (
       status in ('active', 'paused', 'completed')
       or pause_reason in (
         'migration-accounting-resume-required',
         'migration-accounting-rebuild-required'
       )
     )`,
  );
  for (const runId of recoveredRunIds) recover.run(now, runId);
}

function exactBackfillRunIds(
  database: Database.Database,
  job: OwnershipContextJobRow,
): number[] {
  if (job.tier === 'hourly') {
    return exactHourlyBackfillRunIds(database, job);
  }
  const documentIds = exactJobDocumentIds(database, job);
  if (documentIds.length === 0) return [];
  const runIds = database
    .prepare(
      `select distinct run_id from context_backfill_segments
       order by run_id desc`,
    )
    .pluck()
    .all() as number[];
  return runIds.filter((runId) =>
    documentIds.some((documentId) =>
      documentDescendsFromRun(database, documentId, runId),
    ),
  );
}

function exactJobDocumentIds(
  database: Database.Database,
  job: OwnershipContextJobRow,
): number[] {
  if (job.tier === 'long-term') {
    const documentIds = [
      ...new Set(legacySourceDocumentIds(job.sourceDocumentIdsJson)),
    ];
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `select id, revision from context_documents
         where id in (${placeholders}) order by id`,
      )
      .all(...documentIds) as {
      readonly id: number;
      readonly revision: number;
    }[];
    return rows.length === documentIds.length &&
      migrationDigest(rows) === job.sourceRevisionChecksum
      ? rows.map(({ id }) => id)
      : [];
  }
  const childTier = job.tier === 'daily' ? 'hourly' : 'daily';
  if (job.tier !== 'daily' && job.tier !== 'weekly') return [];
  if (job.periodEnd === null) return [];
  const rows = database
    .prepare(
      `select id, revision from context_documents
       where tier = ? and completeness = 'final' and state = 'active'
         and content_state = 'available' and is_internal = 0
         and period_start >= ? and period_end <= ?
       order by period_start, id`,
    )
    .all(childTier, job.periodStart, job.periodEnd) as {
    readonly id: number;
    readonly revision: number;
  }[];
  if (rows.length === 0) return [];
  const revisionRows = rows.map(({ id, revision }) => ({ id, revision }));
  const legacyIdOrderedRows = [...revisionRows].sort(
    (left, right) => left.id - right.id,
  );
  return migrationDigest(revisionRows) === job.sourceRevisionChecksum ||
    migrationDigest(legacyIdOrderedRows) === job.sourceRevisionChecksum
    ? rows.map(({ id }) => id)
    : [];
}

function exactHourlyBackfillRunIds(
  database: Database.Database,
  job: OwnershipContextJobRow,
): number[] {
  if (job.periodEnd === null) return [];
  const runs = database
    .prepare(
      `select distinct b.id as runId, b.scope_id as scopeId
       from context_backfills b
       join context_backfill_pages p on p.run_id = b.id
       order by b.id desc`,
    )
    .all() as { readonly runId: number; readonly scopeId: string }[];
  return runs.flatMap(({ runId, scopeId }) => {
    const rows = database
      .prepare(
        `select id, discord_message_id as discordMessageId, content,
                edited_at as editedAt
         from conversation_events
         where guild_id || '/' || channel_id = ? and medium = 'text'
           and content_state = 'available'
           and occurred_at >= ? and occurred_at < ?
         order by id`,
      )
      .all(scopeId, job.periodStart, job.periodEnd) as {
      readonly content: string;
      readonly discordMessageId: string;
      readonly editedAt: number | null;
      readonly id: number;
    }[];
    if (
      rows.length === 0 ||
      migrationDigest(rows) !== job.sourceRevisionChecksum
    ) {
      return [];
    }
    const containsSource = database.prepare(
      `select exists(
         select 1 from context_backfill_pages
         where run_id = ? and cast(? as integer) between
           min(cast(oldest_source_id as integer),
               cast(newest_source_id as integer)) and
           max(cast(oldest_source_id as integer),
               cast(newest_source_id as integer))
       )`,
    );
    return rows.some(
      ({ discordMessageId }) =>
        containsSource.pluck().get(runId, discordMessageId) === 1,
    )
      ? [runId]
      : [];
  });
}

function migrationDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function backfillContextForgetJournals(database: Database.Database): void {
  const rows = database
    .prepare(
      `select journal_key as journalKey, occurred_at as occurredAt,
              scope_id as scopeId, tombstone_key as tombstoneKey,
              coalesce(
                (select t.reason from context_tombstones t
                 where t.tombstone_key = context_forget_journal.tombstone_key
                   and t.reason in ('discord-deleted', 'locally-forgotten')),
                (select c.content_state_reason from conversation_events c
                 where c.guild_id || '/' || c.channel_id || '/' ||
                       c.discord_message_id = context_forget_journal.scope_id
                   and c.content_state_reason in (
                     'discord-deleted', 'locally-forgotten'
                   )
                 order by c.id desc limit 1),
                'locally-forgotten'
              ) as reason
       from context_forget_journal where payload_json = '{}'`,
    )
    .all() as {
    journalKey: string;
    occurredAt: number;
    reason: 'discord-deleted' | 'locally-forgotten';
    scopeId: string;
    tombstoneKey: string;
  }[];
  const update = database.prepare(
    `update context_forget_journal
     set payload_json = ?, checksum = ? where journal_key = ?`,
  );
  for (const row of rows) {
    const payload = {
      documentIds: [] as number[],
      documentKeys: [] as string[],
      memoryIds: [] as number[],
      reason: row.reason,
      sourceScopeIds: [row.scopeId],
      tombstoneKeys: [row.tombstoneKey],
    };
    const checksum = createHash('sha256')
      .update(
        JSON.stringify({
          journalKey: row.journalKey,
          occurredAt: row.occurredAt,
          payload,
        }),
      )
      .digest('hex');
    update.run(JSON.stringify(payload), checksum, row.journalKey);
  }
}

export function verifyContextDatabaseSchema(
  database: Database.Database,
): boolean {
  try {
    const checksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CHANNEL_CONTEXT_MIGRATION_ID);
    if (checksum !== CHANNEL_CONTEXT_MIGRATION_CHECKSUM) return false;
    const lifecycleChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID);
    if (lifecycleChecksum !== DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM) {
      return false;
    }
    const forgettingChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_FORGETTING_MIGRATION_ID);
    if (forgettingChecksum !== CONTEXT_FORGETTING_MIGRATION_CHECKSUM) {
      return false;
    }
    const backfillChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_MIGRATION_ID);
    if (backfillChecksum !== CONTEXT_BACKFILL_MIGRATION_CHECKSUM) return false;
    const accountingChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID);
    if (accountingChecksum !== CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM) {
      return false;
    }
    const backfillLifecycleChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID);
    if (
      backfillLifecycleChecksum !==
      CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const backfillTargetingChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_TARGETING_MIGRATION_ID);
    if (
      backfillTargetingChecksum !==
      CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const backfillOwnershipChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID);
    if (
      backfillOwnershipChecksum !==
      CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    for (const table of [
      'conversation_event_fts',
      'context_document_fts',
      'context_document_vectors',
      'context_backfill_pages',
      'context_backfill_segments',
      'context_backfill_source_identities',
      'discord_reconciliation_state',
      'discord_reconciliation_seen',
    ]) {
      database.prepare(`select count(*) from ${table} where 0`).pluck().get();
    }
    return true;
  } catch {
    return false;
  }
}

function assertContentlessDeleteSupport(database: Database.Database): void {
  const table = '__chief_contentless_delete_test';
  try {
    database.exec(
      `create virtual table temp.${table} using fts5(
         content, content='', contentless_delete=1
       );
       insert into ${table} (rowid, content) values (1, 'test');
       delete from ${table} where rowid = 1;`,
    );
    const remaining = database
      .prepare(`select count(*) from ${table}`)
      .pluck()
      .get();
    if (remaining !== 0) {
      throw new Error('SQLite FTS5 contentless delete is unavailable');
    }
  } finally {
    database.exec(`drop table if exists temp.${table}`);
  }
}
