with recursive roots(id) as (values {{0}}), affected(id) as (
           select id from roots
           union
           select sibling.id from context_documents current
           join context_documents sibling
             on sibling.document_key = current.document_key
           join affected a on current.id = a.id
           union
           select p.document_id from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select d.id, d.document_key as documentKey, d.state, d.completeness,
                d.content_state as contentState, d.is_internal as isInternal,
                d.tier, d.period_start as periodStart,
                d.period_end as periodEnd, d.timezone as timeZone,
                d.topic_key as topicKey, d.topic_label as topicLabel,
                (select j.source_revision_checksum from context_jobs j
                 where j.job_key = d.document_key || ':' || d.completeness
                 limit 1) as sourceRevisionChecksum
         from context_documents d join affected a on a.id = d.id
         order by d.id
