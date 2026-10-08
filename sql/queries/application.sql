-- name: conversationRecordSelectConversationEvents :many
select id from conversation_events
         where guild_id = ? and channel_id = ? and discord_message_id = ?;

-- name: conversationSearchTextSourceGroupsSelectConversationEvents :many
select id, content,
                          discord_message_id as discordMessageId,
                          logical_response_id as logicalResponseId,
                          occurred_at as occurredAt,
                          response_chunk_index as responseChunkIndex,
                          role, speaker_name as speakerName
                   from conversation_events
                   where guild_id = ? and channel_id = ?
                     and logical_response_id = ? and role = 'chief'
                     and content_state = 'available'
                     and (? is null or id < ?)
                   order by coalesce(response_chunk_index, 2147483647), id;

-- name: conversationMaintainSelectConversationEvents :many
select id from conversation_events
           where medium = 'text' and content_state = 'available'
             and retention_deadline <= ?;

-- name: conversationMaintainUpdateConversationEvents :exec
update conversation_events
           set content = '', attachment_metadata_json = '[]',
               content_state = 'scrubbed',
               content_state_reason = 'retention-expired'
           where medium = 'text' and content_state = 'available'
             and retention_deadline <= ?;

-- name: conversationMaintainDeleteConversationEvents :exec
delete from conversation_events
           where medium = 'voice' and retention_deadline <= ?;

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

-- name: contextDeletionDiscoverMemberSelectConversationEvents :many
select guild_id || '/' || channel_id || '/' || discord_message_id
                  as scopeId,
                speaker_id as speakerId
         from conversation_events
         where guild_id = ? and channel_id = ? and role = 'human'
           and content_state_reason not in ('discord-deleted', 'locally-forgotten')
           and lower(trim(speaker_name)) = lower(trim(?))
         order by id;

-- name: contextDeletionCreateConfirmationInsertContextDeletionRequests :exec
insert into context_deletion_requests
           (id, requester_id, scope_type, scope_id, confirmation_checksum,
            status, expires_at, created_at, source_ids_json,
            document_ids_json, memory_ids_json, request_source_id)
         values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?);

-- name: contextDeletionConfirmationSelectContextDeletionRequests :one
select id, status, expires_at as expiresAt,
                  source_ids_json as sourceIdsJson,
                  document_ids_json as documentIdsJson,
                  memory_ids_json as memoryIdsJson,
                  request_source_id as requestSourceScopeId
           from context_deletion_requests
           where requester_id = ? and confirmation_checksum = ?
           order by created_at desc limit 1;

-- name: contextDeletionConfirmationDeleteContextDeletionRequests :exec
delete from context_deletion_requests where id = ?;

-- name: contextDeletionDeleteUpdateContextDeletionRequests :exec
update context_deletion_requests
             set status = 'consumed', consumed_at = ?
             where id = ? and status = 'pending' and expires_at > ?;

-- name: contextDeletionDeleteInsertContextForgetJournal :exec
insert into context_forget_journal
             (journal_key, scope_id, tombstone_key, occurred_at, checksum,
              payload_json)
           values (?, ?, ?, ?, ?, ?);

-- name: contextDeletionSuppressSourceInsertContextForgetJournal :exec
insert into context_forget_journal
               (journal_key, scope_id, tombstone_key, occurred_at, checksum,
                payload_json)
             values (?, ?, ?, ?, ?, ?)
             on conflict(journal_key) do nothing;

-- name: contextDeletionSuppressSourceInsertContextForgetJournal2 :exec
insert into context_forget_journal
               (journal_key, scope_id, tombstone_key, occurred_at, checksum,
                payload_json, upload_status, uploaded_at)
             values (?, ?, ?, ?, ?, ?, 'uploaded', ?)
             on conflict(journal_key) do update set
               upload_status = 'uploaded', uploaded_at = excluded.uploaded_at,
               next_attempt_at = null, last_error_category = null
             where checksum = excluded.checksum;

