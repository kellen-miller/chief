select distinct d.document_key as documentKey, d.summary as text
         from context_document_fts f
         join context_documents d on d.id = f.rowid
         where context_document_fts match ? and d.state = 'active'
           and d.content_state = 'available' and d.is_internal = 0
         order by bm25(context_document_fts), d.updated_at desc
         limit ? offset ?
