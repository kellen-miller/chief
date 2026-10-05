// Generated from sql/*.sql by sqlc and scripts/generate-sql.ts. DO NOT EDIT.
import type Database from 'better-sqlite3';

// better-sqlite3 types retain the row type after pluck(); expose its scalar result.
type PreparedStatement<P extends unknown[], R, S> = Omit<
  Database.Statement<P, R>,
  'pluck'
> & { pluck(): Database.Statement<P, S> };

export interface ConversationRecordSelectConversationEventsRow {
  id: number;
}

export function conversationRecordSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ConversationRecordSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ConversationRecordSelectConversationEventsRow
  >(
    'select id from conversation_events\n         where guild_id = ? and channel_id = ? and discord_message_id = ?',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ConversationRecordSelectConversationEventsRow,
    number
  >;
}

export interface ConversationSearchTextSourceGroupsSelectConversationEventsRow {
  id: number;
  content: string;
  discordMessageId: string;
  logicalResponseId: string | null;
  occurredAt: number;
  responseChunkIndex: number | null;
  role: string;
  speakerName: string | null;
}

export function conversationSearchTextSourceGroupsSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string | null, unknown, number | null],
  ConversationSearchTextSourceGroupsSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string | null, unknown, number | null],
    ConversationSearchTextSourceGroupsSelectConversationEventsRow
  >(
    "select id, content,\n                          discord_message_id as discordMessageId,\n                          logical_response_id as logicalResponseId,\n                          occurred_at as occurredAt,\n                          response_chunk_index as responseChunkIndex,\n                          role, speaker_name as speakerName\n                   from conversation_events\n                   where guild_id = ? and channel_id = ?\n                     and logical_response_id = ? and role = 'chief'\n                     and content_state = 'available'\n                     and (? is null or id < ?)\n                   order by coalesce(response_chunk_index, 2147483647), id",
  ) as unknown as PreparedStatement<
    [string, string, string | null, unknown, number | null],
    ConversationSearchTextSourceGroupsSelectConversationEventsRow,
    number
  >;
}

export interface ConversationMaintainSelectConversationEventsRow {
  id: number;
}

export function conversationMaintainSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [number],
  ConversationMaintainSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [number],
    ConversationMaintainSelectConversationEventsRow
  >(
    "select id from conversation_events\n           where medium = 'text' and content_state = 'available'\n             and retention_deadline <= ?",
  ) as unknown as PreparedStatement<
    [number],
    ConversationMaintainSelectConversationEventsRow,
    number
  >;
}

export function conversationMaintainUpdateConversationEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update conversation_events\n           set content = '', attachment_metadata_json = '[]',\n               content_state = 'scrubbed',\n               content_state_reason = 'retention-expired'\n           where medium = 'text' and content_state = 'available'\n             and retention_deadline <= ?",
  );
}

export function conversationMaintainDeleteConversationEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "delete from conversation_events\n           where medium = 'voice' and retention_deadline <= ?",
  );
}

export interface ContextActivateDocumentRevisionSelectContextDocumentsRow {
  max: unknown;
}

export function contextActivateDocumentRevisionSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextActivateDocumentRevisionSelectContextDocumentsRow,
  unknown
> {
  return database.prepare<
    [string],
    ContextActivateDocumentRevisionSelectContextDocumentsRow
  >('select max(revision) from context_documents where document_key = ?');
}

export interface ContextActivateDocumentRevisionSelectContextDocuments2Row {
  id: number;
}

export function contextActivateDocumentRevisionSelectContextDocuments2(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextActivateDocumentRevisionSelectContextDocuments2Row,
  number
> {
  return database.prepare<
    [string],
    ContextActivateDocumentRevisionSelectContextDocuments2Row
  >(
    "select id from context_documents\n           where document_key = ? and state = 'active'",
  ) as unknown as PreparedStatement<
    [string],
    ContextActivateDocumentRevisionSelectContextDocuments2Row,
    number
  >;
}

export function contextActivateDocumentRevisionUpdateContextDocuments(
  database: Database.Database,
): PreparedStatement<[number, string], unknown, unknown> {
  return database.prepare<[number, string]>(
    "update context_documents\n           set state = 'superseded', updated_at = ?\n           where document_key = ? and state = 'active'",
  );
}

export function contextActivateDocumentRevisionInsertContextDocumentEvents(
  database: Database.Database,
): PreparedStatement<[number, number], unknown, unknown> {
  return database.prepare<[number, number]>(
    'insert into context_document_events (document_id, event_id)\n         values (?, ?)',
  );
}

export function contextActivateDocumentRevisionInsertContextDocumentParents(
  database: Database.Database,
): PreparedStatement<[number, number], unknown, unknown> {
  return database.prepare<[number, number]>(
    'insert into context_document_parents\n           (document_id, parent_document_id)\n         values (?, ?)',
  );
}

export interface ContextAssertInputsAvailableSelectContextJobsRow {
  exists: number;
}

export function contextAssertInputsAvailableSelectContextJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null, string, string],
  ContextAssertInputsAvailableSelectContextJobsRow,
  number
> {
  return database.prepare<
    [number, number | null, string, string],
    ContextAssertInputsAvailableSelectContextJobsRow
  >(
    "select exists(\n             select 1 from context_jobs\n             where tier = 'hourly' and period_start = ? and period_end = ?\n               and timezone = ? and source_revision_checksum = ?\n           )",
  ) as unknown as PreparedStatement<
    [number, number | null, string, string],
    ContextAssertInputsAvailableSelectContextJobsRow,
    number
  >;
}

export interface ContextAssertInputsAvailableSelectConversationEventsRow {
  exists: number;
}

export function contextAssertInputsAvailableSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [number, unknown],
  ContextAssertInputsAvailableSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [number, unknown],
    ContextAssertInputsAvailableSelectConversationEventsRow
  >(
    "select exists(\n         select 1 from conversation_events\n         where id = ? and (\n           content_state = 'available'\n           or (? = 1 and content_state = 'scrubbed'\n               and content_state_reason = 'retention-expired')\n         )\n       )",
  ) as unknown as PreparedStatement<
    [number, unknown],
    ContextAssertInputsAvailableSelectConversationEventsRow,
    number
  >;
}

export interface ContextAssertInputsAvailableSelectConversationEvents2Row {
  '': unknown;
}

export function contextAssertInputsAvailableSelectConversationEvents2(
  database: Database.Database,
): PreparedStatement<
  [number],
  ContextAssertInputsAvailableSelectConversationEvents2Row,
  unknown
> {
  return database.prepare<
    [number],
    ContextAssertInputsAvailableSelectConversationEvents2Row
  >(
    "select guild_id || '/' || channel_id || '/' ||\n                        discord_message_id\n                 from conversation_events where id = ?",
  );
}

export interface ContextAssertInputsAvailableSelectContextDocumentsRow {
  exists: number;
}

export function contextAssertInputsAvailableSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [number],
  ContextAssertInputsAvailableSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [number],
    ContextAssertInputsAvailableSelectContextDocumentsRow
  >(
    "select exists(\n         select 1 from context_documents\n         where id = ? and state = 'active' and content_state = 'available'\n       )",
  ) as unknown as PreparedStatement<
    [number],
    ContextAssertInputsAvailableSelectContextDocumentsRow,
    number
  >;
}

export interface ContextAssertInputsAvailableSelectContextDocuments2Row {
  exists: number;
}

export function contextAssertInputsAvailableSelectContextDocuments2(
  database: Database.Database,
): PreparedStatement<
  [number],
  ContextAssertInputsAvailableSelectContextDocuments2Row,
  number
> {
  return database.prepare<
    [number],
    ContextAssertInputsAvailableSelectContextDocuments2Row
  >(
    "select exists(\n           select 1 from context_documents\n           where id = ? and completeness = 'final'\n         )",
  ) as unknown as PreparedStatement<
    [number],
    ContextAssertInputsAvailableSelectContextDocuments2Row,
    number
  >;
}

export interface ContextDeletionDiscoverMemberSelectConversationEventsRow {
  scopeId: unknown;
  speakerId: string | null;
}

export function contextDeletionDiscoverMemberSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ContextDeletionDiscoverMemberSelectConversationEventsRow,
  unknown
> {
  return database.prepare<
    [string, string, string],
    ContextDeletionDiscoverMemberSelectConversationEventsRow
  >(
    "select guild_id || '/' || channel_id || '/' || discord_message_id\n                  as scopeId,\n                speaker_id as speakerId\n         from conversation_events\n         where guild_id = ? and channel_id = ? and role = 'human'\n           and content_state_reason not in ('discord-deleted', 'locally-forgotten')\n           and lower(trim(speaker_name)) = lower(trim(?))\n         order by id",
  );
}

export function contextDeletionCreateConfirmationInsertContextDeletionRequests(
  database: Database.Database,
): PreparedStatement<
  [
    string,
    string,
    string,
    string,
    string,
    number,
    number,
    string,
    string,
    string,
    string,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      string,
      string,
    ]
  >(
    "insert into context_deletion_requests\n           (id, requester_id, scope_type, scope_id, confirmation_checksum,\n            status, expires_at, created_at, source_ids_json,\n            document_ids_json, memory_ids_json, request_source_id)\n         values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
  );
}

export interface ContextDeletionConfirmationSelectContextDeletionRequestsRow {
  id: string;
  status: string;
  expiresAt: number;
  sourceIdsJson: string;
  documentIdsJson: string;
  memoryIdsJson: string;
  requestSourceScopeId: string;
}

export function contextDeletionConfirmationSelectContextDeletionRequests(
  database: Database.Database,
): PreparedStatement<
  [string, string],
  ContextDeletionConfirmationSelectContextDeletionRequestsRow,
  string
> {
  return database.prepare<
    [string, string],
    ContextDeletionConfirmationSelectContextDeletionRequestsRow
  >(
    'select id, status, expires_at as expiresAt,\n                  source_ids_json as sourceIdsJson,\n                  document_ids_json as documentIdsJson,\n                  memory_ids_json as memoryIdsJson,\n                  request_source_id as requestSourceScopeId\n           from context_deletion_requests\n           where requester_id = ? and confirmation_checksum = ?\n           order by created_at desc limit 1',
  ) as unknown as PreparedStatement<
    [string, string],
    ContextDeletionConfirmationSelectContextDeletionRequestsRow,
    string
  >;
}

export function contextDeletionConfirmationDeleteContextDeletionRequests(
  database: Database.Database,
): PreparedStatement<[string], unknown, unknown> {
  return database.prepare<[string]>(
    'delete from context_deletion_requests where id = ?',
  );
}

export function contextDeletionDeleteUpdateContextDeletionRequests(
  database: Database.Database,
): PreparedStatement<[number | null, string, number], unknown, unknown> {
  return database.prepare<[number | null, string, number]>(
    "update context_deletion_requests\n             set status = 'consumed', consumed_at = ?\n             where id = ? and status = 'pending' and expires_at > ?",
  );
}

export function contextDeletionDeleteInsertContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [string, string, string, number, string, string],
  unknown,
  unknown
> {
  return database.prepare<[string, string, string, number, string, string]>(
    'insert into context_forget_journal\n             (journal_key, scope_id, tombstone_key, occurred_at, checksum,\n              payload_json)\n           values (?, ?, ?, ?, ?, ?)',
  );
}

export function contextDeletionSuppressSourceInsertContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [string, string, string, number, string, string],
  unknown,
  unknown
> {
  return database.prepare<[string, string, string, number, string, string]>(
    'insert into context_forget_journal\n               (journal_key, scope_id, tombstone_key, occurred_at, checksum,\n                payload_json)\n             values (?, ?, ?, ?, ?, ?)\n             on conflict(journal_key) do nothing',
  );
}

export function contextDeletionSuppressSourceInsertContextForgetJournal2(
  database: Database.Database,
): PreparedStatement<
  [string, string, string, number, string, string, number | null],
  unknown,
  unknown
> {
  return database.prepare<
    [string, string, string, number, string, string, number | null]
  >(
    "insert into context_forget_journal\n               (journal_key, scope_id, tombstone_key, occurred_at, checksum,\n                payload_json, upload_status, uploaded_at)\n             values (?, ?, ?, ?, ?, ?, 'uploaded', ?)\n             on conflict(journal_key) do update set\n               upload_status = 'uploaded', uploaded_at = excluded.uploaded_at,\n               next_attempt_at = null, last_error_category = null\n             where checksum = excluded.checksum",
  );
}

