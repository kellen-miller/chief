select d.id, d.tier, d.period_start as periodStart,
                d.period_end as periodEnd, d.topic_label as topicLabel,
                d.summary, d.confidence,
                vec_distance_L2(v.embedding, ?) as distance
         from context_document_vectors v
         join context_documents d on d.id = v.document_id
         where d.tier = ?
           and d.state = 'active' and d.content_state = 'available'
           and d.is_internal = 0
           and (
             with recursive lineage_documents(id) as (
               select d.id
               union
               select p.parent_document_id
               from context_document_parents p
               join lineage_documents l on l.id = p.document_id
             )
             select count(*) > 0
               and sum(case
                 when e.guild_id = ? and e.channel_id = ? then 1
                 else 0
               end) = count(*)
               and (? is null or max(e.id) < ?)
             from lineage_documents l
             join context_document_events e_link
               on e_link.document_id = l.id
             join conversation_events e on e.id = e_link.event_id
           )
         order by distance limit ?
