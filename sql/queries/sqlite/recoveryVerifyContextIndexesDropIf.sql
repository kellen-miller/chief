drop table if exists temp.context_restore_actual_vocab;
    drop table if exists temp.context_restore_expected_vocab;
    drop table if exists temp.context_restore_expected_fts;
    create virtual table temp.context_restore_expected_fts using fts5(
      content, content='', contentless_delete=1
    );
    insert into temp.context_restore_expected_fts (rowid, content)
      select id, summary from context_documents
      where state = 'active' and content_state = 'available'
        {{0}};
    create virtual table temp.context_restore_actual_vocab using fts5vocab(
      main, context_document_fts, instance
    );
    create virtual table temp.context_restore_expected_vocab using fts5vocab(
      temp, context_restore_expected_fts, instance
    );