export interface ContextDeletionSuppressSourceSelectContextForgetJournalRow {
  id: number;
  journalKey: string;
  occurredAt: number;
  checksum: string;
  payloadJson: string;
  uploadStatus: string;
}

export function contextDeletionSuppressSourceSelectContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextDeletionSuppressSourceSelectContextForgetJournalRow,
  number
> {
  return database.prepare<
    [string],
    ContextDeletionSuppressSourceSelectContextForgetJournalRow
  >(
    'select id, journal_key as journalKey, occurred_at as occurredAt,\n                  checksum, payload_json as payloadJson,\n                  upload_status as uploadStatus\n           from context_forget_journal where journal_key = ?',
  ) as unknown as PreparedStatement<
    [string],
    ContextDeletionSuppressSourceSelectContextForgetJournalRow,
    number
  >;
}

export interface ContextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournalRow {
  journalKey: string;
  occurredAt: number;
  checksum: string;
  payloadJson: string;
  uploadStatus: string;
}

export function contextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournalRow,
  string
> {
  return database.prepare<
    [string],
    ContextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournalRow
  >(
    'select journal_key as journalKey, occurred_at as occurredAt,\n                checksum, payload_json as payloadJson,\n                upload_status as uploadStatus\n         from context_forget_journal where journal_key = ?',
  ) as unknown as PreparedStatement<
    [string],
    ContextDeletionPrepareAuthoritativeSourceJournalSelectContextForgetJournalRow,
    string
  >;
}

export function contextDeletionMarkJournalUploadedUpdateContextForgetJournal(
  database: Database.Database,
): PreparedStatement<[number | null, number], unknown, unknown> {
  return database.prepare<[number | null, number]>(
    "update context_forget_journal\n         set upload_status = 'uploaded', uploaded_at = ?,\n             next_attempt_at = null, last_error_category = null\n         where id = ? and upload_status != 'uploaded'",
  );
}

export function contextDeletionMarkJournalFailedUpdateContextForgetJournal(
  database: Database.Database,
): PreparedStatement<[number | null, number], unknown, unknown> {
  return database.prepare<[number | null, number]>(
    "update context_forget_journal\n         set upload_status = 'failed', attempt_count = attempt_count + 1,\n             next_attempt_at = ?, last_error_category = 'upload'\n         where id = ? and upload_status != 'uploaded'",
  );
}

export interface ContextDeletionNextForgetJournalSelectContextForgetJournalRow {
  id: number;
  journalKey: string;
  occurredAt: number;
  checksum: string;
  payloadJson: string;
}

export function contextDeletionNextForgetJournalSelectContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ContextDeletionNextForgetJournalSelectContextForgetJournalRow,
  number
> {
  return database.prepare<
    [number | null],
    ContextDeletionNextForgetJournalSelectContextForgetJournalRow
  >(
    "select id, journal_key as journalKey, occurred_at as occurredAt,\n                checksum, payload_json as payloadJson\n         from context_forget_journal\n         where upload_status in ('pending', 'failed')\n           and (next_attempt_at is null or next_attempt_at <= ?)\n         order by occurred_at, id limit 1",
  ) as unknown as PreparedStatement<
    [number | null],
    ContextDeletionNextForgetJournalSelectContextForgetJournalRow,
    number
  >;
}

export function contextDeletionReplayForgetJournalInsertContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [string, string, string, number, string, string, number | null],
  unknown,
  unknown
> {
  return database.prepare<
    [string, string, string, number, string, string, number | null]
  >(
    "insert into context_forget_journal\n             (journal_key, scope_id, tombstone_key, occurred_at, checksum,\n              payload_json, upload_status, uploaded_at)\n           values (?, ?, ?, ?, ?, ?, 'uploaded', ?)\n           on conflict(journal_key) do update set\n             upload_status = 'uploaded', uploaded_at = excluded.uploaded_at,\n             next_attempt_at = null, last_error_category = null",
  );
}

export function contextDeletionInsertTombstoneInsertContextTombstones(
  database: Database.Database,
): PreparedStatement<
  [string, string, string, string, number, string],
  unknown,
  unknown
> {
  return database.prepare<[string, string, string, string, number, string]>(
    'insert into context_tombstones\n           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)\n         values (?, ?, ?, ?, ?, ?)\n         on conflict(scope_type, scope_id) do nothing',
  );
}

export interface ContextDeletionEnqueueRebuildsSelectConversationEventsRow {
  id: number;
  discordMessageId: string;
  content: string;
  editedAt: number | null;
}

export function contextDeletionEnqueueRebuildsSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, number, number],
  ContextDeletionEnqueueRebuildsSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, number, number],
    ContextDeletionEnqueueRebuildsSelectConversationEventsRow
  >(
    "select id, discord_message_id as discordMessageId, content,\n                  edited_at as editedAt\n           from conversation_events\n           where guild_id = ? and channel_id = ? and medium = 'text'\n             and content_state = 'available'\n             and occurred_at >= ? and occurred_at < ? order by id",
  ) as unknown as PreparedStatement<
    [string, string, number, number],
    ContextDeletionEnqueueRebuildsSelectConversationEventsRow,
    number
  >;
}

export function contextDeletionEnqueueRebuildsUpdateContextJobs(
  database: Database.Database,
): PreparedStatement<
  [string, number, number, string, number, number | null],
  unknown,
  unknown
> {
  return database.prepare<
    [string, number, number, string, number, number | null]
  >(
    "update context_jobs\n           set source_revision_checksum = ?, status = 'pending',\n               not_before = ?, freshness_deadline = ?, lease_expires_at = null,\n               last_error_category = 'rebuild'\n           where tier = 'hourly' and timezone = ?\n             and period_start = ? and period_end = ?",
  );
}

export interface ContextDeletionEnqueueRebuildsSelectContextDocumentsRow {
  id: number;
  revision: number;
}

export function contextDeletionEnqueueRebuildsSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string, number, number | null],
  ContextDeletionEnqueueRebuildsSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [string, number, number | null],
    ContextDeletionEnqueueRebuildsSelectContextDocumentsRow
  >(
    "select id, revision from context_documents\n           where tier = ? and completeness = 'final' and state = 'active'\n             and content_state = 'available' and is_internal = 0\n             and period_start >= ? and period_end <= ?\n           order by period_start, id",
  ) as unknown as PreparedStatement<
    [string, number, number | null],
    ContextDeletionEnqueueRebuildsSelectContextDocumentsRow,
    number
  >;
}

export function contextDeletionEnqueueRebuildsUpdateContextJobs2(
  database: Database.Database,
): PreparedStatement<
  [string, number, number, string, string, number, number | null],
  unknown,
  unknown
> {
  return database.prepare<
    [string, number, number, string, string, number, number | null]
  >(
    "update context_jobs\n           set source_revision_checksum = ?, status = 'pending',\n               not_before = ?, freshness_deadline = ?, lease_expires_at = null,\n               last_error_category = 'rebuild'\n           where tier = ? and timezone = ?\n             and period_start = ? and period_end = ?",
  );
}

export interface ContextDeletionEnqueueRebuildsSelectContextJobsRow {
  id: number;
  sourceDocumentIdsJson: string;
}

export function contextDeletionEnqueueRebuildsSelectContextJobs(
  database: Database.Database,
): PreparedStatement<
  [string | null],
  ContextDeletionEnqueueRebuildsSelectContextJobsRow,
  number
> {
  return database.prepare<
    [string | null],
    ContextDeletionEnqueueRebuildsSelectContextJobsRow
  >(
    "select id, source_document_ids_json as sourceDocumentIdsJson\n           from context_jobs where tier = 'long-term' and topic_key = ?",
  ) as unknown as PreparedStatement<
    [string | null],
    ContextDeletionEnqueueRebuildsSelectContextJobsRow,
    number
  >;
}

export function contextDeletionEnqueueRebuildsUpdateContextJobs3(
  database: Database.Database,
): PreparedStatement<
  [string, string, number, number, number],
  unknown,
  unknown
> {
  return database.prepare<[string, string, number, number, number]>(
    "update context_jobs\n             set source_revision_checksum = ?, source_document_ids_json = ?,\n                 status = 'pending', not_before = ?, freshness_deadline = ?,\n                 lease_expires_at = null, last_error_category = 'rebuild'\n             where id = ?",
  );
}

export interface ContextDeletionUnavailableDocumentSourceScopesSelectConversationEventsRow {
  exists: number;
}

export function contextDeletionUnavailableDocumentSourceScopesSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextDeletionUnavailableDocumentSourceScopesSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string],
    ContextDeletionUnavailableDocumentSourceScopesSelectConversationEventsRow
  >(
    "select exists(\n             select 1 from conversation_events c\n             where c.guild_id || '/' || c.channel_id || '/' ||\n                   c.discord_message_id = ?\n               and c.content_state = 'available'\n           )",
  ) as unknown as PreparedStatement<
    [string],
    ContextDeletionUnavailableDocumentSourceScopesSelectConversationEventsRow,
    number
  >;
}

export interface ContextDeletionSourceBelongsToSelectConversationEventsRow {
  exists: number;
}

export function contextDeletionSourceBelongsToSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string | null],
  ContextDeletionSourceBelongsToSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string | null],
    ContextDeletionSourceBelongsToSelectConversationEventsRow
  >(
    "select exists(\n             select 1 from conversation_events\n             where guild_id || '/' || channel_id || '/' ||\n                     discord_message_id = ? and speaker_id = ?\n           )",
  ) as unknown as PreparedStatement<
    [string, string | null],
    ContextDeletionSourceBelongsToSelectConversationEventsRow,
    number
  >;
}

export interface ContextBackfillNextDeadlineSelectContextBackfillsRow {
  min: unknown;
}

export function contextBackfillNextDeadlineSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextBackfillNextDeadlineSelectContextBackfillsRow,
  unknown
> {
  return database.prepare<
    [string],
    ContextBackfillNextDeadlineSelectContextBackfillsRow
  >(
    "select min(coalesce(b.activated_at, b.created_at))\n           from context_backfills b\n           where b.scope_id = ? and b.status = 'active'\n             and (\n               b.next_page_index is not null\n               or exists(\n                 select 1 from context_jobs j\n                 where j.backfill_run_id = b.id and j.status = 'failed'\n               )\n               or not exists(\n                 select 1 from context_jobs j\n                 where j.backfill_run_id = b.id\n                   and j.status in ('pending', 'leased')\n               )\n             )",
  );
}

export interface ContextBackfillRunNextSelectContextDocumentsRow {
  coalesce: unknown;
}

export function contextBackfillRunNextSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextBackfillRunNextSelectContextDocumentsRow,
  unknown
> {
  return database.prepare<
    [string],
    ContextBackfillRunNextSelectContextDocumentsRow
  >(
    'select coalesce(max(revision), 0) from context_documents\n                 where document_key = ?',
  );
}

export function contextBackfillRunNextInsertContextBackfillSegments(
  database: Database.Database,
): PreparedStatement<
  [
    number,
    string,
    number,
    number,
    number,
    string,
    number,
    number | null,
    number,
    number,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      number,
      string,
      number,
      number,
      number,
      string,
      number,
      number | null,
      number,
      number,
    ]
  >(
    'insert into context_backfill_segments\n               (run_id, segment_key, page_index, period_start, period_end,\n                source_checksum, source_count, document_id,\n                actual_usage_usd, committed_at)\n             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
}

export interface ContextBackfillActivateSelectContextBackfillsRow {
  id: number;
}

export function contextBackfillActivateSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextBackfillActivateSelectContextBackfillsRow,
  number
> {
  return database.prepare<
    [string],
    ContextBackfillActivateSelectContextBackfillsRow
  >(
    "select id from context_backfills\n         where scope_id = ? and status = 'ready'\n         order by id desc limit 1",
  ) as unknown as PreparedStatement<
    [string],
    ContextBackfillActivateSelectContextBackfillsRow,
    number
  >;
}

export function contextBackfillActivateUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number | null, number | null, number, number],
  unknown,
  unknown
> {
  return database.prepare<[number | null, number | null, number, number]>(
    "update context_backfills\n         set status = 'active', maximum_usage_usd = ?, activated_at = ?,\n             pause_reason = null, updated_at = ?\n         where id = ? and status = 'ready'",
  );
}

