update memories
           set canonical_text = '', provenance_json = '{}',
               state = 'superseded', superseded_by = null, updated_at = ?
           where id in ({{0}})
