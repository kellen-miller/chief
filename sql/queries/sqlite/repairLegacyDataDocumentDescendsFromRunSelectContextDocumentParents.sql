with recursive ancestry(id) as (
           select ?
           union
           select p.parent_document_id
           from context_document_parents p
           join ancestry a on a.id = p.document_id
         )
         select exists(
           select 1 from ancestry a
           join context_backfill_segments s on s.document_id = a.id
           where s.run_id = ?
         )
