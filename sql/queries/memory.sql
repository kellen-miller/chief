-- name: memoryObserveSelectSourceEvents :one
select id, revision_checksum as revisionChecksum
           from source_events where platform_source_id = ?;

-- name: memoryObserveDeleteMemoryJobs :exec
delete from memory_jobs where source_event_id = ?;

-- name: memoryObserveSelectSourceEvents2 :many
select id from source_events where platform_source_id = ?;

-- name: memoryObserveInsertMemoryJobs :exec
insert into memory_jobs
               (source_event_id, revision_checksum, not_before)
             select ?, ?, ? where not exists (
               select 1 from memory_jobs
               where memory_jobs.source_event_id = ? and status in ('pending', 'leased')
             );

-- name: memoryLeaseNextJobSelectMemoryJobs :one
select id, source_event_id as sourceEventId, attempt_count as attemptCount
           from memory_jobs
           where not_before <= ?
             and (status = 'pending' or (status = 'leased' and lease_expires_at <= ?))
           order by id limit 1;

-- name: memoryLeaseNextJobUpdateMemoryJobs :exec
update memory_jobs set status = 'leased', lease_expires_at = ?,
             attempt_count = attempt_count + 1 where id = ?;

-- name: memoryNextJobDeadlineSelectMemoryJobs :many
select min(not_before) from memory_jobs
           where not_before <= ?
             and (status = 'pending'
               or (status = 'leased' and lease_expires_at <= ?));

-- name: memoryDeferForBudgetUpdateMemoryJobs :exec
update memory_jobs set status = 'pending', not_before = ?, lease_expires_at = null,
           attempt_count = max(0, attempt_count - 1) where id = ?;

-- name: memoryGetJobSourceSelectMemoryJobs :one
select s.id, s.content, s.medium, s.occurred_at as occurredAt,
                s.platform_source_id as platformSourceId,
                s.revision_checksum as revisionChecksum,
                s.can_moderate_context as canModerateContext,
                s.speaker_id as speakerId
         from memory_jobs j join source_events s on s.id = j.source_event_id
         where j.id = ?;

-- name: memoryCanRequesterForgetSelectMemories :many
select exists(
             select 1 from memories m join source_events s
               on s.id = m.source_event_id
             where m.id = ? and s.speaker_id = ?
           );

-- name: memoryRetryJobSelectMemoryJobs :many
select attempt_count from memory_jobs where id = ?;

-- name: memoryRetryJobUpdateMemoryJobs :exec
update memory_jobs set status = ?, not_before = ?, lease_expires_at = null
         where id = ?;

-- name: memoryRecordConflictInsertMemoryConflicts :exec
insert into memory_conflicts
           (left_memory_id, right_memory_id, created_at)
         values (?, ?, ?) on conflict(left_memory_id, right_memory_id) do nothing;

-- name: memoryApplyPreparedMutationBatchSelectSourceEvents :one
select revision_checksum as revisionChecksum,
                  source_scope_id as sourceScopeId
           from source_events where id = ?;

-- name: memoryApplyPreparedMutationBatchSelectMemoryJobs :many
select revision_checksum from memory_jobs
                 where id = ? and source_event_id = ?;

-- name: memoryApplyPreparedMutationBatchUpdateSourceEvents :exec
update source_events set extraction_status = 'completed'
             where id = ?;

-- name: memoryMaintainDeleteMemoryJobs :exec
delete from memory_jobs
           where status = 'completed' and source_event_id in (
             select id from source_events where retention_deadline <= ?
           );

-- name: memoryMaintainUpdateSourceEvents :exec
update source_events set content = ''
           where retention_deadline <= ? and content != '' and exists (
             select 1 from memories m where m.source_event_id = source_events.id
           );

-- name: memoryMaintainDeleteSourceEvents :exec
delete from source_events
           where retention_deadline <= ? and not exists (
             select 1 from memories m where m.source_event_id = source_events.id
           ) and not exists (
             select 1 from memory_jobs j where j.source_event_id = source_events.id
               and j.status != 'completed'
           );

-- name: memorySuppressSourceSelectSourceEvents :many
select id from source_events where platform_source_id = ?;

-- name: memorySuppressSourceDeleteSourceEvents :exec
delete from source_events where id = ?;

-- name: memoryDeleteSourceMemoriesSelectMemories :many
select id, state from memories where source_event_id = ?;

-- name: memoryDeleteSourceMemoriesDeleteMemories :exec
delete from memories where source_event_id = ?;

-- name: memoryCompleteJobUpdateMemoryJobs :exec
update memory_jobs set status = 'completed', lease_expires_at = null
         where id = ?;

-- name: memoryCompleteJobUpdateSourceEvents :exec
update source_events set extraction_status = 'completed'
         where source_events.id = (select source_event_id from memory_jobs where memory_jobs.id = ?);

-- name: memoryForgetSelectMemories :one
select source_event_id as sourceEventId, state
         from memories where id = ?;

-- name: memoryForgetDeleteMemories :exec
delete from memories where id = ?;

-- name: memoryForgetDeleteSourceEvents :exec
delete from source_events where source_events.id = ?
           and not exists (select 1 from memories where memories.source_event_id = ?)
           and not exists (
             select 1 from memory_jobs where memory_jobs.source_event_id = ? and status != 'completed'
           );

-- name: memoryInsertMemoryInsertMemories :exec
insert into memories
           (source_event_id, canonical_text, kind, confidence, provenance_json,
            state, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'active', ?, ?);

-- name: memorySupersedeUpdateMemories :exec
update memories set state = 'superseded', superseded_by = ?, updated_at = ?
         where id = ? and state = 'active';

-- name: memoryConsolidateExactDuplicatesSelectMemories :many
select lower(trim(canonical_text)) as normalized,
                group_concat(id) as ids
         from memories where state = 'active'
         group by normalized having count(*) > 1;

-- name: memoryConsolidateExactDuplicatesUpdateMemories :exec
update memories set state = 'superseded', superseded_by = ?,
                 updated_at = ? where id = ?;

-- name: memoryObserveInsertSourceEvents :exec
insert into source_events
             (platform_source_id, source_scope_id, revision_checksum,
              can_moderate_context, speaker_id, medium, content, occurred_at,
              retention_deadline)
           values (@platformSourceId, @sourceScopeId, @revisionChecksum,
                   @canModerateContext, @speakerId, @medium, @content,
                   @occurredAt, @retentionDeadline)
           on conflict(platform_source_id) do update set
             content = excluded.content,
             source_scope_id = excluded.source_scope_id,
             revision_checksum = excluded.revision_checksum,
             can_moderate_context = excluded.can_moderate_context,
             retention_deadline = excluded.retention_deadline;
