select m.id from memories m join source_events s
           on s.id = m.source_event_id
         where s.source_scope_id in ({{0}})
            {{1}}
         order by m.id
