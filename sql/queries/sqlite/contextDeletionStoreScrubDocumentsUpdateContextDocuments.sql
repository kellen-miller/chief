update context_documents
         set state = 'suppressed', content_state = 'scrubbed',
             content_state_reason = ?, summary = '',
             topic_label = null, updated_at = ?
         where id in ({{0}})
