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