export interface ContextBackfillDryRunSelectContextBackfillsRow {
  id: number;
  status: string;
}

export function contextBackfillDryRunSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextBackfillDryRunSelectContextBackfillsRow,
  number
> {
  return database.prepare<
    [string],
    ContextBackfillDryRunSelectContextBackfillsRow
  >(
    "select id, status from context_backfills\n         where scope_id = ?\n           and status in ('dry-run', 'ready', 'active', 'paused')\n         order by id desc limit 1",
  ) as unknown as PreparedStatement<
    [string],
    ContextBackfillDryRunSelectContextBackfillsRow,
    number
  >;
}

export interface ContextBackfillDryRunSelectUsageLedgerRow {
  exists: number;
}

export function contextBackfillDryRunSelectUsageLedger(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ContextBackfillDryRunSelectUsageLedgerRow,
  number
> {
  return database.prepare<
    [number | null],
    ContextBackfillDryRunSelectUsageLedgerRow
  >(
    'select exists(\n               select 1 from usage_ledger\n               where backfill_run_id = ? and actual_usd is null\n             )',
  ) as unknown as PreparedStatement<
    [number | null],
    ContextBackfillDryRunSelectUsageLedgerRow,
    number
  >;
}

export function contextBackfillDryRunUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<[number, number], unknown, unknown> {
  return database.prepare<[number, number]>(
    "update context_backfills\n             set status = 'failed', pause_reason = 'replaced', updated_at = ?\n             where id = ?",
  );
}

export function contextBackfillDryRunInsertContextBackfills(
  database: Database.Database,
): PreparedStatement<[string, string, number, number], unknown, unknown> {
  return database.prepare<[string, string, number, number]>(
    "insert into context_backfills\n               (run_key, scope_id, status, created_at, updated_at)\n             values (?, ?, 'dry-run', ?, ?)",
  );
}

export function contextBackfillResumeUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<[number, number, string], unknown, unknown> {
  return database.prepare<[number, number, string]>(
    "update context_backfills\n         set status = 'active', pause_reason = null, updated_at = ?\n         where id = ? and scope_id = ? and status = 'paused'",
  );
}

export interface ContextBackfillScanDryRunSelectContextBackfillsRow {
  cursorSourceId: string | null;
  pageCount: number;
}

export function contextBackfillScanDryRunSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number, string],
  ContextBackfillScanDryRunSelectContextBackfillsRow,
  string | null
> {
  return database.prepare<
    [number, string],
    ContextBackfillScanDryRunSelectContextBackfillsRow
  >(
    "select cursor_source_id as cursorSourceId,\n                page_count as pageCount\n         from context_backfills\n         where id = ? and scope_id = ? and status = 'dry-run'",
  ) as unknown as PreparedStatement<
    [number, string],
    ContextBackfillScanDryRunSelectContextBackfillsRow,
    string | null
  >;
}

export interface ContextBackfillRecordManifestPageSelectConversationEventsRow {
  exists: number;
}

export function contextBackfillRecordManifestPageSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ContextBackfillRecordManifestPageSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ContextBackfillRecordManifestPageSelectConversationEventsRow
  >(
    'select exists(\n             select 1 from conversation_events\n             where guild_id = ? and channel_id = ? and discord_message_id = ?\n           )',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ContextBackfillRecordManifestPageSelectConversationEventsRow,
    number
  >;
}

export function contextBackfillRecordManifestPageInsertContextBackfillPages(
  database: Database.Database,
): PreparedStatement<
  [
    number,
    number,
    string | null,
    string,
    string,
    number,
    number,
    number,
    string,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      number,
      number,
      string | null,
      string,
      string,
      number,
      number,
      number,
      string,
    ]
  >(
    'insert into context_backfill_pages\n             (run_id, page_index, request_before_source_id,\n              oldest_source_id, newest_source_id, eligible_count,\n              eligible_bytes, eligible_tokens, identity_checksum)\n           values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
}

export function contextBackfillRecordManifestPageUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [
    string | null,
    number,
    number,
    number,
    number,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    unknown,
    unknown,
    number | null,
    unknown,
    unknown,
    number | null,
    number,
    number,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string | null,
      number,
      number,
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      unknown,
      unknown,
      number | null,
      unknown,
      unknown,
      number | null,
      number,
      number,
    ]
  >(
    "update context_backfills set\n             cursor_source_id = ?, eligible_count = eligible_count + ?,\n             already_ingested_count = already_ingested_count + ?,\n             eligible_bytes = eligible_bytes + ?,\n             eligible_tokens = eligible_tokens + ?, page_count = page_count + 1,\n             oldest_source_id = case\n               when oldest_source_id is null then ?\n               when cast(? as integer) < cast(oldest_source_id as integer)\n                 then ? else oldest_source_id end,\n             newest_source_id = case\n               when newest_source_id is null then ?\n               when cast(? as integer) > cast(newest_source_id as integer)\n                 then ? else newest_source_id end,\n             oldest_occurred_at = case\n               when ? is null then oldest_occurred_at\n               when oldest_occurred_at is null then ?\n               else min(oldest_occurred_at, ?) end,\n             newest_occurred_at = case\n               when ? is null then newest_occurred_at\n               when newest_occurred_at is null then ?\n               else max(newest_occurred_at, ?) end,\n             updated_at = ? where id = ? and status = 'dry-run'",
  );
}

export interface ContextBackfillCompleteManifestSelectContextBackfillPagesRow {
  pageIndex: number;
  requestBeforeSourceId: string | null;
  oldestSourceId: string;
  newestSourceId: string;
  eligibleCount: number;
  eligibleBytes: number;
  eligibleTokens: number;
  identityChecksum: string;
}

export function contextBackfillCompleteManifestSelectContextBackfillPages(
  database: Database.Database,
): PreparedStatement<
  [number],
  ContextBackfillCompleteManifestSelectContextBackfillPagesRow,
  number
> {
  return database.prepare<
    [number],
    ContextBackfillCompleteManifestSelectContextBackfillPagesRow
  >(
    'select page_index as pageIndex,\n                request_before_source_id as requestBeforeSourceId,\n                oldest_source_id as oldestSourceId,\n                newest_source_id as newestSourceId,\n                eligible_count as eligibleCount,\n                eligible_bytes as eligibleBytes,\n                eligible_tokens as eligibleTokens,\n                identity_checksum as identityChecksum\n         from context_backfill_pages where run_id = ? order by page_index',
  ) as unknown as PreparedStatement<
    [number],
    ContextBackfillCompleteManifestSelectContextBackfillPagesRow,
    number
  >;
}

export interface ContextBackfillCompleteManifestSelectContextBackfillsRow {
  eligible_tokens: number;
}

export function contextBackfillCompleteManifestSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number],
  ContextBackfillCompleteManifestSelectContextBackfillsRow,
  number
> {
  return database.prepare<
    [number],
    ContextBackfillCompleteManifestSelectContextBackfillsRow
  >(
    'select eligible_tokens from context_backfills where id = ?',
  ) as unknown as PreparedStatement<
    [number],
    ContextBackfillCompleteManifestSelectContextBackfillsRow,
    number
  >;
}

export function contextBackfillCompleteManifestUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number | null, number, string | null, number, number],
  unknown,
  unknown
> {
  return database.prepare<
    [number | null, number, string | null, number, number]
  >(
    "update context_backfills\n         set status = 'ready', cursor_source_id = null,\n             next_page_index = ?, estimated_usage_usd = ?,\n             manifest_checksum = ?, updated_at = ?\n         where id = ? and status = 'dry-run'",
  );
}

export interface ContextBackfillManifestSeenIdsSelectContextBackfillPagesRow {
  requestBeforeSourceId: string | null;
}

export function contextBackfillManifestSeenIdsSelectContextBackfillPages(
  database: Database.Database,
): PreparedStatement<
  [number],
  ContextBackfillManifestSeenIdsSelectContextBackfillPagesRow,
  string | null
> {
  return database.prepare<
    [number],
    ContextBackfillManifestSeenIdsSelectContextBackfillPagesRow
  >(
    'select request_before_source_id as requestBeforeSourceId\n         from context_backfill_pages\n         where run_id = ? order by page_index',
  ) as unknown as PreparedStatement<
    [number],
    ContextBackfillManifestSeenIdsSelectContextBackfillPagesRow,
    string | null
  >;
}

export interface ContextBackfillActiveRunSelectContextBackfillsRow {
  runId: number;
  nextPageIndex: number | null;
}

export function contextBackfillActiveRunSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [string],
  ContextBackfillActiveRunSelectContextBackfillsRow,
  number
> {
  return database.prepare<
    [string],
    ContextBackfillActiveRunSelectContextBackfillsRow
  >(
    "select id as runId, next_page_index as nextPageIndex\n           from context_backfills\n           where scope_id = ? and status = 'active'\n           order by activated_at, id limit 1",
  ) as unknown as PreparedStatement<
    [string],
    ContextBackfillActiveRunSelectContextBackfillsRow,
    number
  >;
}

export interface ContextBackfillPageSelectContextBackfillPagesRow {
  pageIndex: number;
  requestBeforeSourceId: string | null;
  oldestSourceId: string;
  newestSourceId: string;
  completedAt: number | null;
}

export function contextBackfillPageSelectContextBackfillPages(
  database: Database.Database,
): PreparedStatement<
  [number, number],
  ContextBackfillPageSelectContextBackfillPagesRow,
  number
> {
  return database.prepare<
    [number, number],
    ContextBackfillPageSelectContextBackfillPagesRow
  >(
    'select page_index as pageIndex,\n                  request_before_source_id as requestBeforeSourceId,\n                  oldest_source_id as oldestSourceId,\n                  newest_source_id as newestSourceId,\n                  completed_at as completedAt\n           from context_backfill_pages\n           where run_id = ? and page_index = ?',
  ) as unknown as PreparedStatement<
    [number, number],
    ContextBackfillPageSelectContextBackfillPagesRow,
    number
  >;
}

export interface ContextBackfillSourceEligibleForRunSelectConversationEventsRow {
  id: number;
  contentState: string;
  contentStateReason: string;
  revisionChecksum: string;
}

export function contextBackfillSourceEligibleForRunSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ContextBackfillSourceEligibleForRunSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ContextBackfillSourceEligibleForRunSelectConversationEventsRow
  >(
    'select id, content_state as contentState,\n                content_state_reason as contentStateReason,\n                revision_checksum as revisionChecksum\n         from conversation_events\n         where guild_id = ? and channel_id = ? and discord_message_id = ?',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ContextBackfillSourceEligibleForRunSelectConversationEventsRow,
    number
  >;
}

export interface ContextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentitiesRow {
  firstPageIndex: number;
  revisionChecksum: string;
}

export function contextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentities(
  database: Database.Database,
): PreparedStatement<
  [number, string, number],
  ContextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentitiesRow,
  number
> {
  return database.prepare<
    [number, string, number],
    ContextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentitiesRow
  >(
    'select first_page_index as firstPageIndex,\n                revision_checksum as revisionChecksum\n         from context_backfill_source_identities\n         where run_id = ? and message_id = ? and event_id = ?',
  ) as unknown as PreparedStatement<
    [number, string, number],
    ContextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentitiesRow,
    number
  >;
}

export interface ContextBackfillSegmentCommittedSelectContextBackfillSegmentsRow {
  source_checksum: string;
}

export function contextBackfillSegmentCommittedSelectContextBackfillSegments(
  database: Database.Database,
): PreparedStatement<
  [number, string],
  ContextBackfillSegmentCommittedSelectContextBackfillSegmentsRow,
  string
> {
  return database.prepare<
    [number, string],
    ContextBackfillSegmentCommittedSelectContextBackfillSegmentsRow
  >(
    'select source_checksum from context_backfill_segments\n         where run_id = ? and segment_key = ?',
  ) as unknown as PreparedStatement<
    [number, string],
    ContextBackfillSegmentCommittedSelectContextBackfillSegmentsRow,
    string
  >;
}

export interface ContextBackfillPriorAggregateDocumentSelectContextDocumentsRow {
  id: number;
  summary: string;
}

export function contextBackfillPriorAggregateDocumentSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string, number, number | null, string],
  ContextBackfillPriorAggregateDocumentSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [string, number, number | null, string],
    ContextBackfillPriorAggregateDocumentSelectContextDocumentsRow
  >(
    "select id, summary from context_documents\n         where document_key = ? and tier = 'hourly'\n           and period_start = ? and period_end = ? and timezone = ?\n           and state = 'active' and content_state = 'available'\n           and is_internal = 0\n         order by revision desc limit 1",
  ) as unknown as PreparedStatement<
    [string, number, number | null, string],
    ContextBackfillPriorAggregateDocumentSelectContextDocumentsRow,
    number
  >;
}

