import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  ConversationStore,
  type ConversationRole,
} from '../conversation/conversation-store.js';
import type { SqliteMemoryStore } from '../memory/memory-store.js';
import { contextPeriod, type ContextPeriod } from './context-period.js';
import type { ContextContentStateReason } from './context-types.js';

const RECENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PROVISIONAL_DELAY_MS = 5 * 60 * 1_000;

export interface ContextSourceUpsert {
  readonly attachmentMetadataJson?: string;
  readonly canModerateContext?: boolean;
  readonly content: string;
  readonly editedAt?: number | null;
  readonly messageId: string;
  readonly memoryExtraction?: 'automatic' | 'explicit' | 'none';
  readonly occurredAt: number;
  readonly platformEventId?: string;
  readonly replyToMessageId?: string | null;
  readonly requestId: string | null;
  readonly responseChunkIndex?: number | null;
  readonly revisionChecksum?: string;
  readonly role: ConversationRole;
  readonly speakerId: string | null;
  readonly speakerName: string | null;
  readonly type: 'upsert';
}

export interface ContextSourceSuppression {
  readonly deletedAt: number;
  readonly messageId: string;
  readonly reason: 'discord-deleted' | 'locally-forgotten';
  readonly type: 'delete' | 'forget';
}

export type ContextSourceChange =
  ContextSourceSuppression | ContextSourceUpsert;

export interface DeliveredReplyInput {
  readonly chunks: readonly {
    readonly content: string;
    readonly messageId: string;
    readonly occurredAt?: number;
  }[];
  readonly logicalResponseId: string;
  readonly replyToMessageId: string;
  readonly requestId: string;
  readonly speakerId?: string;
}

export interface ChannelContextServiceOptions {
  readonly channelId: string;
  readonly conversation: ConversationStore;
  readonly database: Database.Database;
  readonly guildId: string;
  readonly memory?: SqliteMemoryStore;
  readonly now?: () => number;
  readonly timeZone: string;
}

export type ContextApplyResult =
  | {
      readonly eventId: number;
      readonly memorySourceEventId: number | null;
      readonly status: 'applied';
    }
  | { readonly eventId: number; readonly status: 'unchanged' }
  | { readonly eventId: number | null; readonly status: 'suppressed' };

interface SourceRevisionRow {
  readonly content: string;
  readonly discordMessageId: string;
  readonly editedAt: number | null;
  readonly id: number;
}

interface ExistingSourceRevision {
  readonly editedAt: number | null;
  readonly id: number;
  readonly occurredAt: number;
  readonly revisionChecksum: string;
}

export class ChannelContextService {
  readonly #channelId: string;
  readonly #conversation: ConversationStore;
  readonly #database: Database.Database;
  readonly #guildId: string;
  readonly #memory: SqliteMemoryStore | undefined;
  readonly #now: () => number;
  readonly #timeZone: string;

  public constructor(options: ChannelContextServiceOptions) {
    this.#channelId = options.channelId;
    this.#conversation = options.conversation;
    this.#database = options.database;
    this.#guildId = options.guildId;
    this.#memory = options.memory;
    this.#now = options.now ?? Date.now;
    this.#timeZone = options.timeZone;
  }

