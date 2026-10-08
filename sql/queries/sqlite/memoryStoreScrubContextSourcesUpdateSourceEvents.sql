update source_events
         set content = '', extraction_status = 'completed'
         where id in ({{0}})
