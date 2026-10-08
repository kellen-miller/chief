with tiers(tier) as (
           values ('hourly'), ('daily'), ('weekly'), ('long-term')
         )
         select t.tier, count(d.id) as count
         from tiers t
         left join context_documents d
           on d.tier = t.tier and d.state = 'active'
          and d.content_state = 'available' {{0}}
         left join context_document_fts f on f.rowid = d.id
         left join context_document_vectors v on v.document_id = d.id
         group by t.tier order by t.tier
