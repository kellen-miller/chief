with recursive lineage_documents(id) as (
           select ?
           union
           select p.parent_document_id
           from context_document_parents p
           join lineage_documents d on d.id = p.document_id
         )
         select distinct e.id,
                e.discord_message_id as discordMessageId,
                e.occurred_at as occurredAt,
                e.content_state as contentState,
                e.content_state_reason as contentStateReason
         from lineage_documents d
         join context_document_events l on l.document_id = d.id
         join conversation_events e on e.id = l.event_id
         where e.guild_id = ? and e.channel_id = ?
         order by e.occurred_at desc, e.id desc
