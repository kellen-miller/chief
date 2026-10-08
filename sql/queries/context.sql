-- name: contextActivateDocumentRevisionSelectContextDocuments :many
select max(revision) from context_documents where document_key = ?;

-- name: contextActivateDocumentRevisionSelectContextDocuments2 :many
select id from context_documents
           where document_key = ? and state = 'active';

-- name: contextActivateDocumentRevisionUpdateContextDocuments :exec
update context_documents
           set state = 'superseded', updated_at = ?
           where document_key = ? and state = 'active';

-- name: contextActivateDocumentRevisionInsertContextDocumentEvents :exec
insert into context_document_events (document_id, event_id)
         values (?, ?);

-- name: contextActivateDocumentRevisionInsertContextDocumentParents :exec
insert into context_document_parents
           (document_id, parent_document_id)
         values (?, ?);

-- name: contextAssertInputsAvailableSelectContextJobs :many
select exists(
             select 1 from context_jobs
             where tier = 'hourly' and period_start = ? and period_end = ?
               and timezone = ? and source_revision_checksum = ?
           );

-- name: contextAssertInputsAvailableSelectConversationEvents :many
select exists(
         select 1 from conversation_events
         where id = ? and (
           content_state = 'available'
           or (? = 1 and content_state = 'scrubbed'
               and content_state_reason = 'retention-expired')
         )
       );

-- name: contextAssertInputsAvailableSelectConversationEvents2 :many
select guild_id || '/' || channel_id || '/' ||
                        discord_message_id
                 from conversation_events where id = ?;

-- name: contextAssertInputsAvailableSelectContextDocuments :many
select exists(
         select 1 from context_documents
         where id = ? and state = 'active' and content_state = 'available'
       );

-- name: contextAssertInputsAvailableSelectContextDocuments2 :many
select exists(
           select 1 from context_documents
           where id = ? and completeness = 'final'
         );

-- name: channelContextRecordDeliveredReplySelectConversationEvents :many
select min(occurred_at) from conversation_events
           where guild_id = ? and channel_id = ?
             and logical_response_id = ?;

-- name: channelContextRecordDeliveredReplyUpdateConversationEvents :exec
update conversation_events set
                 request_id = case when logical_response_id is null
                                   then ? else request_id end,
                 reply_to_message_id = case when logical_response_id is null
                                            then ? else reply_to_message_id end,
                 logical_response_id = coalesce(logical_response_id, ?),
                 response_chunk_index = ?,
                 platform_event_id = ?
               where id = ? and role = 'chief';

-- name: channelContextMaintainSelectConversationEvents :many
select id from conversation_events
           where medium = 'text' and content_state = 'available'
             and retention_deadline <= ?;

-- name: channelContextMaintainSelectContextDocuments :many
select id from context_documents
           where content_state = 'available' and retention_deadline <= ?;

-- name: channelContextMaintainDeleteContextDeletionRequests :exec
delete from context_deletion_requests
           where status = 'pending' and expires_at <= ?;

-- name: channelContextNextDeadlineSelectContextJobs :many
select min(freshness_deadline) from context_jobs
           where not_before <= ?
             and (status = 'pending'
               or (status = 'leased' and lease_expires_at <= ?)
               or (status = 'failed' and last_error_category = 'provider'))
             and not exists(
               select 1 from context_accounting_holds h
               where h.job_id = context_jobs.id
             )
             and (backfill_run_id is null or exists(
               select 1 from context_backfills b
               where b.id = context_jobs.backfill_run_id
                 and b.status = 'active'
             ));

-- name: channelContextStatusSelectContextBackfills :many
select status, count(*) as count from context_backfills
         where status in ('active', 'failed', 'paused') group by status;

-- name: channelContextStatusSelectContextJobs :many
select count(*) from context_jobs
           where status in ('pending', 'leased');

-- name: channelContextStatusSelectContextJobs2 :many
select count(*) from context_jobs where status = 'failed';

