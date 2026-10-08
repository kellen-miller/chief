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

-- name: discordReconciliationServiceRunPassDeleteDiscordReconciliationSeen :exec
delete from discord_reconciliation_seen
             where scope_id = ? and pass_key = ?;

-- name: discordReconciliationServiceRunPassUpdateDiscordReconciliationState :exec
update discord_reconciliation_state
             set phase = ?, pass_key = ?, cursor_message_id = null,
                 covered_oldest_message_id = null,
                 covered_newest_message_id = null,
                 scan_upper_bound_message_id = ?, updated_at = ?
             where scope_id = ?;

-- name: discordReconciliationServiceApplyPageInsertDiscordReconciliationSeen :exec
insert into discord_reconciliation_seen
         (scope_id, pass_key, message_id, observed_at, revision_checksum)
       values (?, ?, ?, ?, ?)
       on conflict(scope_id, pass_key, message_id) do update set
         observed_at = excluded.observed_at,
         revision_checksum = excluded.revision_checksum;

-- name: discordReconciliationServiceUpdateProgressUpdateDiscordReconciliationState :exec
update discord_reconciliation_state
         set cursor_message_id = ?, covered_oldest_message_id = ?,
             covered_newest_message_id = ?, updated_at = ?
         where scope_id = ?;

-- name: discordReconciliationServiceInferCoveredDeletionsSelectDiscordReconciliationSeen :many
select message_id from discord_reconciliation_seen
           where scope_id = ? and pass_key = ?;

-- name: discordReconciliationServiceInferCoveredDeletionsSelectConversationEvents :many
select distinct c.discord_message_id
         from conversation_events c
         where c.guild_id = ? and c.channel_id = ? and c.medium = 'text'
           and (
             c.content_state = 'available'
             or (
               c.content_state = 'scrubbed'
               and c.content_state_reason = 'retention-expired'
               and exists (
                 select 1 from source_events s
                 where s.platform_source_id = c.discord_message_id
                   and s.medium = 'text'
                   and s.source_scope_id =
                     c.guild_id || '/' || c.channel_id || '/' ||
                     c.discord_message_id
               )
             )
           );

-- name: discordReconciliationServiceCompletePassSelectDiscordReconciliationSeen :many
select message_id from discord_reconciliation_seen
           where scope_id = ? and pass_key = ?;

-- name: discordReconciliationServiceCompletePassUpdateDiscordReconciliationState :exec
update discord_reconciliation_state
           set high_water_message_id = ?, phase = null, pass_key = null,
               cursor_message_id = null, covered_oldest_message_id = null,
               covered_newest_message_id = null, last_complete_at = ?,
               scan_upper_bound_message_id = null,
               last_full_scan_at = case when ? = 'full' then ?
                                        else last_full_scan_at end,
               updated_at = ? where scope_id = ?;

-- name: discordReconciliationServiceCompletePassDeleteDiscordReconciliationSeen :exec
delete from discord_reconciliation_seen
           where scope_id = ? and pass_key like ? and pass_key <> ?;

-- name: discordReconciliationServiceEnsureStateInsertDiscordReconciliationState :exec
insert into discord_reconciliation_state (scope_id, updated_at)
         values (?, ?) on conflict(scope_id) do nothing;

-- name: discordReconciliationServiceStateSelectDiscordReconciliationState :many
select high_water_message_id as highWaterMessageId, phase,
                pass_key as passKey, cursor_message_id as cursorMessageId,
                covered_oldest_message_id as coveredOldestMessageId,
                covered_newest_message_id as coveredNewestMessageId,
                scan_upper_bound_message_id as scanUpperBoundMessageId,
                last_complete_at as lastCompleteAt,
                last_full_scan_at as lastFullScanAt
         from discord_reconciliation_state where scope_id = ?;
