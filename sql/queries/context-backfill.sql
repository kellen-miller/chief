-- name: contextBackfillNextDeadlineSelectContextBackfills :many
select min(coalesce(b.activated_at, b.created_at))
           from context_backfills b
           where b.scope_id = ? and b.status = 'active'
             and (
               b.next_page_index is not null
               or exists(
                 select 1 from context_jobs j
                 where j.backfill_run_id = b.id and j.status = 'failed'
               )
               or not exists(
                 select 1 from context_jobs j
                 where j.backfill_run_id = b.id
                   and j.status in ('pending', 'leased')
               )
             );

-- name: contextBackfillRunNextSelectContextDocuments :many
select coalesce(max(revision), 0) from context_documents
                 where document_key = ?;

-- name: contextBackfillRunNextInsertContextBackfillSegments :exec
insert into context_backfill_segments
               (run_id, segment_key, page_index, period_start, period_end,
                source_checksum, source_count, document_id,
                actual_usage_usd, committed_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: contextBackfillActivateSelectContextBackfills :many
select id from context_backfills
         where scope_id = ? and status = 'ready'
         order by id desc limit 1;

-- name: contextBackfillActivateUpdateContextBackfills :exec
update context_backfills
         set status = 'active', maximum_usage_usd = ?, activated_at = ?,
             pause_reason = null, updated_at = ?
         where id = ? and status = 'ready';

-- name: contextBackfillDryRunSelectContextBackfills :one
select id, status from context_backfills
         where scope_id = ?
           and status in ('dry-run', 'ready', 'active', 'paused')
         order by id desc limit 1;

-- name: contextBackfillDryRunSelectUsageLedger :many
select exists(
               select 1 from usage_ledger
               where backfill_run_id = ? and actual_usd is null
             );

-- name: contextBackfillDryRunUpdateContextBackfills :exec
update context_backfills
             set status = 'failed', pause_reason = 'replaced', updated_at = ?
             where id = ?;

-- name: contextBackfillDryRunInsertContextBackfills :exec
insert into context_backfills
               (run_key, scope_id, status, created_at, updated_at)
             values (?, ?, 'dry-run', ?, ?);

-- name: contextBackfillResumeUpdateContextBackfills :exec
update context_backfills
         set status = 'active', pause_reason = null, updated_at = ?
         where id = ? and scope_id = ? and status = 'paused';

-- name: contextBackfillScanDryRunSelectContextBackfills :one
select cursor_source_id as cursorSourceId,
                page_count as pageCount
         from context_backfills
         where id = ? and scope_id = ? and status = 'dry-run';

-- name: contextBackfillRecordManifestPageSelectConversationEvents :many
select exists(
             select 1 from conversation_events
             where guild_id = ? and channel_id = ? and discord_message_id = ?
           );

-- name: contextBackfillRecordManifestPageInsertContextBackfillPages :exec
insert into context_backfill_pages
             (run_id, page_index, request_before_source_id,
              oldest_source_id, newest_source_id, eligible_count,
              eligible_bytes, eligible_tokens, identity_checksum)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: contextBackfillRecordManifestPageUpdateContextBackfills :exec
update context_backfills set
             cursor_source_id = ?, eligible_count = eligible_count + ?,
             already_ingested_count = already_ingested_count + ?,
             eligible_bytes = eligible_bytes + ?,
             eligible_tokens = eligible_tokens + ?, page_count = page_count + 1,
             oldest_source_id = case
               when oldest_source_id is null then ?
               when cast(? as integer) < cast(oldest_source_id as integer)
                 then ? else oldest_source_id end,
             newest_source_id = case
               when newest_source_id is null then ?
               when cast(? as integer) > cast(newest_source_id as integer)
                 then ? else newest_source_id end,
             oldest_occurred_at = case
               when ? is null then oldest_occurred_at
               when oldest_occurred_at is null then ?
               else min(oldest_occurred_at, ?) end,
             newest_occurred_at = case
               when ? is null then newest_occurred_at
               when newest_occurred_at is null then ?
               else max(newest_occurred_at, ?) end,
             updated_at = ? where id = ? and status = 'dry-run';

-- name: contextBackfillCompleteManifestSelectContextBackfillPages :many
select page_index as pageIndex,
                request_before_source_id as requestBeforeSourceId,
                oldest_source_id as oldestSourceId,
                newest_source_id as newestSourceId,
                eligible_count as eligibleCount,
                eligible_bytes as eligibleBytes,
                eligible_tokens as eligibleTokens,
                identity_checksum as identityChecksum
         from context_backfill_pages where run_id = ? order by page_index;

-- name: contextBackfillCompleteManifestSelectContextBackfills :many
select eligible_tokens from context_backfills where id = ?;

-- name: contextBackfillCompleteManifestUpdateContextBackfills :exec
update context_backfills
         set status = 'ready', cursor_source_id = null,
             next_page_index = ?, estimated_usage_usd = ?,
             manifest_checksum = ?, updated_at = ?
         where id = ? and status = 'dry-run';

-- name: contextBackfillManifestSeenIdsSelectContextBackfillPages :many
select request_before_source_id as requestBeforeSourceId
         from context_backfill_pages
         where run_id = ? order by page_index;

-- name: contextBackfillActiveRunSelectContextBackfills :one
select id as runId, next_page_index as nextPageIndex
           from context_backfills
           where scope_id = ? and status = 'active'
           order by activated_at, id limit 1;

-- name: contextBackfillPageSelectContextBackfillPages :one
select page_index as pageIndex,
                  request_before_source_id as requestBeforeSourceId,
                  oldest_source_id as oldestSourceId,
                  newest_source_id as newestSourceId,
                  completed_at as completedAt
           from context_backfill_pages
           where run_id = ? and page_index = ?;

-- name: contextBackfillSourceEligibleForRunSelectConversationEvents :one
select id, content_state as contentState,
                content_state_reason as contentStateReason,
                revision_checksum as revisionChecksum
         from conversation_events
         where guild_id = ? and channel_id = ? and discord_message_id = ?;

-- name: contextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentities :one
select first_page_index as firstPageIndex,
                revision_checksum as revisionChecksum
         from context_backfill_source_identities
         where run_id = ? and message_id = ? and event_id = ?;

-- name: contextBackfillSegmentCommittedSelectContextBackfillSegments :many
select source_checksum from context_backfill_segments
         where run_id = ? and segment_key = ?;

-- name: contextBackfillPriorAggregateDocumentSelectContextDocuments :many
select id, summary from context_documents
         where document_key = ? and tier = 'hourly'
           and period_start = ? and period_end = ? and timezone = ?
           and state = 'active' and content_state = 'available'
           and is_internal = 0
         order by revision desc limit 1;

-- name: contextBackfillExistingRevisionSelectConversationEvents :one
select occurred_at as occurredAt, edited_at as editedAt,
                  revision_checksum as revisionChecksum
           from conversation_events
           where guild_id = ? and channel_id = ? and discord_message_id = ?;

-- name: contextBackfillAssertSegmentCommitCurrentSelectContextBackfills :many
select exists(
           select 1 from context_backfills
           where id = ? and scope_id = ? and status = 'active'
             and next_page_index = ?
         );

-- name: contextBackfillInsertExpiredIdentitySelectConversationEvents :many
select id from conversation_events
         where guild_id = ? and channel_id = ? and discord_message_id = ?;

-- name: contextBackfillInsertExpiredIdentityInsertConversationEvents :exec
insert into conversation_events
             (platform_event_id, discord_message_id, guild_id, channel_id,
              request_id, logical_response_id, role, speaker_id, speaker_name,
              medium, reply_to_message_id, content,
              attachment_metadata_json, occurred_at, edited_at, deleted_at,
              recent_until, retention_deadline, content_state,
              content_state_reason, revision_checksum, response_chunk_index)
           values (?, ?, ?, ?, null, null, ?, ?, null, 'text', ?, '', '[]',
                   ?, ?, null, ?, ?, 'scrubbed', 'retention-expired', ?, null);

-- name: contextBackfillInsertExpiredIdentityInsertContextBackfillSourceIdentities :exec
insert into context_backfill_source_identities
           (run_id, message_id, event_id, first_page_index,
            revision_checksum, occurred_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(run_id, message_id) do nothing;

-- name: contextBackfillScheduleDailySelectContextDocuments :many
select id, revision from context_documents
         where tier = 'hourly' and completeness = 'final'
           and state = 'active' and content_state = 'available'
           and is_internal = 0 and period_start >= ? and period_end <= ?
         order by period_start, id;

-- name: contextBackfillScheduleDailyInsertContextJobs :exec
insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, source_document_ids_json, backfill_run_id)
         values (?, 'daily', ?, ?, ?, null, 'final', ?, ?, ?, '[]', ?)
         on conflict(job_key) do update set
           source_revision_checksum = excluded.source_revision_checksum,
           status = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then 'pending' else context_jobs.status end,
           not_before = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then excluded.not_before else context_jobs.not_before end,
           lease_expires_at = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then null else context_jobs.lease_expires_at end,
           usage_reservation_id = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then null else context_jobs.usage_reservation_id end,
           last_error_category = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then null else context_jobs.last_error_category end,
           backfill_run_id = case
             when excluded.backfill_run_id is not null
             then excluded.backfill_run_id
             when context_jobs.status = 'completed' then null
             else context_jobs.backfill_run_id end;

-- name: contextBackfillCompletePageUpdateContextBackfillPages :exec
update context_backfill_pages set completed_at = coalesce(completed_at, ?)
         where run_id = ? and page_index = ?;

-- name: contextBackfillCompletePageUpdateContextBackfills :exec
update context_backfills
         set next_page_index = case when ? < 0 then null else ? end,
             updated_at = ?
         where id = ? and status = 'active' and next_page_index = ?;

-- name: contextBackfillFinalizeRunSelectContextJobs :many
select count(*) from context_jobs
           where backfill_run_id = ? and status = 'failed';

-- name: contextBackfillFinalizeRunSelectContextJobs2 :many
select count(*) from context_jobs
           where backfill_run_id = ? and status in ('pending', 'leased');

-- name: contextBackfillFinalizeRunSelectUsageLedger :many
select count(*) from usage_ledger
           where backfill_run_id = ? and actual_usd is null;

-- name: contextBackfillFinalizeRunUpdateContextBackfills :exec
update context_backfills
         set status = 'completed', completed_at = ?, updated_at = ?
         where id = ? and status = 'active' and next_page_index is null;

-- name: contextBackfillPauseUpdateContextBackfills :exec
update context_backfills
         set status = 'paused', pause_reason = ?, updated_at = ?
         where id = ? and status = 'active';

-- name: contextBackfillRecoverOutstandingReservationsSelectUsageLedger :many
select id from usage_ledger
         where backfill_run_id = ? and actual_usd is null order by occurred_at;