  public apply(change: ContextSourceChange): ContextApplyResult {
    return this.#database.transaction(() =>
      change.type === 'upsert'
        ? this.#applyUpsert(change)
        : this.#applySuppression(change),
    )();
  }

  public hasSource(messageId: string): boolean {
    return this.#eventId(messageId) !== null;
  }

  public recordDeliveredReply(input: DeliveredReplyInput): void {
    if (
      input.chunks.length === 0 ||
      input.chunks.some(({ messageId }) => !/^\d{17,20}$/u.test(messageId))
    ) {
      throw new Error('delivered replies require Discord message snowflakes');
    }
    this.#database.transaction(() => {
      const existingOccurredAt = this.#database
        .prepare(
          `select min(occurred_at) from conversation_events
           where guild_id = ? and channel_id = ?
             and logical_response_id = ?`,
        )
        .pluck()
        .get(this.#guildId, this.#channelId, input.logicalResponseId) as
        number | null;
      const fallbackOccurredAt = existingOccurredAt ?? this.#now();
      for (const [chunkIndex, chunk] of input.chunks.entries()) {
        const applied = this.#applyUpsert(
          {
            attachmentMetadataJson: '[]',
            content: chunk.content,
            editedAt: null,
            messageId: chunk.messageId,
            occurredAt: chunk.occurredAt ?? fallbackOccurredAt,
            platformEventId: chunk.messageId,
            replyToMessageId: input.replyToMessageId,
            requestId: input.requestId,
            responseChunkIndex: chunkIndex,
            role: 'chief',
            speakerId: input.speakerId ?? null,
            speakerName: 'Chief',
            type: 'upsert',
          },
          input.logicalResponseId,
        );
        if (applied.eventId !== null && applied.status !== 'suppressed') {
          this.#database
            .prepare(
              `update conversation_events set
                 request_id = case when logical_response_id is null
                                   then ? else request_id end,
                 reply_to_message_id = case when logical_response_id is null
                                            then ? else reply_to_message_id end,
                 logical_response_id = coalesce(logical_response_id, ?),
                 response_chunk_index = ?,
                 platform_event_id = ?
               where id = ? and role = 'chief'`,
            )
            .run(
              input.requestId,
              input.replyToMessageId,
              input.logicalResponseId,
              chunkIndex,
              chunk.messageId,
              applied.eventId,
            );
        }
      }
    })();
  }

  public maintain(now: number): { readonly deletedEvents: number } {
    return this.#database.transaction(() => {
      const expiringIds = this.#database
        .prepare(
          `select id from conversation_events
           where medium = 'text' and content_state = 'available'
             and retention_deadline <= ?`,
        )
        .pluck()
        .all(now) as number[];
      const result = this.#conversation.maintain(now);
      for (const eventId of expiringIds) {
        this.#suppressDescendants(eventId, 'retention-expired', now);
        this.#invalidateEventJobs(eventId);
      }
      return result;
    })();
  }

  #applyUpsert(
    change: ContextSourceUpsert,
    logicalResponseId: string | null = null,
  ): ContextApplyResult {
    const scopeId = this.#sourceScopeId(change.messageId);
    const existingId = this.#eventId(change.messageId);
    if (this.#hasTombstone(scopeId)) {
      return { eventId: existingId, status: 'suppressed' };
    }

    const revisionChecksum =
      change.revisionChecksum ??
      digest({
        attachmentMetadataJson: change.attachmentMetadataJson ?? '[]',
        authorKind: change.role === 'chief' ? 'chief' : 'human',
        content: change.content,
        editedAt: change.editedAt ?? null,
        messageId: change.messageId,
        occurredAt: change.occurredAt,
        replyToMessageId: change.replyToMessageId ?? null,
        requesterId: change.speakerId,
      });
    const existing = this.#existingRevision(change.messageId);
    if (
      existing !== null &&
      !isNewerRevision(
        {
          editedAt: change.editedAt ?? null,
          occurredAt: change.occurredAt,
          revisionChecksum,
        },
        existing,
      )
    ) {
      return { eventId: existing.id, status: 'unchanged' };
    }
    if (existing !== null) {
      this.#suppressDescendants(existing.id, 'retention-expired', this.#now());
      this.#invalidateEventJobs(existing.id);
    }

    const eventId = this.#conversation.record({
      attachmentMetadataJson: change.attachmentMetadataJson ?? '[]',
      channelId: this.#channelId,
      content: change.content,
      discordMessageId: change.messageId,
      editedAt: change.editedAt ?? null,
      guildId: this.#guildId,
      logicalResponseId,
      medium: 'text',
      occurredAt: change.occurredAt,
      platformEventId: change.platformEventId ?? change.messageId,
      recentUntil: change.occurredAt + RECENT_RETENTION_MS,
      replyToMessageId: change.replyToMessageId ?? null,
      requestId: change.requestId,
      responseChunkIndex: change.responseChunkIndex ?? null,
      revisionChecksum,
      retentionDeadline: change.occurredAt + RAW_RETENTION_MS,
      role: change.role,
      speakerId: change.speakerId,
      speakerName: change.speakerName,
    });
    const canonical = this.#database
      .prepare(
        `select content, content_state as contentState,
                occurred_at as occurredAt
         from conversation_events where id = ?`,
      )
      .get(eventId) as {
      content: string;
      contentState: string;
      occurredAt: number;
    };
    if (canonical.contentState !== 'available') {
      return { eventId, status: 'suppressed' };
    }

    this.#database
      .prepare('delete from conversation_event_fts where rowid = ?')
      .run(eventId);
    this.#database
      .prepare(
        'insert into conversation_event_fts (rowid, content) values (?, ?)',
      )
      .run(eventId, canonical.content);
    this.#scheduleHourlyJobs(canonical.occurredAt);
    let memorySourceEventId: number | null = null;
    const memoryExtraction =
      change.role === 'chief'
        ? 'none'
        : (change.memoryExtraction ?? 'automatic');
    if (this.#memory !== undefined && memoryExtraction !== 'none') {
      const observation = {
        canModerateContext: change.canModerateContext ?? false,
        content: canonical.content,
        medium: 'text' as const,
        occurredAt: change.occurredAt,
        platformSourceId: change.messageId,
        retentionDeadline: change.occurredAt + RAW_RETENTION_MS,
        revisionChecksum,
        sourceScopeId: scopeId,
        speakerId: change.speakerId ?? '',
      };
      memorySourceEventId =
        memoryExtraction === 'explicit'
          ? this.#memory.observeExplicit(observation)
          : this.#memory.observe(observation);
    }
    return { eventId, memorySourceEventId, status: 'applied' };
  }

  #applySuppression(change: ContextSourceSuppression): ContextApplyResult {
    const reason = change.reason;
    if (
      (change.type === 'delete' && reason !== 'discord-deleted') ||
      (change.type === 'forget' && reason !== 'locally-forgotten')
    ) {
      throw new Error('context suppression type and reason do not match');
    }
    const scopeId = this.#sourceScopeId(change.messageId);
    const tombstoneKey = `source:${scopeId}`;
    const checksum = digest({
      occurredAt: change.deletedAt,
      reason,
      scopeId,
      scopeType: 'source',
    });
    this.#database
      .prepare(
        `insert into context_tombstones
           (tombstone_key, scope_type, scope_id, reason, occurred_at, checksum)
         values (?, 'source', ?, ?, ?, ?)
         on conflict(scope_type, scope_id) do nothing`,
      )
      .run(tombstoneKey, scopeId, reason, change.deletedAt, checksum);
    this.#database
      .prepare(
        `insert into context_forget_journal
           (journal_key, scope_id, tombstone_key, occurred_at, checksum)
         values (?, ?, ?, ?, ?)
         on conflict(journal_key) do nothing`,
      )
      .run(
        `forget:${scopeId}`,
        scopeId,
        tombstoneKey,
        change.deletedAt,
        checksum,
      );

    const eventId = this.#eventId(change.messageId);
    this.#memory?.suppressSource(change.messageId);
    if (eventId === null) return { eventId, status: 'suppressed' };
    this.#database
      .prepare('delete from conversation_event_fts where rowid = ?')
      .run(eventId);
    this.#database
      .prepare(
        `update conversation_events
         set content = '', attachment_metadata_json = '[]', deleted_at = ?,
             content_state = 'scrubbed', content_state_reason = ?
         where id = ? and content_state = 'available'`,
      )
      .run(change.deletedAt, reason, eventId);
    this.#suppressDescendants(eventId, reason, change.deletedAt);
    this.#invalidateEventJobs(eventId);
    return { eventId, status: 'suppressed' };
  }

  #scheduleHourlyJobs(occurredAt: number): void {
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone: this.#timeZone,
    });
    const checksum = this.#sourceRevisionChecksum(period);
    const now = this.#now();
    this.#upsertJob(
      period,
      'provisional',
      checksum,
      now + PROVISIONAL_DELAY_MS,
    );
    this.#upsertJob(period, 'final', checksum, period.end);
  }

  #upsertJob(
    period: ContextPeriod,
    completeness: 'final' | 'provisional',
    checksum: string,
    notBefore: number,
  ): void {
    this.#database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before)
         values (?, 'hourly', ?, ?, ?, null, ?, ?, ?)
         on conflict(job_key) do update set
           source_revision_checksum = excluded.source_revision_checksum,
           not_before = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
               and context_jobs.completeness = 'provisional'
               and context_jobs.status = 'pending'
             then min(context_jobs.not_before, excluded.not_before)
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then excluded.not_before else context_jobs.not_before end,
           status = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then 'pending' else context_jobs.status end,
           lease_expires_at = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.lease_expires_at end,
           last_error_category = case
             when context_jobs.source_revision_checksum
                    != excluded.source_revision_checksum
             then null else context_jobs.last_error_category end`,
      )
      .run(
        `${period.key}:${completeness}`,
        period.start,
        period.end,
        period.timeZone,
        completeness,
        checksum,
        notBefore,
      );
  }

  #sourceRevisionChecksum(period: ContextPeriod): string {
    const rows = this.#database
      .prepare(
        `select id, discord_message_id as discordMessageId, content,
                edited_at as editedAt
         from conversation_events
         where guild_id = ? and channel_id = ? and medium = 'text'
           and content_state = 'available'
           and occurred_at >= ? and occurred_at < ?
         order by id`,
      )
      .all(
        this.#guildId,
        this.#channelId,
        period.start,
        period.end,
      ) as SourceRevisionRow[];
    return digest(rows);
  }

  #suppressDescendants(
    eventId: number,
    reason: ContextContentStateReason,
    now: number,
  ): void {
    const documentIds = this.#database
      .prepare(
        `with recursive affected(id) as (
           select document_id from context_document_events where event_id = ?
           union
           select p.document_id
           from context_document_parents p
           join affected a on p.parent_document_id = a.id
         )
         select distinct id from affected`,
      )
      .pluck()
      .all(eventId) as number[];
    for (const documentId of documentIds) {
      this.#database
        .prepare('delete from context_document_fts where rowid = ?')
        .run(documentId);
      this.#database
        .prepare('delete from context_document_vectors where document_id = ?')
        .run(BigInt(documentId));
    }
    if (documentIds.length === 0) return;
    const placeholders = documentIds.map(() => '?').join(', ');
    this.#database
      .prepare(
        `update context_documents
         set state = 'suppressed', content_state = 'scrubbed',
             content_state_reason = ?, summary = '', updated_at = ?
         where id in (${placeholders})`,
      )
      .run(reason, now, ...documentIds);
  }

  #invalidateEventJobs(eventId: number): void {
    const occurredAt = this.#database
      .prepare('select occurred_at from conversation_events where id = ?')
      .pluck()
      .get(eventId) as number | undefined;
    if (occurredAt === undefined) return;
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone: this.#timeZone,
    });
    this.#database
      .prepare(
        `update context_jobs
         set status = 'failed', lease_expires_at = null,
             last_error_category = 'source-invalidated'
         where tier = 'hourly' and timezone = ?
           and period_start = ? and period_end = ?`,
      )
      .run(period.timeZone, period.start, period.end);
  }

  #eventId(messageId: string): number | null {
    return (
      (this.#database
        .prepare(
          `select id from conversation_events
           where guild_id = ? and channel_id = ? and discord_message_id = ?`,
        )
        .pluck()
        .get(this.#guildId, this.#channelId, messageId) as
        number | undefined) ?? null
    );
  }

  #existingRevision(messageId: string): ExistingSourceRevision | null {
    return (
      (this.#database
        .prepare(
          `select id, occurred_at as occurredAt, edited_at as editedAt,
                  revision_checksum as revisionChecksum
           from conversation_events
           where guild_id = ? and channel_id = ? and discord_message_id = ?`,
        )
        .get(this.#guildId, this.#channelId, messageId) as
        ExistingSourceRevision | undefined) ?? null
    );
  }

  #hasTombstone(scopeId: string): boolean {
    return (
      this.#database
        .prepare(
          `select exists(
             select 1 from context_tombstones
             where scope_type = 'source' and scope_id = ?
           )`,
        )
        .pluck()
        .get(scopeId) === 1
    );
  }

  #sourceScopeId(messageId: string): string {
    return `${this.#guildId}/${this.#channelId}/${messageId}`;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isNewerRevision(
  incoming: Pick<
    ExistingSourceRevision,
    'editedAt' | 'occurredAt' | 'revisionChecksum'
  >,
  existing: ExistingSourceRevision,
): boolean {
  const incomingTimestamp = incoming.editedAt ?? incoming.occurredAt;
  const existingTimestamp = existing.editedAt ?? existing.occurredAt;
  return (
    incomingTimestamp > existingTimestamp ||
    (incomingTimestamp === existingTimestamp &&
      incoming.revisionChecksum > existing.revisionChecksum)
  );
}
