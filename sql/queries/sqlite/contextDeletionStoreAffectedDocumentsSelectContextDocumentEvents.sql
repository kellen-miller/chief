select distinct document_id from context_document_events
             where event_id in ({{0}})
