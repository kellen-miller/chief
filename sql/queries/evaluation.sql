-- name: conversationQualityCorpusReplayConversationQualityCaseUpdateConversationEvents :exec
update conversation_events
             set content = '', content_state = 'scrubbed',
                 content_state_reason = ? where id = ?;

-- name: conversationQualityCorpusInsertQualityDocumentInsertContextDocuments :exec
insert into context_documents
         (id, document_key, tier, period_start, period_end, timezone,
          topic_key, topic_label, revision, completeness, state,
          content_state, content_state_reason, summary, confidence,
          retention_deadline, created_at, updated_at, is_internal)
       values (?, ?, ?, ?, ?, 'America/New_York', ?, ?, 1, 'final',
               'active', 'available', 'retained', ?, 0.95, null, ?, ?, 0);

-- name: conversationQualityCorpusInsertQualityDocumentInsertContextDocumentEvents :exec
insert into context_document_events (document_id, event_id) values (?, ?);
