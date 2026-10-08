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
