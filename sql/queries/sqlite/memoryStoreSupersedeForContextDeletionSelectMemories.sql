with recursive affected(id) as (
           select id from memories where id in ({{0}})
           union
           select m.id from memories m join affected a
             on m.superseded_by = a.id
         )
         select m.id, m.state from affected a join memories m on m.id = a.id
         order by m.id
