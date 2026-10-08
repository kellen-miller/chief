-- name: backfillRunIdFilter
and id = ?

-- name: channelContextServiceInvalidateEventJobsUpdateContextJobs
update context_jobs
         set status = 'failed', lease_expires_at = null,
             last_error_category = 'source-invalidated'
         where tier = 'hourly' and timezone = ?
           and period_start = ? and period_end = ?
           {{0}}

-- name: channelContextServiceJobSourcesSelectContextDocuments
select distinct 'document:' || current.id as id, current.summary as text
         from context_documents configured
         join context_documents current
           on current.document_key = configured.document_key
         where configured.id in ({{0}})
           and configured.state in ('active', 'superseded')
           and configured.content_state = 'available'
           and current.state = 'active' and current.content_state = 'available'
         order by current.period_start, current.id

-- name: channelContextServiceMaintainUpdateContextDocuments
update context_documents
             set content_state = 'scrubbed',
                 content_state_reason = 'retention-expired', summary = '',
                 updated_at = ?
             where id in ({{0}})

-- name: channelContextServiceSuppressDescendantsSelectContextDocumentEvents
with recursive affected(id) as (
           select document_id from context_document_events where event_id = ?
           union
           select p.document_id
           from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select distinct id from affected

-- name: channelContextServiceSuppressDocumentDescendantsSelectContextDocumentParents
with recursive affected(id) as (
           select document_id from context_document_parents
           where parent_document_id in ({{0}})
           union
           select p.document_id
           from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select distinct id from affected

-- name: contextAssemblerLineageSelectContextDocumentParents
with recursive lineage_documents(id) as (
           select ?
           union
           select p.parent_document_id
           from context_document_parents p
           join lineage_documents d on d.id = p.document_id
         )
         select distinct e.id,
                e.discord_message_id as discordMessageId,
                e.occurred_at as occurredAt,
                e.content_state as contentState,
                e.content_state_reason as contentStateReason
         from lineage_documents d
         join context_document_events l on l.document_id = d.id
         join conversation_events e on e.id = l.event_id
         where e.guild_id = ? and e.channel_id = ?
         order by e.occurred_at desc, e.id desc

-- name: contextAssemblerRollupCandidatesSelectContextDocumentFts
select d.id, d.tier, d.period_start as periodStart,
                      d.period_end as periodEnd, d.topic_label as topicLabel,
                      d.summary, d.confidence
               from context_document_fts f
               join context_documents d on d.id = f.rowid
               where context_document_fts match ? and d.tier = ?
                 and d.state = 'active' and d.content_state = 'available'
                 and d.is_internal = 0
                 and (
                   with recursive lineage_documents(id) as (
                     select d.id
                     union
                     select p.parent_document_id
                     from context_document_parents p
                     join lineage_documents l on l.id = p.document_id
                   )
                   select count(*) > 0
                     and sum(case
                       when e.guild_id = ? and e.channel_id = ? then 1
                       else 0
                     end) = count(*)
                     and (? is null or max(e.id) < ?)
                   from lineage_documents l
                   join context_document_events e_link
                     on e_link.document_id = l.id
                   join conversation_events e on e.id = e_link.event_id
                 )
               order by bm25(context_document_fts) limit ?

-- name: contextAssemblerRollupCandidatesSelectContextDocumentVectors
select d.id, d.tier, d.period_start as periodStart,
                d.period_end as periodEnd, d.topic_label as topicLabel,
                d.summary, d.confidence,
                vec_distance_L2(v.embedding, ?) as distance
         from context_document_vectors v
         join context_documents d on d.id = v.document_id
         where d.tier = ?
           and d.state = 'active' and d.content_state = 'available'
           and d.is_internal = 0
           and (
             with recursive lineage_documents(id) as (
               select d.id
               union
               select p.parent_document_id
               from context_document_parents p
               join lineage_documents l on l.id = p.document_id
             )
             select count(*) > 0
               and sum(case
                 when e.guild_id = ? and e.channel_id = ? then 1
                 else 0
               end) = count(*)
               and (? is null or max(e.id) < ?)
             from lineage_documents l
             join context_document_events e_link
               on e_link.document_id = l.id
             join conversation_events e on e.id = e_link.event_id
           )
         order by distance limit ?

-- name: contextBackfillStatusSelectContextBackfills
select id as runId, run_key as runKey, status,
                eligible_count as eligibleCount,
                already_ingested_count as alreadyIngestedCount,
                eligible_bytes as eligibleBytes,
                eligible_tokens as eligibleTokens,
                estimated_usage_usd as estimatedUsageUsd,
                maximum_usage_usd as maximumUsageUsd,
                actual_usage_usd as actualUsageUsd,
                oldest_occurred_at as oldestOccurredAt,
                newest_occurred_at as newestOccurredAt,
                page_count as pageCount, pause_reason as pauseReason
         from context_backfills
         where scope_id = ? {{0}}
         order by id desc limit 1

-- name: contextStoreActivateDocumentRevisionInsertContextDocumentVectors
insert into context_document_vectors (document_id, embedding)
             values (?, ?)

-- name: deleteContextDocumentFts
delete from context_document_fts where rowid = ?

-- name: deleteContextDocumentVector
delete from context_document_vectors where document_id = ?

-- name: incompleteContextJobFilter
and status != 'completed'

-- name: insertContextDocumentFts
insert into context_document_fts (rowid, content) values (?, ?)

-- name: selectContextDocumentRevisions
select id, revision from context_documents
         where id in ({{0}}) order by id

-- name: sourceScopeHasSourceTombstoneSelectContextTombstones
select exists(
           select 1 from context_tombstones
           where scope_type = 'source'
             and scope_id in ({{0}})
         )

-- name: suppressContextDocuments
update context_documents
         set state = 'suppressed', content_state = 'scrubbed',
             content_state_reason = ?, summary = '', updated_at = ?
         where id in ({{0}})