export interface ContextBackfillExistingRevisionSelectConversationEventsRow {
  occurredAt: number;
  editedAt: number | null;
  revisionChecksum: string;
}

export function contextBackfillExistingRevisionSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ContextBackfillExistingRevisionSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ContextBackfillExistingRevisionSelectConversationEventsRow
  >(
    'select occurred_at as occurredAt, edited_at as editedAt,\n                  revision_checksum as revisionChecksum\n           from conversation_events\n           where guild_id = ? and channel_id = ? and discord_message_id = ?',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ContextBackfillExistingRevisionSelectConversationEventsRow,
    number
  >;
}

export interface ContextBackfillAssertSegmentCommitCurrentSelectContextBackfillsRow {
  exists: number;
}

export function contextBackfillAssertSegmentCommitCurrentSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number, string, number | null],
  ContextBackfillAssertSegmentCommitCurrentSelectContextBackfillsRow,
  number
> {
  return database.prepare<
    [number, string, number | null],
    ContextBackfillAssertSegmentCommitCurrentSelectContextBackfillsRow
  >(
    "select exists(\n           select 1 from context_backfills\n           where id = ? and scope_id = ? and status = 'active'\n             and next_page_index = ?\n         )",
  ) as unknown as PreparedStatement<
    [number, string, number | null],
    ContextBackfillAssertSegmentCommitCurrentSelectContextBackfillsRow,
    number
  >;
}

export interface ContextBackfillInsertExpiredIdentitySelectConversationEventsRow {
  id: number;
}

export function contextBackfillInsertExpiredIdentitySelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ContextBackfillInsertExpiredIdentitySelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ContextBackfillInsertExpiredIdentitySelectConversationEventsRow
  >(
    'select id from conversation_events\n         where guild_id = ? and channel_id = ? and discord_message_id = ?',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ContextBackfillInsertExpiredIdentitySelectConversationEventsRow,
    number
  >;
}

export function contextBackfillInsertExpiredIdentityInsertConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [
    string,
    string,
    string,
    string,
    string,
    string | null,
    string | null,
    number,
    number | null,
    number,
    number,
    string,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      number,
      number | null,
      number,
      number,
      string,
    ]
  >(
    "insert into conversation_events\n             (platform_event_id, discord_message_id, guild_id, channel_id,\n              request_id, logical_response_id, role, speaker_id, speaker_name,\n              medium, reply_to_message_id, content,\n              attachment_metadata_json, occurred_at, edited_at, deleted_at,\n              recent_until, retention_deadline, content_state,\n              content_state_reason, revision_checksum, response_chunk_index)\n           values (?, ?, ?, ?, null, null, ?, ?, null, 'text', ?, '', '[]',\n                   ?, ?, null, ?, ?, 'scrubbed', 'retention-expired', ?, null)",
  );
}

export function contextBackfillInsertExpiredIdentityInsertContextBackfillSourceIdentities(
  database: Database.Database,
): PreparedStatement<
  [number, string, number, number, string, number],
  unknown,
  unknown
> {
  return database.prepare<[number, string, number, number, string, number]>(
    'insert into context_backfill_source_identities\n           (run_id, message_id, event_id, first_page_index,\n            revision_checksum, occurred_at)\n         values (?, ?, ?, ?, ?, ?)\n         on conflict(run_id, message_id) do nothing',
  );
}

export interface ContextBackfillScheduleDailySelectContextDocumentsRow {
  id: number;
  revision: number;
}

export function contextBackfillScheduleDailySelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [number, number | null],
  ContextBackfillScheduleDailySelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [number, number | null],
    ContextBackfillScheduleDailySelectContextDocumentsRow
  >(
    "select id, revision from context_documents\n         where tier = 'hourly' and completeness = 'final'\n           and state = 'active' and content_state = 'available'\n           and is_internal = 0 and period_start >= ? and period_end <= ?\n         order by period_start, id",
  ) as unknown as PreparedStatement<
    [number, number | null],
    ContextBackfillScheduleDailySelectContextDocumentsRow,
    number
  >;
}

export function contextBackfillScheduleDailyInsertContextJobs(
  database: Database.Database,
): PreparedStatement<
  [
    string,
    number,
    number | null,
    string,
    string,
    number,
    number,
    number | null,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string,
      number,
      number | null,
      string,
      string,
      number,
      number,
      number | null,
    ]
  >(
    "insert into context_jobs\n           (job_key, tier, period_start, period_end, timezone, topic_key,\n            completeness, source_revision_checksum, not_before,\n            freshness_deadline, source_document_ids_json, backfill_run_id)\n         values (?, 'daily', ?, ?, ?, null, 'final', ?, ?, ?, '[]', ?)\n         on conflict(job_key) do update set\n           source_revision_checksum = excluded.source_revision_checksum,\n           status = case\n             when context_jobs.source_revision_checksum !=\n                  excluded.source_revision_checksum\n             then 'pending' else context_jobs.status end,\n           not_before = case\n             when context_jobs.source_revision_checksum !=\n                  excluded.source_revision_checksum\n             then excluded.not_before else context_jobs.not_before end,\n           lease_expires_at = case\n             when context_jobs.source_revision_checksum !=\n                  excluded.source_revision_checksum\n             then null else context_jobs.lease_expires_at end,\n           usage_reservation_id = case\n             when context_jobs.source_revision_checksum !=\n                  excluded.source_revision_checksum\n             then null else context_jobs.usage_reservation_id end,\n           last_error_category = case\n             when context_jobs.source_revision_checksum !=\n                  excluded.source_revision_checksum\n             then null else context_jobs.last_error_category end,\n           backfill_run_id = case\n             when excluded.backfill_run_id is not null\n             then excluded.backfill_run_id\n             when context_jobs.status = 'completed' then null\n             else context_jobs.backfill_run_id end",
  );
}

export function contextBackfillCompletePageUpdateContextBackfillPages(
  database: Database.Database,
): PreparedStatement<[number | null, number, number], unknown, unknown> {
  return database.prepare<[number | null, number, number]>(
    'update context_backfill_pages set completed_at = coalesce(completed_at, ?)\n         where run_id = ? and page_index = ?',
  );
}

export function contextBackfillCompletePageUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number | null, unknown, number, number, number | null],
  unknown,
  unknown
> {
  return database.prepare<
    [number | null, unknown, number, number, number | null]
  >(
    "update context_backfills\n         set next_page_index = case when ? < 0 then null else ? end,\n             updated_at = ?\n         where id = ? and status = 'active' and next_page_index = ?",
  );
}

export interface ContextBackfillFinalizeRunSelectContextJobsRow {
  count: number;
}

export function contextBackfillFinalizeRunSelectContextJobs(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ContextBackfillFinalizeRunSelectContextJobsRow,
  number
> {
  return database.prepare<
    [number | null],
    ContextBackfillFinalizeRunSelectContextJobsRow
  >(
    "select count(*) from context_jobs\n           where backfill_run_id = ? and status = 'failed'",
  ) as unknown as PreparedStatement<
    [number | null],
    ContextBackfillFinalizeRunSelectContextJobsRow,
    number
  >;
}

export interface ContextBackfillFinalizeRunSelectContextJobs2Row {
  count: number;
}

export function contextBackfillFinalizeRunSelectContextJobs2(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ContextBackfillFinalizeRunSelectContextJobs2Row,
  number
> {
  return database.prepare<
    [number | null],
    ContextBackfillFinalizeRunSelectContextJobs2Row
  >(
    "select count(*) from context_jobs\n           where backfill_run_id = ? and status in ('pending', 'leased')",
  ) as unknown as PreparedStatement<
    [number | null],
    ContextBackfillFinalizeRunSelectContextJobs2Row,
    number
  >;
}

export interface ContextBackfillFinalizeRunSelectUsageLedgerRow {
  count: number;
}

export function contextBackfillFinalizeRunSelectUsageLedger(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ContextBackfillFinalizeRunSelectUsageLedgerRow,
  number
> {
  return database.prepare<
    [number | null],
    ContextBackfillFinalizeRunSelectUsageLedgerRow
  >(
    'select count(*) from usage_ledger\n           where backfill_run_id = ? and actual_usd is null',
  ) as unknown as PreparedStatement<
    [number | null],
    ContextBackfillFinalizeRunSelectUsageLedgerRow,
    number
  >;
}

export function contextBackfillFinalizeRunUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<[number | null, number, number], unknown, unknown> {
  return database.prepare<[number | null, number, number]>(
    "update context_backfills\n         set status = 'completed', completed_at = ?, updated_at = ?\n         where id = ? and status = 'active' and next_page_index is null",
  );
}

export function contextBackfillPauseUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<[string | null, number, number], unknown, unknown> {
  return database.prepare<[string | null, number, number]>(
    "update context_backfills\n         set status = 'paused', pause_reason = ?, updated_at = ?\n         where id = ? and status = 'active'",
  );
}

export interface ContextBackfillRecoverOutstandingReservationsSelectUsageLedgerRow {
  id: string;
}

export function contextBackfillRecoverOutstandingReservationsSelectUsageLedger(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ContextBackfillRecoverOutstandingReservationsSelectUsageLedgerRow,
  string
> {
  return database.prepare<
    [number | null],
    ContextBackfillRecoverOutstandingReservationsSelectUsageLedgerRow
  >(
    'select id from usage_ledger\n         where backfill_run_id = ? and actual_usd is null order by occurred_at',
  ) as unknown as PreparedStatement<
    [number | null],
    ContextBackfillRecoverOutstandingReservationsSelectUsageLedgerRow,
    string
  >;
}

export interface ChannelContextRecordDeliveredReplySelectConversationEventsRow {
  min: unknown;
}

export function channelContextRecordDeliveredReplySelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string | null],
  ChannelContextRecordDeliveredReplySelectConversationEventsRow,
  unknown
> {
  return database.prepare<
    [string, string, string | null],
    ChannelContextRecordDeliveredReplySelectConversationEventsRow
  >(
    'select min(occurred_at) from conversation_events\n           where guild_id = ? and channel_id = ?\n             and logical_response_id = ?',
  );
}

export function channelContextRecordDeliveredReplyUpdateConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string | null, string | null, string | null, number | null, string, number],
  unknown,
  unknown
> {
  return database.prepare<
    [string | null, string | null, string | null, number | null, string, number]
  >(
    "update conversation_events set\n                 request_id = case when logical_response_id is null\n                                   then ? else request_id end,\n                 reply_to_message_id = case when logical_response_id is null\n                                            then ? else reply_to_message_id end,\n                 logical_response_id = coalesce(logical_response_id, ?),\n                 response_chunk_index = ?,\n                 platform_event_id = ?\n               where id = ? and role = 'chief'",
  );
}

export interface ChannelContextMaintainSelectConversationEventsRow {
  id: number;
}

export function channelContextMaintainSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [number],
  ChannelContextMaintainSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [number],
    ChannelContextMaintainSelectConversationEventsRow
  >(
    "select id from conversation_events\n           where medium = 'text' and content_state = 'available'\n             and retention_deadline <= ?",
  ) as unknown as PreparedStatement<
    [number],
    ChannelContextMaintainSelectConversationEventsRow,
    number
  >;
}

export interface ChannelContextMaintainSelectContextDocumentsRow {
  id: number;
}

export function channelContextMaintainSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  ChannelContextMaintainSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [number | null],
    ChannelContextMaintainSelectContextDocumentsRow
  >(
    "select id from context_documents\n           where content_state = 'available' and retention_deadline <= ?",
  ) as unknown as PreparedStatement<
    [number | null],
    ChannelContextMaintainSelectContextDocumentsRow,
    number
  >;
}

export function channelContextMaintainDeleteContextDeletionRequests(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "delete from context_deletion_requests\n           where status = 'pending' and expires_at <= ?",
  );
}

export interface ChannelContextNextDeadlineSelectContextJobsRow {
  min: unknown;
}

export function channelContextNextDeadlineSelectContextJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null],
  ChannelContextNextDeadlineSelectContextJobsRow,
  unknown
