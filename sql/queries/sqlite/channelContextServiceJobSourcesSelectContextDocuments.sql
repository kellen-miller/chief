select distinct 'document:' || current.id as id, current.summary as text
         from context_documents configured
         join context_documents current
           on current.document_key = configured.document_key
         where configured.id in ({{0}})
           and configured.state in ('active', 'superseded')
           and configured.content_state = 'available'
           and current.state = 'active' and current.content_state = 'available'
         order by current.period_start, current.id
