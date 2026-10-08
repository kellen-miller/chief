-- name: publicContextDocumentFilter
and is_internal = 0

-- name: recoveryScrubContextDocumentsSelectContextDocumentEvents
with recursive affected(id) as (
           select document_id from context_document_events
           where event_id in ({{0}})
           union
           select p.document_id from context_document_parents p
           join affected a on a.id = p.parent_document_id
         ) select id from affected

-- name: recoveryScrubContextDocumentsSelectContextDocuments
select id from context_documents where document_key in ({{0}})

-- name: recoveryScrubMemoriesDeleteMemoryJobs
delete from memory_jobs where source_event_id in ({{0}})

-- name: recoveryScrubMemoriesSelectMemories
select id from memories where source_event_id in ({{0}})

-- name: recoverySelectIdsSelectStatement
select id from {{0}} where {{1}} in ({{2}})

-- name: recoveryUpdateIdsUpdateStatement
update {{0}} set {{1}} where id in ({{2}})

-- name: recoveryVerifyContextIndexesDropIf
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

-- name: recoveryVerifyContextIndexesDropIf2
drop table if exists temp.context_restore_actual_vocab;
      drop table if exists temp.context_restore_expected_vocab;
      drop table if exists temp.context_restore_expected_fts;

-- name: recoveryVerifyContextIndexesSelectContextDocuments
with expected(id) as (
             select id from context_documents
             where state = 'active' and content_state = 'available'
               {{0}}
           )
           select
             exists(
               select id from expected
               except select rowid from context_document_fts
             ) or exists(
               select rowid from context_document_fts
               except select id from expected
             ) or exists(
               select id from expected
               except select document_id from context_document_vectors
             ) or exists(
               select document_id from context_document_vectors
               except select id from expected
             )

-- name: recoveryVerifyContextIndexesSelectContextRestoreExpectedVocab
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

-- name: recoveryVerifyContextIndexesSelectTiers
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

-- name: recoveryVerifyRestorableDatabasePragmaStatement
pragma integrity_check;

-- name: recoveryVerifyRestorableDatabaseSelectStatement2
select count(*) from {{0}}

-- name: scrubConversationAssignments
content = '', attachment_metadata_json = '[]', deleted_at = ?,
       content_state = 'scrubbed', content_state_reason = ?

-- name: scrubSourceAssignments
content = '', extraction_status = 'completed'

-- name: scrubMemoryAssignments
canonical_text = '', provenance_json = '{}', state = 'superseded', superseded_by = null, updated_at = ?

-- name: scrubContextAssignments
summary = '', state = 'suppressed', content_state = 'scrubbed', content_state_reason = ?, updated_at = ?