> {
  return database.prepare<
    [number, number | null],
    ChannelContextNextDeadlineSelectContextJobsRow
  >(
    "select min(freshness_deadline) from context_jobs\n           where not_before <= ?\n             and (status = 'pending'\n               or (status = 'leased' and lease_expires_at <= ?)\n               or (status = 'failed' and last_error_category = 'provider'))\n             and not exists(\n               select 1 from context_accounting_holds h\n               where h.job_id = context_jobs.id\n             )\n             and (backfill_run_id is null or exists(\n               select 1 from context_backfills b\n               where b.id = context_jobs.backfill_run_id\n                 and b.status = 'active'\n             ))",
  );
}

export interface ChannelContextStatusSelectContextBackfillsRow {
  status: string;
  count: number;
}

export function channelContextStatusSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [],
  ChannelContextStatusSelectContextBackfillsRow,
  string
> {
  return database.prepare<[], ChannelContextStatusSelectContextBackfillsRow>(
    "select status, count(*) as count from context_backfills\n         where status in ('active', 'failed', 'paused') group by status",
  ) as unknown as PreparedStatement<
    [],
    ChannelContextStatusSelectContextBackfillsRow,
    string
  >;
}

export interface ChannelContextStatusSelectContextJobsRow {
  count: number;
}

export function channelContextStatusSelectContextJobs(
  database: Database.Database,
): PreparedStatement<[], ChannelContextStatusSelectContextJobsRow, number> {
  return database.prepare<[], ChannelContextStatusSelectContextJobsRow>(
    "select count(*) from context_jobs\n           where status in ('pending', 'leased')",
  ) as unknown as PreparedStatement<
    [],
    ChannelContextStatusSelectContextJobsRow,
    number
  >;
}

export interface ChannelContextStatusSelectContextJobs2Row {
  count: number;
}

export function channelContextStatusSelectContextJobs2(
  database: Database.Database,
): PreparedStatement<[], ChannelContextStatusSelectContextJobs2Row, number> {
  return database.prepare<[], ChannelContextStatusSelectContextJobs2Row>(
    "select count(*) from context_jobs where status = 'failed'",
  ) as unknown as PreparedStatement<
    [],
    ChannelContextStatusSelectContextJobs2Row,
    number
  >;
}

export interface ChannelContextStatusSelectContextAccountingHoldsRow {
  exists: number;
}

export function channelContextStatusSelectContextAccountingHolds(
  database: Database.Database,
): PreparedStatement<
  [],
  ChannelContextStatusSelectContextAccountingHoldsRow,
  number
> {
  return database.prepare<
    [],
    ChannelContextStatusSelectContextAccountingHoldsRow
  >(
    'select exists(select 1 from context_accounting_holds)',
  ) as unknown as PreparedStatement<
    [],
    ChannelContextStatusSelectContextAccountingHoldsRow,
    number
  >;
}

export interface ChannelContextStatusSelectContextJobs3Row {
  min: unknown;
}

export function channelContextStatusSelectContextJobs3(
  database: Database.Database,
): PreparedStatement<
  [string, number],
  ChannelContextStatusSelectContextJobs3Row,
  unknown
> {
  return database.prepare<
    [string, number],
    ChannelContextStatusSelectContextJobs3Row
  >(
    "select min(freshness_deadline) from context_jobs\n             where tier = ? and status != 'completed'\n               and freshness_deadline <= ?",
  );
}

export interface ChannelContextStatusSelectContextJobs4Row {
  error: string | null;
}

export function channelContextStatusSelectContextJobs4(
  database: Database.Database,
): PreparedStatement<
  [number],
  ChannelContextStatusSelectContextJobs4Row,
  string | null
> {
  return database.prepare<[number], ChannelContextStatusSelectContextJobs4Row>(
    "select last_error_category as error\n         from context_jobs\n         where status != 'completed' and freshness_deadline <= ?\n         order by freshness_deadline, id limit 1",
  ) as unknown as PreparedStatement<
    [number],
    ChannelContextStatusSelectContextJobs4Row,
    string | null
  >;
}

export interface ChannelContextStatusSelectContextForgetJournalRow {
  exists: number;
}

export function channelContextStatusSelectContextForgetJournal(
  database: Database.Database,
): PreparedStatement<
  [],
  ChannelContextStatusSelectContextForgetJournalRow,
  number
> {
  return database.prepare<
    [],
    ChannelContextStatusSelectContextForgetJournalRow
  >(
    "select exists(\n             select 1 from context_forget_journal\n             where upload_status in ('pending', 'failed')\n           )",
  ) as unknown as PreparedStatement<
    [],
    ChannelContextStatusSelectContextForgetJournalRow,
    number
  >;
}

export function channelContextRunNextUpdateContextJobs(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    'update context_jobs set usage_reservation_id = null where id = ?',
  );
}

export function channelContextRunNextUpdateContextJobs2(
  database: Database.Database,
): PreparedStatement<[string | null, number], unknown, unknown> {
  return database.prepare<[string | null, number]>(
    'update context_jobs set usage_reservation_id = ? where id = ?',
  );
}

export function channelContextRunNextUpdateContextJobs3(
  database: Database.Database,
): PreparedStatement<[number, string | null], unknown, unknown> {
  return database.prepare<[number, string | null]>(
    'update context_jobs set usage_reservation_id = null\n             where id = ? and usage_reservation_id = ?',
  );
}

export interface ChannelContextRunNextSelectContextDocumentsRow {
  max: unknown;
}

export function channelContextRunNextSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string],
  ChannelContextRunNextSelectContextDocumentsRow,
  unknown
> {
  return database.prepare<
    [string],
    ChannelContextRunNextSelectContextDocumentsRow
  >(
    'select max(revision) from context_documents\n               where document_key = ?',
  );
}

export interface ChannelContextRunNextSelectContextDocuments2Row {
  id: number;
}

export function channelContextRunNextSelectContextDocuments2(
  database: Database.Database,
): PreparedStatement<
  [string],
  ChannelContextRunNextSelectContextDocuments2Row,
  number
> {
  return database.prepare<
    [string],
    ChannelContextRunNextSelectContextDocuments2Row
  >(
    "select id from context_documents\n             where document_key = ? and state = 'active'",
  ) as unknown as PreparedStatement<
    [string],
    ChannelContextRunNextSelectContextDocuments2Row,
    number
  >;
}

export interface ChannelContextRunNextSelectContextDocuments3Row {
  max: unknown;
}

export function channelContextRunNextSelectContextDocuments3(
  database: Database.Database,
): PreparedStatement<
  [string],
  ChannelContextRunNextSelectContextDocuments3Row,
  unknown
> {
  return database.prepare<
    [string],
    ChannelContextRunNextSelectContextDocuments3Row
  >(
    'select max(revision) from context_documents\n                 where document_key = ?',
  );
}

export function channelContextRunNextUpdateContextJobs4(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update context_jobs\n             set status = 'completed', lease_expires_at = null,\n                 usage_reservation_id = null, last_error_category = null\n             where id = ?",
  );
}

export function channelContextRunNextUpdateContextJobs5(
  database: Database.Database,
): PreparedStatement<[number, string | null], unknown, unknown> {
  return database.prepare<[number, string | null]>(
    'update context_jobs set usage_reservation_id = null\n           where id = ? and usage_reservation_id = ?',
  );
}

export interface ChannelContextLeaseNextJobSelectContextJobsRow {
  id: number;
  jobKey: string;
  tier: string;
  periodStart: number;
  periodEnd: number | null;
  timeZone: string;
  topicKey: string | null;
  topicLabel: string | null;
  sourceDocumentIdsJson: string;
  usageReservationId: string | null;
  completeness: string;
  sourceRevisionChecksum: string;
  attemptCount: number;
  backfillRunId: number | null;
}

export function channelContextLeaseNextJobSelectContextJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null],
  ChannelContextLeaseNextJobSelectContextJobsRow,
  number
> {
  return database.prepare<
    [number, number | null],
    ChannelContextLeaseNextJobSelectContextJobsRow
  >(
    "select id, job_key as jobKey, tier, period_start as periodStart,\n                  period_end as periodEnd, timezone as timeZone,\n                  topic_key as topicKey, topic_label as topicLabel,\n                  source_document_ids_json as sourceDocumentIdsJson,\n                  usage_reservation_id as usageReservationId,\n                  completeness,\n                  source_revision_checksum as sourceRevisionChecksum,\n                  attempt_count as attemptCount,\n                  backfill_run_id as backfillRunId\n           from context_jobs\n           where not_before <= ?\n             and (status = 'pending'\n               or (status = 'leased' and lease_expires_at <= ?)\n               or (status = 'failed' and last_error_category = 'provider'))\n             and not exists(\n               select 1 from context_accounting_holds h\n               where h.job_id = context_jobs.id\n             )\n             and (backfill_run_id is null or exists(\n               select 1 from context_backfills b\n               where b.id = context_jobs.backfill_run_id\n                 and b.status = 'active'\n             ))\n           order by freshness_deadline, id limit 1",
  ) as unknown as PreparedStatement<
    [number, number | null],
    ChannelContextLeaseNextJobSelectContextJobsRow,
    number
  >;
}

export function channelContextLeaseNextJobUpdateContextJobs(
  database: Database.Database,
): PreparedStatement<[number | null, number], unknown, unknown> {
  return database.prepare<[number | null, number]>(
    "update context_jobs\n           set status = 'leased', lease_expires_at = ?,\n               attempt_count = attempt_count + 1\n           where id = ?",
  );
}

export interface ChannelContextJobSourcesSelectConversationEventsRow {
  id: unknown;
  text: string;
}

export function channelContextJobSourcesSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, number, number | null],
  ChannelContextJobSourcesSelectConversationEventsRow,
  unknown
> {
  return database.prepare<
    [string, string, number, number | null],
    ChannelContextJobSourcesSelectConversationEventsRow
  >(
    "select 'event:' || id as id, content as text\n           from conversation_events\n           where guild_id = ? and channel_id = ? and medium = 'text'\n             and content_state = 'available'\n             and occurred_at >= ? and occurred_at < ?\n           order by occurred_at, id",
  );
}

export interface ChannelContextJobSourcesSelectContextDocumentsRow {
  id: unknown;
  text: string;
}

export function channelContextJobSourcesSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string, number, number | null],
  ChannelContextJobSourcesSelectContextDocumentsRow,
  unknown
> {
  return database.prepare<
    [string, number, number | null],
    ChannelContextJobSourcesSelectContextDocumentsRow
  >(
    "select 'document:' || id as id, summary as text\n           from context_documents\n           where tier = ? and completeness = 'final' and state = 'active'\n             and content_state = 'available' and is_internal = 0\n             and period_start >= ? and period_end <= ?\n           order by period_start, id",
  );
}

export interface ChannelContextJobSourcesSelectContextDocuments2Row {
  id: number;
}

export function channelContextJobSourcesSelectContextDocuments2(
  database: Database.Database,
): PreparedStatement<
  [string | null],
  ChannelContextJobSourcesSelectContextDocuments2Row,
  number
> {
  return database.prepare<
    [string | null],
    ChannelContextJobSourcesSelectContextDocuments2Row
  >(
    "select id from context_documents\n         where tier = 'long-term' and topic_key = ? and state = 'active'\n           and content_state = 'available' and is_internal = 0",
  ) as unknown as PreparedStatement<
    [string | null],
    ChannelContextJobSourcesSelectContextDocuments2Row,
    number
  >;
}

export function channelContextCompleteEmptyJobUpdateContextJobs(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update context_jobs\n         set status = 'completed', lease_expires_at = null,\n             usage_reservation_id = null, last_error_category = null\n         where id = ?",
  );
}

export interface ChannelContextProvisionalObsoleteSelectContextDocumentsRow {
  exists: number;
}

export function channelContextProvisionalObsoleteSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string],
  ChannelContextProvisionalObsoleteSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [string],
    ChannelContextProvisionalObsoleteSelectContextDocumentsRow
  >(
    "select exists(\n             select 1 from context_documents\n             where document_key = ? and completeness = 'final'\n               and state = 'active' and is_internal = 0\n           )",
  ) as unknown as PreparedStatement<
    [string],
    ChannelContextProvisionalObsoleteSelectContextDocumentsRow,
    number
  >;
}

