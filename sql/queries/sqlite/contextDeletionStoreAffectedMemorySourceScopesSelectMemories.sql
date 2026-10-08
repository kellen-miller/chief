with recursive affected(id) as (
           select id from memories where id in ({{0}})
           union
           select m.id from memories m join affected a
             on m.superseded_by = a.id
         )
         select coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         )
         from affected a join memories m on m.id = a.id
         join source_events s on s.id = m.source_event_id
         where coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         ) is not null
         order by m.id
