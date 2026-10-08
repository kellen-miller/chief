update context_documents
             set content_state = 'scrubbed',
                 content_state_reason = 'retention-expired', summary = '',
                 updated_at = ?
             where id in ({{0}})
