select id from memories where id in ({{0}})
             order by confidence desc, updated_at desc, id desc limit 1
