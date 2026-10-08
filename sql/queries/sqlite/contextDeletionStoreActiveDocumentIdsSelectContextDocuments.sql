select id from context_documents
         where id in ({{0}}) and state = 'active'
           and content_state = 'available' order by id
