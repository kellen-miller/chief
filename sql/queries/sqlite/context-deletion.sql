-- name: availableContentFilter
and content_state = 'available'

-- name: contextDeletionStoreActiveDocumentIdsSelectContextDocuments
select id from context_documents
         where id in ({{0}}) and state = 'active'
           and content_state = 'available' order by id

-- name: contextDeletionStoreAffectedDocumentsSelectContextDocumentEvents
select distinct document_id from context_document_events
             where event_id in ({{0}})

-- name: contextDeletionStoreAffectedDocumentsSelectContextDocuments
select id from context_documents
             where document_key in ({{0}})

-- name: contextDeletionStoreAffectedDocumentsSelectStatement
with recursive roots(id) as (values {{0}}), affected(id) as (
           select id from roots
           union
           select sibling.id from context_documents current
           join context_documents sibling
             on sibling.document_key = current.document_key
           join affected a on current.id = a.id
           union
           select p.document_id from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select d.id, d.document_key as documentKey, d.state, d.completeness,
                d.content_state as contentState, d.is_internal as isInternal,
                d.tier, d.period_start as periodStart,
                d.period_end as periodEnd, d.timezone as timeZone,
                d.topic_key as topicKey, d.topic_label as topicLabel,
                (select j.source_revision_checksum from context_jobs j
                 where j.job_key = d.document_key || ':' || d.completeness
                 limit 1) as sourceRevisionChecksum
         from context_documents d join affected a on a.id = d.id
         order by d.id

-- name: contextDeletionStoreAffectedMemorySourceScopesSelectMemories
with recursive affected(id) as (
           select id from memories where id in ({{0}})
           union
           select m.id from memories m join affected a
             on m.superseded_by = a.id
         )
         select coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         )
         from affected a join memories m on m.id = a.id
         join source_events s on s.id = m.source_event_id
         where coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         ) is not null
         order by m.id

-- name: contextDeletionStoreDiscoverSelectContextDocumentFts
select distinct d.document_key as documentKey, d.summary as text
         from context_document_fts f
         join context_documents d on d.id = f.rowid
         where context_document_fts match ? and d.state = 'active'
           and d.content_state = 'available' and d.is_internal = 0
         order by bm25(context_document_fts), d.updated_at desc
         limit ? offset ?

-- name: contextDeletionStoreDiscoverSelectConversationEventFts
select c.guild_id || '/' || c.channel_id || '/' ||
                  c.discord_message_id as scopeId, c.content as text
         from conversation_event_fts f
         join conversation_events c on c.id = f.rowid
         where conversation_event_fts match ?
           and c.guild_id = ? and c.channel_id = ?
           and c.content_state = 'available'
         order by bm25(conversation_event_fts), c.id desc limit ? offset ?

-- name: contextDeletionStoreDiscoverSelectMemoryFts
select m.id, m.canonical_text as text
         from memory_fts f join memories m on m.id = f.rowid
         where memory_fts match ? and m.state = 'active'
         order by bm25(memory_fts), m.updated_at desc limit ? offset ?

-- name: contextDeletionStoreDocumentHasSurvivingLineageSelectContextDocuments
with recursive lineage(id) as (
           select id from context_documents
           where document_key = ? and state = 'active'
           union
           select p.parent_document_id
           from context_document_parents p join lineage l
             on p.document_id = l.id
         )
         select d.id, d.state, d.content_state as contentState,
                e.event_id as eventId,
                c.content_state as eventContentState
         from lineage l join context_documents d on d.id = l.id
         left join context_document_events e on e.document_id = l.id
         left join conversation_events c on c.id = e.event_id

-- name: contextDeletionStoreDocumentSourceScopesSelectContextDocuments
with recursive lineage(id) as (
           select id from context_documents
           where document_key in ({{0}}) and state = 'active'
           union
           select p.parent_document_id
           from context_document_parents p join lineage l
             on p.document_id = l.id
         )
         select distinct c.guild_id || '/' || c.channel_id || '/' ||
                c.discord_message_id
         from lineage l join context_document_events e on e.document_id = l.id
         join conversation_events c on c.id = e.event_id
         order by c.id

-- name: contextDeletionStoreMemorySourceScopesSelectMemories
select coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         )
         from memories m join source_events s on s.id = m.source_event_id
         where m.id in ({{0}}) and coalesce(
           nullif(s.source_scope_id, ''),
           case when s.medium = 'text'
             and length(s.platform_source_id) between 17 and 20
             and s.platform_source_id not glob '*[^0-9]*'
           then s.platform_source_id end
         ) is not null
         order by m.id

-- name: contextDeletionStoreMutateSuppressionUpdateConversationEvents
update conversation_events
           set content = '', attachment_metadata_json = '[]', deleted_at = ?,
               content_state = 'scrubbed', content_state_reason = ?
           where id in ({{0}})
             {{1}}

-- name: contextDeletionStoreReplayForgetJournalUpdateConversationEvents
update conversation_events
             set content = '', attachment_metadata_json = '[]', deleted_at = ?,
                 content_state = 'scrubbed',
                 content_state_reason = ?
             where id in ({{0}})
               {{1}}

-- name: contextDeletionStoreRequesterCanDeleteSelectConversationEvents
select distinct speaker_id
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in ({{0}})

-- name: contextDeletionStoreScrubDocumentsUpdateContextDocuments
update context_documents
         set state = 'suppressed', content_state = 'scrubbed',
             content_state_reason = ?, summary = '',
             topic_label = null, updated_at = ?
         where id in ({{0}})

-- name: contextDeletionStoreScrubDocumentsUpdateContextJobs
update context_jobs set topic_label = null
         where {{0}}

-- name: contextDeletionStoreSourceDerivedMemoryIdsSelectMemories
select m.id from memories m join source_events s
           on s.id = m.source_event_id
         where s.source_scope_id in ({{0}})
            {{1}}
         order by m.id

-- name: contextDeletionStoreSourceRowsSelectConversationEvents
select id, occurred_at as occurredAt,
                guild_id || '/' || channel_id || '/' || discord_message_id
                  as scopeId
         from conversation_events
         where guild_id || '/' || channel_id || '/' || discord_message_id
                 in ({{0}})
            {{1}}
         order by id

-- name: contextJobSourceDocumentFilter
exists (
         select 1 from json_each(context_jobs.source_document_ids_json)
         where cast(json_each.value as integer) in ({{0}})
       )

-- name: contextJobTopicKeyFilter
topic_key in ({{0}})

-- name: contextJobTopicLabelFilter
topic_label in ({{0}})

-- name: conversationSnowflakeFilter
or discord_message_id in
             ({{0}})
