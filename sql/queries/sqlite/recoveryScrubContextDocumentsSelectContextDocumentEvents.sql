with recursive affected(id) as (
           select document_id from context_document_events
           where event_id in ({{0}})
           union
           select p.document_id from context_document_parents p
           join affected a on a.id = p.parent_document_id
         ) select id from affected
