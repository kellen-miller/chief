select exists(
           select 1 from context_tombstones
           where scope_type = 'source'
             and scope_id in ({{0}})
         )
