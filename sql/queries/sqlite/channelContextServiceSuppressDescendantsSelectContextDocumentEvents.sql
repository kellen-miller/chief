with recursive affected(id) as (
           select document_id from context_document_events where event_id = ?
           union
           select p.document_id
           from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select distinct id from affected
