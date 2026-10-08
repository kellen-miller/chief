select
             exists(
               select term, doc, col, offset
               from context_restore_expected_vocab
               except
               select term, doc, col, offset
               from context_restore_actual_vocab
             ) or exists(
               select term, doc, col, offset
               from context_restore_actual_vocab
               except
               select term, doc, col, offset
               from context_restore_expected_vocab
             )