-- name: contextDeletionSuppressSourceSelectContextForgetJournal :one
select id, journal_key as journalKey, occurred_at as occurredAt,
                  checksum, payload_json as payloadJson,
                  upload_status as uploadStatus
           from context_forget_journal where journal_key = ?;

-- name: contextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournal :one
select journal_key as journalKey, occurred_at as occurredAt,
                checksum, payload_json as payloadJson,
                upload_status as uploadStatus
         from context_forget_journal where journal_key = ?;

-- name: contextDeletionMarkJournalUploadedUpdateContextForgetJournal :exec
update context_forget_journal
         set upload_status = 'uploaded', uploaded_at = ?,
             next_attempt_at = null, last_error_category = null
         where id = ? and upload_status != 'uploaded';

-- name: contextDeletionMarkJournalFailedUpdateContextForgetJournal :exec
update context_forget_journal
         set upload_status = 'failed', attempt_count = attempt_count + 1,
             next_attempt_at = ?, last_error_category = 'upload'
         where id = ? and upload_status != 'uploaded';

-- name: contextDeletionNextForgetJournalSelectContextForgetJournal :one
select id, journal_key as journalKey, occurred_at as occurredAt,
                checksum, payload_json as payloadJson
         from context_forget_journal
         where upload_status in ('pending', 'failed')
           and (next_attempt_at is null or next_attempt_at <= ?)
         order by occurred_at, id limit 1;

-- name: contextDeletionReplayForgetJournalInsertContextForgetJournal :exec
insert into context_forget_journal
             (journal_key, scope_id, tombstone_key, occurred_at, checksum,
              payload_json, upload_status, uploaded_at)
           values (?, ?, ?, ?, ?, ?, 'uploaded', ?)
           on conflict(journal_key) do update set
             upload_status = 'uploaded', uploaded_at = excluded.uploaded_at,
             next_attempt_at = null, last_error_category = null;

-- name: contextDeletionInsertTombstoneInsertContextTombstones :exec
insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, ?, ?, ?, ?, ?)
         on conflict(scope_type, scope_id) do nothing;

-- name: contextDeletionEnqueueRebuildsSelectConversationEvents :many
select id, discord_message_id as discordMessageId, content,
                  edited_at as editedAt
           from conversation_events
           where guild_id = ? and channel_id = ? and medium = 'text'
             and content_state = 'available'
             and occurred_at >= ? and occurred_at < ? order by id;

-- name: contextDeletionEnqueueRebuildsUpdateContextJobs :exec
update context_jobs
           set source_revision_checksum = ?, status = 'pending',
               not_before = ?, freshness_deadline = ?, lease_expires_at = null,
               last_error_category = 'rebuild'
           where tier = 'hourly' and timezone = ?
             and period_start = ? and period_end = ?;

-- name: contextDeletionEnqueueRebuildsSelectContextDocuments :many
select id, revision from context_documents
           where tier = ? and completeness = 'final' and state = 'active'
             and content_state = 'available' and is_internal = 0
             and period_start >= ? and period_end <= ?
           order by period_start, id;

-- name: contextDeletionEnqueueRebuildsUpdateContextJobs2 :exec
update context_jobs
           set source_revision_checksum = ?, status = 'pending',
               not_before = ?, freshness_deadline = ?, lease_expires_at = null,
               last_error_category = 'rebuild'
           where tier = ? and timezone = ?
             and period_start = ? and period_end = ?;

-- name: contextDeletionEnqueueRebuildsSelectContextJobs :many
select id, source_document_ids_json as sourceDocumentIdsJson
           from context_jobs where tier = 'long-term' and topic_key = ?;

-- name: contextDeletionEnqueueRebuildsUpdateContextJobs3 :exec
update context_jobs
             set source_revision_checksum = ?, source_document_ids_json = ?,
                 status = 'pending', not_before = ?, freshness_deadline = ?,
                 lease_expires_at = null, last_error_category = 'rebuild'
             where id = ?;