export function channelContextDeferJobUpdateContextJobs(
  database: Database.Database,
): PreparedStatement<[number, string | null, number], unknown, unknown> {
  return database.prepare<[number, string | null, number]>(
    "update context_jobs\n         set status = 'pending', not_before = ?, lease_expires_at = null,\n             usage_reservation_id = null,\n             attempt_count = max(0, attempt_count - 1),\n             last_error_category = ?\n         where id = ?",
  );
}

export function channelContextRetryJobUpdateContextJobs(
  database: Database.Database,
): PreparedStatement<
  [string, number, string | null, number, string, number],
  unknown,
  unknown
> {
  return database.prepare<
    [string, number, string | null, number, string, number]
  >(
    "update context_jobs\n         set status = ?, not_before = ?, lease_expires_at = null,\n             usage_reservation_id = null, last_error_category = ?\n         where id = ? and status = 'leased'\n           and source_revision_checksum = ? and attempt_count = ?",
  );
}

export interface ChannelContextAssertCurrentLeaseSelectContextJobsRow {
  exists: number;
}

export function channelContextAssertCurrentLeaseSelectContextJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null, number, string, string | null],
  ChannelContextAssertCurrentLeaseSelectContextJobsRow,
  number
> {
  return database.prepare<
    [number, number | null, number, string, string | null],
    ChannelContextAssertCurrentLeaseSelectContextJobsRow
  >(
    "select exists(\n           select 1 from context_jobs\n           where id = ? and status = 'leased' and lease_expires_at > ?\n             and attempt_count = ? and source_revision_checksum = ?\n             and usage_reservation_id = ?\n         )",
  ) as unknown as PreparedStatement<
    [number, number | null, number, string, string | null],
    ChannelContextAssertCurrentLeaseSelectContextJobsRow,
    number
  >;
}

export interface ChannelContextScheduleDownstreamSelectContextDocumentsRow {
  topicKey: string | null;
  topicLabel: string | null;
}

export function channelContextScheduleDownstreamSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [],
  ChannelContextScheduleDownstreamSelectContextDocumentsRow,
  string | null
> {
  return database.prepare<
    [],
    ChannelContextScheduleDownstreamSelectContextDocumentsRow
  >(
    "select distinct topic_key as topicKey, topic_label as topicLabel\n           from context_documents\n           where tier = 'long-term' and state = 'active'\n             and content_state = 'available' and topic_key is not null\n             and topic_label is not null",
  ) as unknown as PreparedStatement<
    [],
    ChannelContextScheduleDownstreamSelectContextDocumentsRow,
    string | null
  >;
}

export interface ChannelContextDocumentRevisionChecksumSelectContextDocumentsRow {
  id: number;
  revision: number;
}

export function channelContextDocumentRevisionChecksumSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string, number, number | null],
  ChannelContextDocumentRevisionChecksumSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [string, number, number | null],
    ChannelContextDocumentRevisionChecksumSelectContextDocumentsRow
  >(
    "select id, revision from context_documents\n         where tier = ? and completeness = 'final' and state = 'active'\n           and content_state = 'available' and is_internal = 0\n           and period_start >= ? and period_end <= ?\n         order by period_start, id",
  ) as unknown as PreparedStatement<
    [string, number, number | null],
    ChannelContextDocumentRevisionChecksumSelectContextDocumentsRow,
    number
  >;
}

export function channelContextUpsertDerivedJobInsertContextJobs(
  database: Database.Database,
): PreparedStatement<
  [
    string,
    string,
    number,
    number | null,
    string,
    string,
    number,
    number,
    number | null,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string,
      string,
      number,
      number | null,
      string,
      string,
      number,
      number,
      number | null,
    ]
  >(
    "insert into context_jobs\n           (job_key, tier, period_start, period_end, timezone, topic_key,\n            completeness, source_revision_checksum, not_before,\n            freshness_deadline, backfill_run_id)\n         values (?, ?, ?, ?, ?, null, 'final', ?, ?, ?, ?)\n         on conflict(job_key) do update set\n           source_revision_checksum = excluded.source_revision_checksum,\n           not_before = excluded.not_before,\n           freshness_deadline = excluded.freshness_deadline,\n           status = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then 'pending' else context_jobs.status end,\n           lease_expires_at = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then null else context_jobs.lease_expires_at end,\n           last_error_category = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then null else context_jobs.last_error_category end,\n           backfill_run_id = case\n             when excluded.backfill_run_id is not null\n             then excluded.backfill_run_id\n             when context_jobs.backfill_run_id is not null\n               and not exists(\n                 select 1 from context_backfills b\n                 where b.id = context_jobs.backfill_run_id\n                   and b.status = 'active'\n               )\n             then null\n             when context_jobs.status = 'completed' then null\n             else context_jobs.backfill_run_id end",
  );
}

export interface ChannelContextUpsertTopicJobSelectContextDocumentsRow {
  id: number;
}

export function channelContextUpsertTopicJobSelectContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [string | null],
  ChannelContextUpsertTopicJobSelectContextDocumentsRow,
  number
> {
  return database.prepare<
    [string | null],
    ChannelContextUpsertTopicJobSelectContextDocumentsRow
  >(
    "select id from context_documents\n         where tier = 'long-term' and topic_key = ? and state = 'active'\n           and content_state = 'available'",
  ) as unknown as PreparedStatement<
    [string | null],
    ChannelContextUpsertTopicJobSelectContextDocumentsRow,
    number
  >;
}

export function channelContextUpsertTopicJobInsertContextJobs(
  database: Database.Database,
): PreparedStatement<
  [
    string,
    number,
    string,
    string | null,
    string | null,
    string,
    string,
    number,
    number,
    number | null,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string,
      number,
      string,
      string | null,
      string | null,
      string,
      string,
      number,
      number,
      number | null,
    ]
  >(
    "insert into context_jobs\n           (job_key, tier, period_start, period_end, timezone, topic_key,\n            topic_label, completeness, source_revision_checksum,\n            source_document_ids_json, not_before, freshness_deadline,\n            backfill_run_id)\n         values (?, 'long-term', ?, null, ?, ?, ?, 'final', ?, ?, ?, ?, ?)\n         on conflict(job_key) do update set\n           topic_label = excluded.topic_label,\n           source_revision_checksum = excluded.source_revision_checksum,\n           source_document_ids_json = excluded.source_document_ids_json,\n           not_before = excluded.not_before,\n           freshness_deadline = excluded.freshness_deadline,\n           status = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then 'pending' else context_jobs.status end,\n           lease_expires_at = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then null else context_jobs.lease_expires_at end,\n           last_error_category = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then null else context_jobs.last_error_category end,\n           backfill_run_id = case\n             when excluded.backfill_run_id is not null\n             then excluded.backfill_run_id\n             when context_jobs.backfill_run_id is not null\n               and not exists(\n                 select 1 from context_backfills b\n                 where b.id = context_jobs.backfill_run_id\n                   and b.status = 'active'\n               )\n             then null\n             when context_jobs.status = 'completed' then null\n             else context_jobs.backfill_run_id end",
  );
}

export interface ChannelContextApplyUpsertSelectConversationEventsRow {
  content: string;
  contentState: string;
  occurredAt: number;
}

export function channelContextApplyUpsertSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [number],
  ChannelContextApplyUpsertSelectConversationEventsRow,
  string
> {
  return database.prepare<
    [number],
    ChannelContextApplyUpsertSelectConversationEventsRow
  >(
    'select content, content_state as contentState,\n                occurred_at as occurredAt\n         from conversation_events where id = ?',
  ) as unknown as PreparedStatement<
    [number],
    ChannelContextApplyUpsertSelectConversationEventsRow,
    string
  >;
}

export function channelContextUpsertJobInsertContextJobs(
  database: Database.Database,
): PreparedStatement<
  [
    string,
    number,
    number | null,
    string,
    string,
    string,
    number,
    number,
    number | null,
  ],
  unknown,
  unknown
> {
  return database.prepare<
    [
      string,
      number,
      number | null,
      string,
      string,
      string,
      number,
      number,
      number | null,
    ]
  >(
    "insert into context_jobs\n           (job_key, tier, period_start, period_end, timezone, topic_key,\n            completeness, source_revision_checksum, not_before,\n            freshness_deadline, backfill_run_id)\n         values (?, 'hourly', ?, ?, ?, null, ?, ?, ?, ?, ?)\n         on conflict(job_key) do update set\n           source_revision_checksum = excluded.source_revision_checksum,\n           not_before = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n               and context_jobs.completeness = 'provisional'\n               and context_jobs.status = 'pending'\n             then min(context_jobs.not_before, excluded.not_before)\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then excluded.not_before else context_jobs.not_before end,\n           freshness_deadline = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n               and context_jobs.completeness = 'provisional'\n               and context_jobs.status = 'pending'\n             then min(context_jobs.freshness_deadline,\n                      excluded.freshness_deadline)\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then excluded.freshness_deadline\n             else context_jobs.freshness_deadline end,\n           status = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then 'pending' else context_jobs.status end,\n           lease_expires_at = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then null else context_jobs.lease_expires_at end,\n           last_error_category = case\n             when context_jobs.source_revision_checksum\n                    != excluded.source_revision_checksum\n             then null else context_jobs.last_error_category end,\n           backfill_run_id = case\n             when excluded.backfill_run_id is not null\n             then excluded.backfill_run_id\n             when context_jobs.backfill_run_id is not null\n               and not exists(\n                 select 1 from context_backfills b\n                 where b.id = context_jobs.backfill_run_id\n                   and b.status = 'active'\n               )\n             then null\n             when context_jobs.status = 'completed' then null\n             else context_jobs.backfill_run_id end",
  );
}

export function channelContextPauseBackfillRunUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<[string | null, number, number], unknown, unknown> {
  return database.prepare<[string | null, number, number]>(
    "update context_backfills\n         set status = 'paused', pause_reason = ?, updated_at = ?\n         where id = ? and status = 'active'",
  );
}

export interface ChannelContextSourceRevisionChecksumSelectConversationEventsRow {
  id: number;
  discordMessageId: string;
  content: string;
  editedAt: number | null;
}

export function channelContextSourceRevisionChecksumSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, number, number],
  ChannelContextSourceRevisionChecksumSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, number, number],
    ChannelContextSourceRevisionChecksumSelectConversationEventsRow
  >(
    "select id, discord_message_id as discordMessageId, content,\n                edited_at as editedAt\n         from conversation_events\n         where guild_id = ? and channel_id = ? and medium = 'text'\n           and content_state = 'available'\n           and occurred_at >= ? and occurred_at < ?\n         order by id",
  ) as unknown as PreparedStatement<
    [string, string, number, number],
    ChannelContextSourceRevisionChecksumSelectConversationEventsRow,
    number
  >;
}

export interface ChannelContextInvalidateEventJobsSelectConversationEventsRow {
  occurred_at: number;
}

export function channelContextInvalidateEventJobsSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [number],
  ChannelContextInvalidateEventJobsSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [number],
    ChannelContextInvalidateEventJobsSelectConversationEventsRow
  >(
    'select occurred_at from conversation_events where id = ?',
  ) as unknown as PreparedStatement<
    [number],
    ChannelContextInvalidateEventJobsSelectConversationEventsRow,
    number
  >;
}

export interface ChannelContextEventIdSelectConversationEventsRow {
  id: number;
}

export function channelContextEventIdSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ChannelContextEventIdSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ChannelContextEventIdSelectConversationEventsRow
  >(
    'select id from conversation_events\n           where guild_id = ? and channel_id = ? and discord_message_id = ?',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ChannelContextEventIdSelectConversationEventsRow,
    number
  >;
}

export interface ChannelContextExistingRevisionSelectConversationEventsRow {
  id: number;
  occurredAt: number;
  editedAt: number | null;
  revisionChecksum: string;
}

export function channelContextExistingRevisionSelectConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [string, string, string],
  ChannelContextExistingRevisionSelectConversationEventsRow,
  number
> {
  return database.prepare<
    [string, string, string],
    ChannelContextExistingRevisionSelectConversationEventsRow
  >(
    'select id, occurred_at as occurredAt, edited_at as editedAt,\n                  revision_checksum as revisionChecksum\n           from conversation_events\n           where guild_id = ? and channel_id = ? and discord_message_id = ?',
  ) as unknown as PreparedStatement<
    [string, string, string],
    ChannelContextExistingRevisionSelectConversationEventsRow,
    number
  >;
}

export interface MemoryObserveSelectSourceEventsRow {
  id: number;
  revisionChecksum: string;
}

