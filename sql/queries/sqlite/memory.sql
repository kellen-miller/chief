-- name: deleteMemoryFts
delete from memory_fts where rowid = ?

-- name: deleteMemoryVector
delete from memory_vectors where memory_id = ?

-- name: memorySnowflakeFilter
or (medium = 'text' and platform_source_id in
             ({{0}}))

-- name: memorySourceSnowflakeFilter
or (s.medium = 'text' and s.platform_source_id in
             ({{0}}))

-- name: memoryStoreConsolidateExactDuplicatesSelectMemories
select id from memories where id in ({{0}})
             order by confidence desc, updated_at desc, id desc limit 1

-- name: memoryStoreDeleteContextMemoriesDeleteMemories
delete from memories where id in ({{0}})

-- name: memoryStoreDeleteContextMemoriesSelectMemories
select id, state from memories
         where id in ({{0}}) order by id

-- name: memoryStoreDeleteContextSourcesDeleteSourceEvents
delete from source_events where id in ({{0}})

-- name: memoryStoreFindLexicalSelectMemoryFts
select m.id, m.canonical_text as canonicalText
         from memory_fts f join memories m on m.id = f.rowid
         where memory_fts match ? and m.state = 'active'
         order by bm25(memory_fts) limit ?

-- name: memoryStoreInsertMemoryInsertMemoryFts
insert into memory_fts (rowid, canonical_text) values (?, ?)

-- name: memoryStoreInsertMemoryInsertMemoryVectors
insert into memory_vectors (memory_id, embedding) values (?, ?)

-- name: memoryStoreRetrieveSelectMemories
select id, canonical_text, confidence, kind from memories
         where state = 'active' and id in ({{0}})

-- name: memoryStoreRetrieveSelectMemoryFts
select m.id from memory_fts f join memories m on m.id = f.rowid
           where memory_fts match ? and m.state = 'active'
           order by bm25(memory_fts) limit ?

-- name: memoryStoreRetrieveSelectMemoryVectors
select memory_id as id from memory_vectors
         where embedding match ? and k = ? order by distance

-- name: memoryStoreScrubContextSourcesDeleteMemoryJobs
delete from memory_jobs
         where source_event_id in ({{0}})

-- name: memoryStoreScrubContextSourcesUpdateSourceEvents
update source_events
         set content = '', extraction_status = 'completed'
         where id in ({{0}})

-- name: memoryStoreSourceEventIdsSelectSourceEvents
select id from source_events
         where source_scope_id in ({{0}})
           {{1}}
         order by id

-- name: memoryStoreSupersedeForContextDeletionSelectMemories
with recursive affected(id) as (
           select id from memories where id in ({{0}})
           union
           select m.id from memories m join affected a
             on m.superseded_by = a.id
         )
         select m.id, m.state from affected a join memories m on m.id = a.id
         order by m.id

-- name: memoryStoreSupersedeForContextDeletionUpdateMemories
update memories
           set canonical_text = '', provenance_json = '{}',
               state = 'superseded', superseded_by = null, updated_at = ?
           where id in ({{0}})
