with expected(id) as (
             select id from context_documents
             where state = 'active' and content_state = 'available'
               {{0}}
           )
           select
             exists(
               select id from expected
               except select rowid from context_document_fts
             ) or exists(
               select rowid from context_document_fts
               except select id from expected
             ) or exists(
               select id from expected
               except select document_id from context_document_vectors
             ) or exists(
               select document_id from context_document_vectors
               except select id from expected
             )