export function memoryObserveSelectSourceEvents(
  database: Database.Database,
): PreparedStatement<[string], MemoryObserveSelectSourceEventsRow, number> {
  return database.prepare<[string], MemoryObserveSelectSourceEventsRow>(
    'select id, revision_checksum as revisionChecksum\n           from source_events where platform_source_id = ?',
  ) as unknown as PreparedStatement<
    [string],
    MemoryObserveSelectSourceEventsRow,
    number
  >;
}

export function memoryObserveDeleteMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number | null], unknown, unknown> {
  return database.prepare<[number | null]>(
    'delete from memory_jobs where source_event_id = ?',
  );
}

export interface MemoryObserveSelectSourceEvents2Row {
  id: number;
}

export function memoryObserveSelectSourceEvents2(
  database: Database.Database,
): PreparedStatement<[string], MemoryObserveSelectSourceEvents2Row, number> {
  return database.prepare<[string], MemoryObserveSelectSourceEvents2Row>(
    'select id from source_events where platform_source_id = ?',
  ) as unknown as PreparedStatement<
    [string],
    MemoryObserveSelectSourceEvents2Row,
    number
  >;
}

export function memoryObserveInsertMemoryJobs(
  database: Database.Database,
): PreparedStatement<
  [number | null, string, number, number | null],
  unknown,
  unknown
> {
  return database.prepare<[number | null, string, number, number | null]>(
    "insert into memory_jobs\n               (source_event_id, revision_checksum, not_before)\n             select ?, ?, ? where not exists (\n               select 1 from memory_jobs\n               where memory_jobs.source_event_id = ? and status in ('pending', 'leased')\n             )",
  );
}

export interface MemoryLeaseNextJobSelectMemoryJobsRow {
  id: number;
  sourceEventId: number | null;
  attemptCount: number;
}

export function memoryLeaseNextJobSelectMemoryJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null],
  MemoryLeaseNextJobSelectMemoryJobsRow,
  number
> {
  return database.prepare<
    [number, number | null],
    MemoryLeaseNextJobSelectMemoryJobsRow
  >(
    "select id, source_event_id as sourceEventId, attempt_count as attemptCount\n           from memory_jobs\n           where not_before <= ?\n             and (status = 'pending' or (status = 'leased' and lease_expires_at <= ?))\n           order by id limit 1",
  ) as unknown as PreparedStatement<
    [number, number | null],
    MemoryLeaseNextJobSelectMemoryJobsRow,
    number
  >;
}

export function memoryLeaseNextJobUpdateMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number | null, number], unknown, unknown> {
  return database.prepare<[number | null, number]>(
    "update memory_jobs set status = 'leased', lease_expires_at = ?,\n             attempt_count = attempt_count + 1 where id = ?",
  );
}

export interface MemoryNextJobDeadlineSelectMemoryJobsRow {
  min: unknown;
}

export function memoryNextJobDeadlineSelectMemoryJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null],
  MemoryNextJobDeadlineSelectMemoryJobsRow,
  unknown
> {
  return database.prepare<
    [number, number | null],
    MemoryNextJobDeadlineSelectMemoryJobsRow
  >(
    "select min(not_before) from memory_jobs\n           where not_before <= ?\n             and (status = 'pending'\n               or (status = 'leased' and lease_expires_at <= ?))",
  );
}

export function memoryDeferForBudgetUpdateMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number, number], unknown, unknown> {
  return database.prepare<[number, number]>(
    "update memory_jobs set status = 'pending', not_before = ?, lease_expires_at = null,\n           attempt_count = max(0, attempt_count - 1) where id = ?",
  );
}

export interface MemoryGetJobSourceSelectMemoryJobsRow {
  id: number;
  content: string;
  medium: string;
  occurredAt: number;
  platformSourceId: string;
  revisionChecksum: string;
  canModerateContext: number;
  speakerId: string;
}

export function memoryGetJobSourceSelectMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number], MemoryGetJobSourceSelectMemoryJobsRow, number> {
  return database.prepare<[number], MemoryGetJobSourceSelectMemoryJobsRow>(
    'select s.id, s.content, s.medium, s.occurred_at as occurredAt,\n                s.platform_source_id as platformSourceId,\n                s.revision_checksum as revisionChecksum,\n                s.can_moderate_context as canModerateContext,\n                s.speaker_id as speakerId\n         from memory_jobs j join source_events s on s.id = j.source_event_id\n         where j.id = ?',
  ) as unknown as PreparedStatement<
    [number],
    MemoryGetJobSourceSelectMemoryJobsRow,
    number
  >;
}

export interface MemoryCanRequesterForgetSelectMemoriesRow {
  exists: number;
}

export function memoryCanRequesterForgetSelectMemories(
  database: Database.Database,
): PreparedStatement<
  [number, string],
  MemoryCanRequesterForgetSelectMemoriesRow,
  number
> {
  return database.prepare<
    [number, string],
    MemoryCanRequesterForgetSelectMemoriesRow
  >(
    'select exists(\n             select 1 from memories m join source_events s\n               on s.id = m.source_event_id\n             where m.id = ? and s.speaker_id = ?\n           )',
  ) as unknown as PreparedStatement<
    [number, string],
    MemoryCanRequesterForgetSelectMemoriesRow,
    number
  >;
}

export interface MemoryRetryJobSelectMemoryJobsRow {
  attempt_count: number;
}

export function memoryRetryJobSelectMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number], MemoryRetryJobSelectMemoryJobsRow, number> {
  return database.prepare<[number], MemoryRetryJobSelectMemoryJobsRow>(
    'select attempt_count from memory_jobs where id = ?',
  ) as unknown as PreparedStatement<
    [number],
    MemoryRetryJobSelectMemoryJobsRow,
    number
  >;
}

export function memoryRetryJobUpdateMemoryJobs(
  database: Database.Database,
): PreparedStatement<[string, number, number], unknown, unknown> {
  return database.prepare<[string, number, number]>(
    'update memory_jobs set status = ?, not_before = ?, lease_expires_at = null\n         where id = ?',
  );
}

export function memoryRecordConflictInsertMemoryConflicts(
  database: Database.Database,
): PreparedStatement<[number, number, number], unknown, unknown> {
  return database.prepare<[number, number, number]>(
    'insert into memory_conflicts\n           (left_memory_id, right_memory_id, created_at)\n         values (?, ?, ?) on conflict(left_memory_id, right_memory_id) do nothing',
  );
}

export interface MemoryApplyPreparedMutationBatchSelectSourceEventsRow {
  revisionChecksum: string;
  sourceScopeId: string;
}

export function memoryApplyPreparedMutationBatchSelectSourceEvents(
  database: Database.Database,
): PreparedStatement<
  [number],
  MemoryApplyPreparedMutationBatchSelectSourceEventsRow,
  string
> {
  return database.prepare<
    [number],
    MemoryApplyPreparedMutationBatchSelectSourceEventsRow
  >(
    'select revision_checksum as revisionChecksum,\n                  source_scope_id as sourceScopeId\n           from source_events where id = ?',
  ) as unknown as PreparedStatement<
    [number],
    MemoryApplyPreparedMutationBatchSelectSourceEventsRow,
    string
  >;
}

export interface MemoryApplyPreparedMutationBatchSelectMemoryJobsRow {
  revision_checksum: string;
}

export function memoryApplyPreparedMutationBatchSelectMemoryJobs(
  database: Database.Database,
): PreparedStatement<
  [number, number | null],
  MemoryApplyPreparedMutationBatchSelectMemoryJobsRow,
  string
> {
  return database.prepare<
    [number, number | null],
    MemoryApplyPreparedMutationBatchSelectMemoryJobsRow
  >(
    'select revision_checksum from memory_jobs\n                 where id = ? and source_event_id = ?',
  ) as unknown as PreparedStatement<
    [number, number | null],
    MemoryApplyPreparedMutationBatchSelectMemoryJobsRow,
    string
  >;
}

export function memoryApplyPreparedMutationBatchUpdateSourceEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update source_events set extraction_status = 'completed'\n             where id = ?",
  );
}

export function memoryMaintainDeleteMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "delete from memory_jobs\n           where status = 'completed' and source_event_id in (\n             select id from source_events where retention_deadline <= ?\n           )",
  );
}

export function memoryMaintainUpdateSourceEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update source_events set content = ''\n           where retention_deadline <= ? and content != '' and exists (\n             select 1 from memories m where m.source_event_id = source_events.id\n           )",
  );
}

export function memoryMaintainDeleteSourceEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "delete from source_events\n           where retention_deadline <= ? and not exists (\n             select 1 from memories m where m.source_event_id = source_events.id\n           ) and not exists (\n             select 1 from memory_jobs j where j.source_event_id = source_events.id\n               and j.status != 'completed'\n           )",
  );
}

export interface MemorySuppressSourceSelectSourceEventsRow {
  id: number;
}

export function memorySuppressSourceSelectSourceEvents(
  database: Database.Database,
): PreparedStatement<
  [string],
  MemorySuppressSourceSelectSourceEventsRow,
  number
> {
  return database.prepare<[string], MemorySuppressSourceSelectSourceEventsRow>(
    'select id from source_events where platform_source_id = ?',
  ) as unknown as PreparedStatement<
    [string],
    MemorySuppressSourceSelectSourceEventsRow,
    number
  >;
}

export function memorySuppressSourceDeleteSourceEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>('delete from source_events where id = ?');
}

export interface MemoryDeleteSourceMemoriesSelectMemoriesRow {
  id: number;
  state: string;
}

export function memoryDeleteSourceMemoriesSelectMemories(
  database: Database.Database,
): PreparedStatement<
  [number | null],
  MemoryDeleteSourceMemoriesSelectMemoriesRow,
  number
> {
  return database.prepare<
    [number | null],
    MemoryDeleteSourceMemoriesSelectMemoriesRow
  >(
    'select id, state from memories where source_event_id = ?',
  ) as unknown as PreparedStatement<
    [number | null],
    MemoryDeleteSourceMemoriesSelectMemoriesRow,
    number
  >;
}

export function memoryDeleteSourceMemoriesDeleteMemories(
  database: Database.Database,
): PreparedStatement<[number | null], unknown, unknown> {
  return database.prepare<[number | null]>(
    'delete from memories where source_event_id = ?',
  );
}

export function memoryCompleteJobUpdateMemoryJobs(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update memory_jobs set status = 'completed', lease_expires_at = null\n         where id = ?",
  );
}

export function memoryCompleteJobUpdateSourceEvents(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>(
    "update source_events set extraction_status = 'completed'\n         where source_events.id = (select source_event_id from memory_jobs where memory_jobs.id = ?)",
  );
}

export interface MemoryForgetSelectMemoriesRow {
  sourceEventId: number | null;
  state: string;
}

export function memoryForgetSelectMemories(
  database: Database.Database,
): PreparedStatement<[number], MemoryForgetSelectMemoriesRow, number | null> {
  return database.prepare<[number], MemoryForgetSelectMemoriesRow>(
    'select source_event_id as sourceEventId, state\n         from memories where id = ?',
  ) as unknown as PreparedStatement<
    [number],
    MemoryForgetSelectMemoriesRow,
    number | null
  >;
}

export function memoryForgetDeleteMemories(
  database: Database.Database,
): PreparedStatement<[number], unknown, unknown> {
  return database.prepare<[number]>('delete from memories where id = ?');
}

export function memoryForgetDeleteSourceEvents(
  database: Database.Database,
): PreparedStatement<[number, number | null, number | null], unknown, unknown> {
  return database.prepare<[number, number | null, number | null]>(
    "delete from source_events where source_events.id = ?\n           and not exists (select 1 from memories where memories.source_event_id = ?)\n           and not exists (\n             select 1 from memory_jobs where memory_jobs.source_event_id = ? and status != 'completed'\n           )",
  );
}

export function memoryInsertMemoryInsertMemories(
  database: Database.Database,
): PreparedStatement<
  [number | null, string, string, number, string, number, number],
  unknown,
  unknown
> {
  return database.prepare<
    [number | null, string, string, number, string, number, number]
  >(
    "insert into memories\n           (source_event_id, canonical_text, kind, confidence, provenance_json,\n            state, created_at, updated_at)\n         values (?, ?, ?, ?, ?, 'active', ?, ?)",
  );
}

