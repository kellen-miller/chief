with recursive lineage(id) as (
           select id from context_documents
           where document_key = ? and state = 'active'
           union
           select p.parent_document_id
           from context_document_parents p join lineage l
             on p.document_id = l.id
         )
         select d.id, d.state, d.content_state as contentState,
                e.event_id as eventId,
                c.content_state as eventContentState
         from lineage l join context_documents d on d.id = l.id
         left join context_document_events e on e.document_id = l.id
         left join conversation_events c on c.id = e.event_id
