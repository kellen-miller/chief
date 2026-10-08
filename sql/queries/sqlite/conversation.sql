-- name: conversationStoreRecentSelectConversationEvents
with contextual_events as (
           select e.id, e.platform_event_id as platformEventId,
                  e.discord_message_id as discordMessageId,
                  e.guild_id as guildId, e.channel_id as channelId,
                  e.request_id as requestId, e.role,
                  e.logical_response_id as logicalResponseId,
                  e.response_chunk_index as responseChunkIndex,
                  e.speaker_id as speakerId, e.speaker_name as speakerName,
                  e.medium, e.reply_to_message_id as replyToMessageId,
                  e.content,
                  e.attachment_metadata_json as attachmentMetadataJson,
                  e.occurred_at as occurredAt, e.edited_at as editedAt,
                  e.deleted_at as deletedAt,
                  e.recent_until as recentUntil,
                  e.retention_deadline as retentionDeadline,
                  e.content_state as contentState,
                  e.content_state_reason as contentStateReason,
                  case when e.role = 'chief' then coalesce(
                    (select min(h.id) from conversation_events h
                     where h.role = 'human' and h.request_id = e.request_id),
                    e.id
                  ) else e.id end as contextOrder,
                  case when e.role = 'chief' then 1 else 0 end as roleOrder
           from conversation_events e
           where e.recent_until > @now
             and e.content_state = 'available'
             and (
               @beforeEventId is null
               or e.id < @beforeEventId
               or (e.role = 'chief' and exists (
                 select 1 from conversation_events h
                 where h.role = 'human' and h.request_id = e.request_id
                   and h.id < @beforeEventId
               ))
             )
         ), grouped_events as (
           select min(id) as id,
                  min(platformEventId) as platformEventId,
                  min(discordMessageId) as discordMessageId,
                  min(guildId) as guildId, min(channelId) as channelId,
                  min(requestId) as requestId,
                  min(logicalResponseId) as logicalResponseId,
                  min(role) as role, min(speakerId) as speakerId,
                  min(speakerName) as speakerName, min(medium) as medium,
                  min(replyToMessageId) as replyToMessageId,
                  group_concat(
                    content, '' order by
                      coalesce(responseChunkIndex, 2147483647), id
                  ) as content,
                  min(attachmentMetadataJson) as attachmentMetadataJson,
                  min(occurredAt) as occurredAt, max(editedAt) as editedAt,
                  max(deletedAt) as deletedAt,
                  min(recentUntil) as recentUntil,
                  min(retentionDeadline) as retentionDeadline,
                  min(contentState) as contentState,
                  min(contentStateReason) as contentStateReason,
                  min(contextOrder) as contextOrder,
                  max(roleOrder) as roleOrder
           from contextual_events
           group by case
             when role = 'chief' and logicalResponseId is not null
             then 'response:' || logicalResponseId
             else 'event:' || cast(id as text)
           end
         )
         select id, platformEventId, discordMessageId, guildId, channelId,
                requestId, logicalResponseId, role, speakerId, speakerName,
                medium, replyToMessageId, content, attachmentMetadataJson,
                occurredAt, editedAt, deletedAt, recentUntil,
                retentionDeadline, contentState, contentStateReason
         from grouped_events
         order by contextOrder desc, roleOrder desc, id desc
         limit @maxMessages

-- name: conversationStoreSearchTextSourceGroupsSelectConversationEventFts
select e.id, e.content,
                e.discord_message_id as discordMessageId,
                e.logical_response_id as logicalResponseId,
                e.occurred_at as occurredAt,
                e.response_chunk_index as responseChunkIndex,
                e.role, e.speaker_name as speakerName
         from conversation_event_fts f
         join conversation_events e on e.id = f.rowid
         where conversation_event_fts match ?
           and e.guild_id = ? and e.channel_id = ? and e.medium = 'text'
           and e.content_state = 'available'
           and (? is null or e.id < ?)
           {{0}}
           {{1}}
         order by bm25(conversation_event_fts), e.occurred_at desc, e.id desc
         limit ? offset ?

-- name: deleteConversationEventFts
delete from conversation_event_fts where rowid = ?

-- name: excludedConversationEventFilter
and e.id not in ({{0}})

-- name: excludedLogicalResponseFilter
and (e.logical_response_id is null or
                   e.logical_response_id not in ({{0}}))

-- name: insertConversationEventFts
insert into conversation_event_fts (rowid, content) values (?, ?)
