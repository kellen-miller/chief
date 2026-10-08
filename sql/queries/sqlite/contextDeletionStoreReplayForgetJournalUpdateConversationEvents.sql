update conversation_events
             set content = '', attachment_metadata_json = '[]', deleted_at = ?,
                 content_state = 'scrubbed',
                 content_state_reason = ?
             where id in ({{0}})
               {{1}}
