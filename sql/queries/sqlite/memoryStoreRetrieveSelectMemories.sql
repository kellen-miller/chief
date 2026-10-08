select id, canonical_text, confidence, kind from memories
         where state = 'active' and id in ({{0}})