-- name: channelContextStatusSelectContextAccountingHolds :many
select exists(select 1 from context_accounting_holds);

-- name: channelContextStatusSelectContextJobs3 :many
select min(freshness_deadline) from context_jobs
             where tier = ? and status != 'completed'
               and freshness_deadline <= ?;

-- name: channelContextStatusSelectContextJobs4 :one
select last_error_category as error
         from context_jobs
         where status != 'completed' and freshness_deadline <= ?
         order by freshness_deadline, id limit 1;

-- name: channelContextStatusSelectContextForgetJournal :many
select exists(
             select 1 from context_forget_journal
             where upload_status in ('pending', 'failed')
           );

-- name: channelContextRunNextUpdateContextJobs :exec
update context_jobs set usage_reservation_id = null where id = ?;

-- name: channelContextRunNextUpdateContextJobs2 :exec
update context_jobs set usage_reservation_id = ? where id = ?;

-- name: channelContextRunNextUpdateContextJobs3 :exec
update context_jobs set usage_reservation_id = null
             where id = ? and usage_reservation_id = ?;

-- name: channelContextRunNextSelectContextDocuments :many
select max(revision) from context_documents
               where document_key = ?;

-- name: channelContextRunNextSelectContextDocuments2 :many
select id from context_documents
             where document_key = ? and state = 'active';

-- name: channelContextRunNextSelectContextDocuments3 :many
select max(revision) from context_documents
                 where document_key = ?;

-- name: channelContextRunNextUpdateContextJobs4 :exec
update context_jobs
             set status = 'completed', lease_expires_at = null,
                 usage_reservation_id = null, last_error_category = null
             where id = ?;

-- name: channelContextRunNextUpdateContextJobs5 :exec
update context_jobs set usage_reservation_id = null
           where id = ? and usage_reservation_id = ?;

-- name: channelContextLeaseNextJobSelectContextJobs :one
select id, job_key as jobKey, tier, period_start as periodStart,
                  period_end as periodEnd, timezone as timeZone,
                  topic_key as topicKey, topic_label as topicLabel,
                  source_document_ids_json as sourceDocumentIdsJson,
                  usage_reservation_id as usageReservationId,
                  completeness,
                  source_revision_checksum as sourceRevisionChecksum,
                  attempt_count as attemptCount,
                  backfill_run_id as backfillRunId
           from context_jobs
           where not_before <= ?
             and (status = 'pending'
               or (status = 'leased' and lease_expires_at <= ?)
               or (status = 'failed' and last_error_category = 'provider'))
             and not exists(
               select 1 from context_accounting_holds h
               where h.job_id = context_jobs.id
             )
             and (backfill_run_id is null or exists(
               select 1 from context_backfills b
               where b.id = context_jobs.backfill_run_id
                 and b.status = 'active'
             ))
           order by freshness_deadline, id limit 1;

-- name: channelContextLeaseNextJobUpdateContextJobs :exec
update context_jobs
           set status = 'leased', lease_expires_at = ?,
               attempt_count = attempt_count + 1
           where id = ?;

-- name: channelContextJobSourcesSelectConversationEvents :many
select 'event:' || id as id, content as text
           from conversation_events
           where guild_id = ? and channel_id = ? and medium = 'text'
             and content_state = 'available'
             and occurred_at >= ? and occurred_at < ?
           order by occurred_at, id;

-- name: channelContextJobSourcesSelectContextDocuments :many
select 'document:' || id as id, summary as text
           from context_documents
           where tier = ? and completeness = 'final' and state = 'active'
             and content_state = 'available' and is_internal = 0
             and period_start >= ? and period_end <= ?
           order by period_start, id;

-- name: channelContextJobSourcesSelectContextDocuments2 :many
select id from context_documents
         where tier = 'long-term' and topic_key = ? and state = 'active'
           and content_state = 'available' and is_internal = 0;