export function memorySupersedeUpdateMemories(
  database: Database.Database,
): PreparedStatement<[number | null, number, number], unknown, unknown> {
  return database.prepare<[number | null, number, number]>(
    "update memories set state = 'superseded', superseded_by = ?, updated_at = ?\n         where id = ? and state = 'active'",
  );
}

export interface MemoryConsolidateExactDuplicatesSelectMemoriesRow {
  normalized: string;
  ids: string;
}

export function memoryConsolidateExactDuplicatesSelectMemories(
  database: Database.Database,
): PreparedStatement<
  [],
  MemoryConsolidateExactDuplicatesSelectMemoriesRow,
  string
> {
  return database.prepare<
    [],
    MemoryConsolidateExactDuplicatesSelectMemoriesRow
  >(
    "select lower(trim(canonical_text)) as normalized,\n                group_concat(id) as ids\n         from memories where state = 'active'\n         group by normalized having count(*) > 1",
  ) as unknown as PreparedStatement<
    [],
    MemoryConsolidateExactDuplicatesSelectMemoriesRow,
    string
  >;
}

export function memoryConsolidateExactDuplicatesUpdateMemories(
  database: Database.Database,
): PreparedStatement<[number | null, number, number], unknown, unknown> {
  return database.prepare<[number | null, number, number]>(
    "update memories set state = 'superseded', superseded_by = ?,\n                 updated_at = ? where id = ?",
  );
}

export function usageLedgerCancelDeleteUsageLedger(
  database: Database.Database,
): PreparedStatement<[string], unknown, unknown> {
  return database.prepare<[string]>(
    'delete from usage_ledger where id = ? and actual_usd is null',
  );
}

export interface UsageLedgerBackfillRunSelectContextBackfillsRow {
  actualUsd: number;
  maximumUsd: number | null;
}

export function usageLedgerBackfillRunSelectContextBackfills(
  database: Database.Database,
): PreparedStatement<
  [number],
  UsageLedgerBackfillRunSelectContextBackfillsRow,
  number
> {
  return database.prepare<
    [number],
    UsageLedgerBackfillRunSelectContextBackfillsRow
  >(
    'select actual_usage_usd as actualUsd,\n                  maximum_usage_usd as maximumUsd\n           from context_backfills where id = ?\n             and maximum_usage_usd is not null',
  ) as unknown as PreparedStatement<
    [number],
    UsageLedgerBackfillRunSelectContextBackfillsRow,
    number
  >;
}

export interface UsageLedgerListSelectUsageLedgerRow {
  id: string;
  operation: string;
  reservationUsd: number;
  backfillRunId: number | null;
  originBackfillRunId: number | null;
  reservationOrigin: string;
  workCategory: string;
  priority: string;
  actualUsd: number | null;
  occurredAt: number;
}

export function usageLedgerListSelectUsageLedger(
  database: Database.Database,
): PreparedStatement<
  [number, number],
  UsageLedgerListSelectUsageLedgerRow,
  string
> {
  return database.prepare<
    [number, number],
    UsageLedgerListSelectUsageLedgerRow
  >(
    'select id, operation, reservation_usd as reservationUsd,\n                backfill_run_id as backfillRunId,\n                origin_backfill_run_id as originBackfillRunId,\n                reservation_origin as reservationOrigin,\n                work_category as workCategory, priority,\n                actual_usd as actualUsd, occurred_at as occurredAt\n         from usage_ledger where occurred_at >= ? and occurred_at < ?',
  ) as unknown as PreparedStatement<
    [number, number],
    UsageLedgerListSelectUsageLedgerRow,
    string
  >;
}

export interface UsageLedgerListOutstandingSelectUsageLedgerRow {
  id: string;
  operation: string;
  reservationUsd: number;
  backfillRunId: number | null;
  originBackfillRunId: number | null;
  reservationOrigin: string;
  workCategory: string;
  priority: string;
  actualUsd: number | null;
  occurredAt: number;
}

export function usageLedgerListOutstandingSelectUsageLedger(
  database: Database.Database,
): PreparedStatement<
  [],
  UsageLedgerListOutstandingSelectUsageLedgerRow,
  string
> {
  return database.prepare<[], UsageLedgerListOutstandingSelectUsageLedgerRow>(
    'select id, operation, reservation_usd as reservationUsd,\n                backfill_run_id as backfillRunId,\n                origin_backfill_run_id as originBackfillRunId,\n                reservation_origin as reservationOrigin,\n                work_category as workCategory, priority,\n                actual_usd as actualUsd, occurred_at as occurredAt\n         from usage_ledger where actual_usd is null',
  ) as unknown as PreparedStatement<
    [],
    UsageLedgerListOutstandingSelectUsageLedgerRow,
    string
  >;
}

export interface UsageLedgerReconcileWithSelectContextAccountingHoldsRow {
  backfillRunId: number | null;
  held: number;
}

export function usageLedgerReconcileWithSelectContextAccountingHolds(
  database: Database.Database,
): PreparedStatement<
  [string],
  UsageLedgerReconcileWithSelectContextAccountingHoldsRow,
  number | null
> {
  return database.prepare<
    [string],
    UsageLedgerReconcileWithSelectContextAccountingHoldsRow
  >(
    'select l.backfill_run_id as backfillRunId,\n                  exists(\n                    select 1 from context_accounting_holds h\n                    where h.reservation_id = l.id\n                  ) as held\n           from usage_ledger l where l.id = ? and l.actual_usd is null',
  ) as unknown as PreparedStatement<
    [string],
    UsageLedgerReconcileWithSelectContextAccountingHoldsRow,
    number | null
  >;
}

export function usageLedgerReconcileWithUpdateUsageLedger(
  database: Database.Database,
): PreparedStatement<[number | null, number | null, string], unknown, unknown> {
  return database.prepare<[number | null, number | null, string]>(
    'update usage_ledger set actual_usd = ?, reconciled_at = ?\n           where id = ? and actual_usd is null',
  );
}

export function usageLedgerReconcileWithUpdateContextBackfills(
  database: Database.Database,
): PreparedStatement<[number, number, number], unknown, unknown> {
  return database.prepare<[number, number, number]>(
    'update context_backfills\n             set actual_usage_usd = actual_usage_usd + ?, updated_at = ?\n             where id = ?',
  );
}

export interface ConversationRecordInsertConversationEventsArgs {
  platformEventId: string;
  discordMessageId: string;
  guildId: string;
  channelId: string;
  requestId: string | null;
  logicalResponseId: string | null;
  role: string;
  speakerId: string | null;
  speakerName: string | null;
  medium: string;
  replyToMessageId: string | null;
  content: string;
  attachmentMetadataJson: string;
  occurredAt: number;
  editedAt: number | null;
  recentUntil: number;
  retentionDeadline: number;
  revisionChecksum: string;
  responseChunkIndex: number | null;
}

export function conversationRecordInsertConversationEvents(
  database: Database.Database,
): PreparedStatement<
  [ConversationRecordInsertConversationEventsArgs],
  unknown,
  unknown
> {
  return database.prepare<[ConversationRecordInsertConversationEventsArgs]>(
    "insert into conversation_events\n           (platform_event_id, discord_message_id, guild_id, channel_id,\n            request_id, logical_response_id, role, speaker_id, speaker_name,\n            medium, reply_to_message_id, content, attachment_metadata_json,\n            occurred_at, edited_at, recent_until, retention_deadline,\n            content_state, content_state_reason, revision_checksum,\n            response_chunk_index)\n         values (@platformEventId, @discordMessageId, @guildId, @channelId,\n                 @requestId, @logicalResponseId, @role, @speakerId,\n                 @speakerName, @medium, @replyToMessageId, @content,\n                 @attachmentMetadataJson, @occurredAt, @editedAt,\n                 @recentUntil, @retentionDeadline, 'available', 'retained',\n                 @revisionChecksum, @responseChunkIndex)\n         on conflict(guild_id, channel_id, discord_message_id) do update set\n           speaker_name = excluded.speaker_name,\n           speaker_id = excluded.speaker_id,\n           edited_at = excluded.edited_at,\n           reply_to_message_id = excluded.reply_to_message_id,\n           response_chunk_index = coalesce(\n             excluded.response_chunk_index,\n             conversation_events.response_chunk_index\n           ),\n           content = case when conversation_events.content_state = 'available'\n             then excluded.content else conversation_events.content end,\n           attachment_metadata_json = case\n             when conversation_events.content_state = 'available'\n             then excluded.attachment_metadata_json\n             else conversation_events.attachment_metadata_json end,\n           revision_checksum = excluded.revision_checksum",
  );
}

export interface ContextActivateDocumentRevisionInsertContextDocumentsArgs {
  documentKey: string;
  tier: string;
  periodStart: number;
  periodEnd: number | null;
  timeZone: string;
  topicKey: string | null;
  topicLabel: string | null;
  revision: number;
  completeness: string;
  summary: string;
  confidence: number;
  retentionDeadline: number | null;
  createdAt: number;
  generationInputTokens: number;
  generationOutputTokens: number;
  generationUsageUsd: number;
  isInternal: number;
}

export function contextActivateDocumentRevisionInsertContextDocuments(
  database: Database.Database,
): PreparedStatement<
  [ContextActivateDocumentRevisionInsertContextDocumentsArgs],
  unknown,
  unknown
> {
  return database.prepare<
    [ContextActivateDocumentRevisionInsertContextDocumentsArgs]
  >(
    "insert into context_documents\n              (document_key, tier, period_start, period_end, timezone,\n              topic_key, topic_label, revision, completeness, state, content_state,\n              content_state_reason, summary, confidence, retention_deadline,\n              created_at, updated_at, generation_input_tokens,\n              generation_output_tokens, generation_usage_usd, is_internal)\n           values\n             (@documentKey, @tier, @periodStart, @periodEnd, @timeZone,\n              @topicKey, @topicLabel, @revision, @completeness, 'active', 'available',\n              'retained', @summary, @confidence, @retentionDeadline,\n              @createdAt, @createdAt, @generationInputTokens,\n              @generationOutputTokens, @generationUsageUsd, @isInternal)",
  );
}

export interface MemoryObserveInsertSourceEventsArgs {
  platformSourceId: string;
  sourceScopeId: string;
  revisionChecksum: string;
  canModerateContext: number;
  speakerId: string;
  medium: string;
  content: string;
  occurredAt: number;
  retentionDeadline: number;
}

export function memoryObserveInsertSourceEvents(
  database: Database.Database,
): PreparedStatement<[MemoryObserveInsertSourceEventsArgs], unknown, unknown> {
  return database.prepare<[MemoryObserveInsertSourceEventsArgs]>(
    'insert into source_events\n             (platform_source_id, source_scope_id, revision_checksum,\n              can_moderate_context, speaker_id, medium, content, occurred_at,\n              retention_deadline)\n           values (@platformSourceId, @sourceScopeId, @revisionChecksum,\n                   @canModerateContext, @speakerId, @medium, @content,\n                   @occurredAt, @retentionDeadline)\n           on conflict(platform_source_id) do update set\n             content = excluded.content,\n             source_scope_id = excluded.source_scope_id,\n             revision_checksum = excluded.revision_checksum,\n             can_moderate_context = excluded.can_moderate_context,\n             retention_deadline = excluded.retention_deadline',
  );
}

export interface UsageLedgerRecordInsertUsageLedgerArgs {
  id: string;
  operation: string;
  workCategory: string;
  priority: string;
  reservationUsd: number;
  actualUsd: number | null;
  occurredAt: number;
  occurrenceMonth: number;
  backfillRunId: number | null;
  reservationOrigin: string;
  originBackfillRunId: number | null;
}

export function usageLedgerRecordInsertUsageLedger(
  database: Database.Database,
): PreparedStatement<
  [UsageLedgerRecordInsertUsageLedgerArgs],
  unknown,
  unknown
> {
  return database.prepare<[UsageLedgerRecordInsertUsageLedgerArgs]>(
    'insert into usage_ledger\n           (id, operation, work_category, priority, reservation_usd,\n            actual_usd, occurred_at, occurrence_month, backfill_run_id,\n            reconciled_at, reservation_origin, origin_backfill_run_id)\n         values (@id, @operation, @workCategory, @priority, @reservationUsd,\n                 @actualUsd, @occurredAt, @occurrenceMonth, @backfillRunId,\n                 case when @actualUsd is null then null else @occurredAt end,\n                 @reservationOrigin, @originBackfillRunId)',
  );
}
