select id from source_events
         where source_scope_id in ({{0}})
           {{1}}
         order by id