-- name: channelContextCompleteEmptyJobUpdateContextJobs :exec
update context_jobs
         set status = 'completed', lease_expires_at = null,
             usage_reservation_id = null, last_error_category = null
         where id = ?;

-- name: channelContextProvisionalObsoleteSelectContextDocuments :many
select exists(
             select 1 from context_documents
             where document_key = ? and completeness = 'final'
               and state = 'active' and is_internal = 0
           );

-- name: channelContextDeferJobUpdateContextJobs :exec
update context_jobs
         set status = 'pending', not_before = ?, lease_expires_at = null,
             usage_reservation_id = null,
             attempt_count = max(0, attempt_count - 1),
             last_error_category = ?
         where id = ?;

-- name: channelContextRetryJobUpdateContextJobs :exec
update context_jobs
         set status = ?, not_before = ?, lease_expires_at = null,
             usage_reservation_id = null, last_error_category = ?
         where id = ? and status = 'leased'
           and source_revision_checksum = ? and attempt_count = ?;

-- name: channelContextAssertCurrentLeaseSelectContextJobs :many
select exists(
           select 1 from context_jobs
           where id = ? and status = 'leased' and lease_expires_at > ?
             and attempt_count = ? and source_revision_checksum = ?
             and usage_reservation_id = ?
         );

-- name: channelContextScheduleDownstreamSelectContextDocuments :many
select distinct topic_key as topicKey, topic_label as topicLabel
           from context_documents
           where tier = 'long-term' and state = 'active'
             and content_state = 'available' and topic_key is not null
             and topic_label is not null;

-- name: channelContextDocumentRevisionChecksumSelectContextDocuments :many
select id, revision from context_documents
         where tier = ? and completeness = 'final' and state = 'active'
           and content_state = 'available' and is_internal = 0
           and period_start >= ? and period_end <= ?
         order by period_start, id;

-- name: channelContextUpsertDerivedJobInsertContextJobs :exec
insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, backfill_run_id)
         values (?, ?, ?, ?, ?, null, 'final', ?, ?, ?, ?)
         on conflict(job_key) do update set
           source_revision_checksum = excluded.source_revision_checksum,
           not_before = excluded.not_before,
           freshness_deadline = excluded.freshness_deadline,
           status = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then 'pending' else context_jobs.status end,
           lease_expires_at = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.lease_expires_at end,
           last_error_category = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.last_error_category end,
           backfill_run_id = case
             when excluded.backfill_run_id is not null
             then excluded.backfill_run_id
             when context_jobs.backfill_run_id is not null
               and not exists(
                 select 1 from context_backfills b
                 where b.id = context_jobs.backfill_run_id
                   and b.status = 'active'
               )
             then null
             when context_jobs.status = 'completed' then null
             else context_jobs.backfill_run_id end;

-- name: channelContextUpsertTopicJobSelectContextDocuments :many
select id from context_documents
         where tier = 'long-term' and topic_key = ? and state = 'active'
           and content_state = 'available';

-- name: channelContextUpsertTopicJobInsertContextJobs :exec
insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            topic_label, completeness, source_revision_checksum,
            source_document_ids_json, not_before, freshness_deadline,
            backfill_run_id)
         values (?, 'long-term', ?, null, ?, ?, ?, 'final', ?, ?, ?, ?, ?)
         on conflict(job_key) do update set
           topic_label = excluded.topic_label,
           source_revision_checksum = excluded.source_revision_checksum,
           source_document_ids_json = excluded.source_document_ids_json,
           not_before = excluded.not_before,
           freshness_deadline = excluded.freshness_deadline,
           status = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then 'pending' else context_jobs.status end,
           lease_expires_at = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.lease_expires_at end,
           last_error_category = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.last_error_category end,
           backfill_run_id = case
             when excluded.backfill_run_id is not null
             then excluded.backfill_run_id
             when context_jobs.backfill_run_id is not null
               and not exists(
                 select 1 from context_backfills b
                 where b.id = context_jobs.backfill_run_id
                   and b.status = 'active'
               )
             then null
             when context_jobs.status = 'completed' then null
             else context_jobs.backfill_run_id end;

