update context_documents
         set state = 'suppressed', content_state = 'scrubbed',
             content_state_reason = ?, summary = '', updated_at = ?
         where id in ({{0}})