-- name: contextDeletionUnavailableDocumentSourceScopesSelectConversationEvents :many
select exists(
             select 1 from conversation_events c
             where c.guild_id || '/' || c.channel_id || '/' ||
                   c.discord_message_id = ?
               and c.content_state = 'available'
           );

-- name: contextDeletionSourceBelongsToSelectConversationEvents :many
select exists(
             select 1 from conversation_events
             where guild_id || '/' || channel_id || '/' ||
                     discord_message_id = ? and speaker_id = ?
           );

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

-- name: usageLedgerCancelDeleteUsageLedger :exec
delete from usage_ledger where id = ? and actual_usd is null;

-- name: usageLedgerBackfillRunSelectContextBackfills :one
select actual_usage_usd as actualUsd,
                  maximum_usage_usd as maximumUsd
           from context_backfills where id = ?
             and maximum_usage_usd is not null;

-- name: usageLedgerListSelectUsageLedger :many
select id, operation, reservation_usd as reservationUsd,
                backfill_run_id as backfillRunId,
                origin_backfill_run_id as originBackfillRunId,
                reservation_origin as reservationOrigin,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where occurred_at >= ? and occurred_at < ?;

-- name: usageLedgerListOutstandingSelectUsageLedger :many
select id, operation, reservation_usd as reservationUsd,
                backfill_run_id as backfillRunId,
                origin_backfill_run_id as originBackfillRunId,
                reservation_origin as reservationOrigin,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where actual_usd is null;

-- name: usageLedgerReconcileWithSelectContextAccountingHolds :one
select l.backfill_run_id as backfillRunId,
                  exists(
                    select 1 from context_accounting_holds h
                    where h.reservation_id = l.id
                  ) as held
           from usage_ledger l where l.id = ? and l.actual_usd is null;

-- name: usageLedgerReconcileWithUpdateUsageLedger :exec
update usage_ledger set actual_usd = ?, reconciled_at = ?
           where id = ? and actual_usd is null;

-- name: usageLedgerReconcileWithUpdateContextBackfills :exec
update context_backfills
             set actual_usage_usd = actual_usage_usd + ?, updated_at = ?
             where id = ?;


-- name: conversationRecordInsertConversationEvents :exec
insert into conversation_events
           (platform_event_id, discord_message_id, guild_id, channel_id,
            request_id, logical_response_id, role, speaker_id, speaker_name,
            medium, reply_to_message_id, content, attachment_metadata_json,
            occurred_at, edited_at, recent_until, retention_deadline,
            content_state, content_state_reason, revision_checksum,
            response_chunk_index)
         values (@platformEventId, @discordMessageId, @guildId, @channelId,
                 @requestId, @logicalResponseId, @role, @speakerId,
                 @speakerName, @medium, @replyToMessageId, @content,
                 @attachmentMetadataJson, @occurredAt, @editedAt,
                 @recentUntil, @retentionDeadline, 'available', 'retained',
                 @revisionChecksum, @responseChunkIndex)
         on conflict(guild_id, channel_id, discord_message_id) do update set
           speaker_name = excluded.speaker_name,
           speaker_id = excluded.speaker_id,
           edited_at = excluded.edited_at,
           reply_to_message_id = excluded.reply_to_message_id,
           response_chunk_index = coalesce(
             excluded.response_chunk_index,
             conversation_events.response_chunk_index
           ),
           content = case when conversation_events.content_state = 'available'
             then excluded.content else conversation_events.content end,
           attachment_metadata_json = case
             when conversation_events.content_state = 'available'
             then excluded.attachment_metadata_json
             else conversation_events.attachment_metadata_json end,
           revision_checksum = excluded.revision_checksum;

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

-- name: usageLedgerRecordInsertUsageLedger :exec
insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at, reservation_origin, origin_backfill_run_id)
         values (@id, @operation, @workCategory, @priority, @reservationUsd,
                 @actualUsd, @occurredAt, @occurrenceMonth, @backfillRunId,
                 case when @actualUsd is null then null else @occurredAt end,
                 @reservationOrigin, @originBackfillRunId);
