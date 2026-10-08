select m.id, m.canonical_text as text
         from memory_fts f join memories m on m.id = f.rowid
         where memory_fts match ? and m.state = 'active'
         order by bm25(memory_fts), m.updated_at desc limit ? offset ?
