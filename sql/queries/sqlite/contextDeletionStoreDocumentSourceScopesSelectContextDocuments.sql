with recursive lineage(id) as (
           select id from context_documents
           where document_key in ({{0}}) and state = 'active'
           union
           select p.parent_document_id
           from context_document_parents p join lineage l
             on p.document_id = l.id
         )
         select distinct c.guild_id || '/' || c.channel_id || '/' ||
                c.discord_message_id
         from lineage l join context_document_events e on e.document_id = l.id
         join conversation_events c on c.id = e.event_id
         order by c.id
