-- name: databaseOpenChiefDatabaseSelectStatement :many
select vec_version();

-- name: recoveryVerifyRestorableDatabaseSelectStatement :many
select vec_version();

-- name: recoveryVerifyRestorableDatabaseSelectContextBackfills :many
select exists(
               select 1 from context_backfills b
               where b.page_count != (
                 select count(*) from context_backfill_pages p
                 where p.run_id = b.id
               )
             );

-- name: recoveryVerifyRestorableDatabaseSelectContextTombstones :many
select scope_type as scopeType, scope_id as scopeId, reason,
                occurred_at as occurredAt, checksum
         from context_tombstones;

-- name: recoveryScrubMemoriesSelectMemories2 :many
select state from memories where id = ?;

-- name: recoveryRecordContextJournalInsertContextTombstones :exec
insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, ?, ?, ?, ?, ?)
         on conflict(tombstone_key) do nothing;

-- name: recoveryRecordContextJournalInsertContextForgetJournal :exec
insert into context_forget_journal
           (journal_key, scope_id, tombstone_key, occurred_at, checksum,
            payload_json, upload_status, uploaded_at)
         values (?, ?, ?, ?, ?, ?, 'uploaded', ?)
         on conflict(journal_key) do update set
           upload_status = 'uploaded', uploaded_at = excluded.uploaded_at;

-- name: runtimeStartChiefSelectMemoryJobs :many
select
               count(*) filter (where status = 'failed') as failed,
               count(*) filter (where status in ('pending', 'leased')) as pending
             from memory_jobs;

-- name: runtimeCheckDatabaseInsertMaintenanceRuns :exec
insert into maintenance_runs (kind, started_at, completed_at, status)
           values ('health', ?, ?, 'completed');

-- name: runtimeCheckDatabaseDeleteMaintenanceRuns :exec
delete from maintenance_runs where kind = 'health';

-- name: runtimeCheckDatabaseSelectStatement :many
select vec_version();

-- name: runtimeCheckDatabaseSelectConversationEvents :many
select count(*) from conversation_events where 0;
