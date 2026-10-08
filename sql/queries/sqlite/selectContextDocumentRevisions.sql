select id, revision from context_documents
         where id in ({{0}}) order by id
