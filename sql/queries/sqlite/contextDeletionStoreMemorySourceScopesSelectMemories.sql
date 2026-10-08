select coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         )
         from memories m join source_events s on s.id = m.source_event_id
         where m.id in ({{0}}) and coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         ) is not null
         order by m.id
