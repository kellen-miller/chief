exists (
         select 1 from json_each(context_jobs.source_document_ids_json)
         where cast(json_each.value as integer) in ({{0}})
       )