-- name: channelContextApplyUpsertSelectConversationEvents :one
select content, content_state as contentState,
                occurred_at as occurredAt
         from conversation_events where id = ?;

-- name: channelContextUpsertJobInsertContextJobs :exec
insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, backfill_run_id)
         values (?, 'hourly', ?, ?, ?, null, ?, ?, ?, ?, ?)
         on conflict(job_key) do update set
           source_revision_checksum = excluded.source_revision_checksum,
           not_before = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
               and context_jobs.completeness = 'provisional'
               and context_jobs.status = 'pending'
             then min(context_jobs.not_before, excluded.not_before)
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then excluded.not_before else context_jobs.not_before end,
           freshness_deadline = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
               and context_jobs.completeness = 'provisional'
               and context_jobs.status = 'pending'
             then min(context_jobs.freshness_deadline,
                      excluded.freshness_deadline)
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then excluded.freshness_deadline
             else context_jobs.freshness_deadline end,
           status = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then 'pending' else context_jobs.status end,
           lease_expires_at = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.lease_expires_at end,
           last_error_category = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.last_error_category end,
           backfill_run_id = case
             when excluded.backfill_run_id is not null
             then excluded.backfill_run_id
             when context_jobs.backfill_run_id is not null
               and not exists(
                 select 1 from context_backfills b
                 where b.id = context_jobs.backfill_run_id
                   and b.status = 'active'
               )
             then null
             when context_jobs.status = 'completed' then null
             else context_jobs.backfill_run_id end;

-- name: channelContextPauseBackfillRunUpdateContextBackfills :exec
update context_backfills
         set status = 'paused', pause_reason = ?, updated_at = ?
         where id = ? and status = 'active';

-- name: channelContextSourceRevisionChecksumSelectConversationEvents :many
select id, discord_message_id as discordMessageId, content,
                edited_at as editedAt
         from conversation_events
         where guild_id = ? and channel_id = ? and medium = 'text'
           and content_state = 'available'
           and occurred_at >= ? and occurred_at < ?
         order by id;

-- name: channelContextInvalidateEventJobsSelectConversationEvents :many
select occurred_at from conversation_events where id = ?;

-- name: channelContextEventIdSelectConversationEvents :many
select id from conversation_events
           where guild_id = ? and channel_id = ? and discord_message_id = ?;

-- name: channelContextExistingRevisionSelectConversationEvents :one
select id, occurred_at as occurredAt, edited_at as editedAt,
                  revision_checksum as revisionChecksum
           from conversation_events
           where guild_id = ? and channel_id = ? and discord_message_id = ?;

-- name: contextActivateDocumentRevisionInsertContextDocuments :exec
insert into context_documents
              (document_key, tier, period_start, period_end, timezone,
              topic_key, topic_label, revision, completeness, state, content_state,
              content_state_reason, summary, confidence, retention_deadline,
              created_at, updated_at, generation_input_tokens,
              generation_output_tokens, generation_usage_usd, is_internal)
           values
             (@documentKey, @tier, @periodStart, @periodEnd, @timeZone,
              @topicKey, @topicLabel, @revision, @completeness, 'active', 'available',
              'retained', @summary, @confidence, @retentionDeadline,
              @createdAt, @createdAt, @generationInputTokens,
              @generationOutputTokens, @generationUsageUsd, @isInternal);

-- name: contextStoreAssertInputsAvailableSelectContextTombstones :many
select exists(
           select 1 from context_tombstones
           where (scope_type = 'document' and scope_id = @documentKey)
              or (scope_type = 'document'
                  and scope_id = @documentGenerationScopeId)
              or (scope_type = 'topic' and scope_id = @topicKey)
         );
