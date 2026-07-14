import type Database from 'better-sqlite3';

import type {
  ContextContentState,
  ContextContentStateReason,
} from '../context/context-types.js';

export type ConversationRole = 'human' | 'chief';
export type ConversationMedium = 'text' | 'voice';
export type ConversationContentState = ContextContentState;
export type ConversationContentStateReason = ContextContentStateReason;

export interface ConversationEventInput {
  readonly attachmentMetadataJson?: string;
  readonly channelId?: string;
  readonly content: string;
  readonly discordMessageId?: string;
  readonly editedAt?: number | null;
  readonly guildId?: string;
  readonly logicalResponseId?: string | null;
  readonly medium: ConversationMedium;
  readonly occurredAt: number;
  readonly platformEventId: string;
  readonly recentUntil?: number;
  readonly replyToMessageId?: string | null;
  readonly requestId: string | null;
  readonly responseChunkIndex?: number | null;
  readonly revisionChecksum?: string;
  readonly retentionDeadline: number;
  readonly role: ConversationRole;
  readonly speakerId: string | null;
  readonly speakerName: string | null;
}

export interface ConversationEvent {
  readonly attachmentMetadataJson: string;
  readonly channelId: string;
  readonly content: string;
  readonly contentState: ConversationContentState;
  readonly contentStateReason: ConversationContentStateReason;
  readonly deletedAt: number | null;
  readonly discordMessageId: string;
  readonly editedAt: number | null;
  readonly guildId: string;
  readonly id: number;
  readonly logicalResponseId: string | null;
  readonly medium: ConversationMedium;
  readonly occurredAt: number;
  readonly platformEventId: string;
  readonly recentUntil: number;
  readonly replyToMessageId: string | null;
  readonly requestId: string | null;
  readonly retentionDeadline: number;
  readonly role: ConversationRole;
  readonly speakerId: string | null;
  readonly speakerName: string | null;
}

export interface RecentConversation {
  readonly approximateTokens: number;
  readonly events: readonly ConversationEvent[];
}

interface ConversationRow {
  readonly attachmentMetadataJson: string;
  readonly channelId: string;
  readonly content: string;
  readonly contentState: ConversationContentState;
  readonly contentStateReason: ConversationContentStateReason;
  readonly deletedAt: number | null;
  readonly discordMessageId: string;
  readonly editedAt: number | null;
  readonly guildId: string;
  readonly id: number;
  readonly logicalResponseId: string | null;
  readonly medium: ConversationMedium;
  readonly occurredAt: number;
  readonly platformEventId: string;
  readonly recentUntil: number;
  readonly replyToMessageId: string | null;
  readonly requestId: string | null;
  readonly retentionDeadline: number;
  readonly role: ConversationRole;
  readonly speakerId: string | null;
  readonly speakerName: string | null;
}

const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_MAX_APPROX_TOKENS = 6_000;

export class ConversationStore {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public record(event: ConversationEventInput): number {
    const row = {
      ...event,
      attachmentMetadataJson: event.attachmentMetadataJson ?? '[]',
      channelId: event.channelId ?? '',
      discordMessageId: event.discordMessageId ?? event.platformEventId,
      editedAt: event.editedAt ?? null,
      guildId: event.guildId ?? '',
      logicalResponseId: event.logicalResponseId ?? null,
      recentUntil: event.recentUntil ?? event.retentionDeadline,
      replyToMessageId: event.replyToMessageId ?? null,
      responseChunkIndex: event.responseChunkIndex ?? null,
      revisionChecksum: event.revisionChecksum ?? '',
    };
    this.#database
      .prepare(
        `insert into conversation_events
           (platform_event_id, discord_message_id, guild_id, channel_id,
            request_id, logical_response_id, role, speaker_id, speaker_name,
            medium, reply_to_message_id, content, attachment_metadata_json,
            occurred_at, edited_at, recent_until, retention_deadline,
            content_state, content_state_reason, revision_checksum,
            response_chunk_index)
         values (@platformEventId, @discordMessageId, @guildId, @channelId,
                 @requestId, @logicalResponseId, @role, @speakerId,
                 @speakerName, @medium, @replyToMessageId, @content,
                 @attachmentMetadataJson, @occurredAt, @editedAt,
                 @recentUntil, @retentionDeadline, 'available', 'retained',
                 @revisionChecksum, @responseChunkIndex)
         on conflict(guild_id, channel_id, discord_message_id) do update set
           speaker_name = excluded.speaker_name,
           speaker_id = excluded.speaker_id,
           edited_at = excluded.edited_at,
           reply_to_message_id = excluded.reply_to_message_id,
           response_chunk_index = coalesce(
             excluded.response_chunk_index,
             conversation_events.response_chunk_index
           ),
           content = case when conversation_events.content_state = 'available'
             then excluded.content else conversation_events.content end,
           attachment_metadata_json = case
             when conversation_events.content_state = 'available'
             then excluded.attachment_metadata_json
             else conversation_events.attachment_metadata_json end,
           revision_checksum = excluded.revision_checksum`,
      )
      .run(row);
    return this.#database
      .prepare(
        `select id from conversation_events
         where guild_id = ? and channel_id = ? and discord_message_id = ?`,
      )
      .pluck()
      .get(row.guildId, row.channelId, row.discordMessageId) as number;
  }

  public recordBatch(
    events: readonly ConversationEventInput[],
  ): readonly number[] {
    return this.#database.transaction(() =>
      events.map((event) => this.record(event)),
    )();
  }

  public recent(input: {
    readonly beforeEventId?: number;
    readonly maxApproxTokens?: number;
    readonly maxMessages?: number;
    readonly now: number;
  }): RecentConversation {
    const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxApproxTokens = input.maxApproxTokens ?? DEFAULT_MAX_APPROX_TOKENS;
    if (maxMessages <= 0 || maxApproxTokens <= 0) {
      return { approximateTokens: 0, events: [] };
    }
    const rows = this.#database
      .prepare(
        `with contextual_events as (
           select e.id, e.platform_event_id as platformEventId,
                  e.discord_message_id as discordMessageId,
                  e.guild_id as guildId, e.channel_id as channelId,
                  e.request_id as requestId, e.role,
                  e.logical_response_id as logicalResponseId,
                  e.response_chunk_index as responseChunkIndex,
                  e.speaker_id as speakerId, e.speaker_name as speakerName,
                  e.medium, e.reply_to_message_id as replyToMessageId,
                  e.content,
                  e.attachment_metadata_json as attachmentMetadataJson,
                  e.occurred_at as occurredAt, e.edited_at as editedAt,
                  e.deleted_at as deletedAt,
                  e.recent_until as recentUntil,
                  e.retention_deadline as retentionDeadline,
                  e.content_state as contentState,
                  e.content_state_reason as contentStateReason,
                  case when e.role = 'chief' then coalesce(
                    (select min(h.id) from conversation_events h
                     where h.role = 'human' and h.request_id = e.request_id),
                    e.id
                  ) else e.id end as contextOrder,
                  case when e.role = 'chief' then 1 else 0 end as roleOrder
           from conversation_events e
           where e.recent_until > @now
             and e.content_state = 'available'
             and (
               @beforeEventId is null
               or e.id < @beforeEventId
               or (e.role = 'chief' and exists (
                 select 1 from conversation_events h
                 where h.role = 'human' and h.request_id = e.request_id
                   and h.id < @beforeEventId
               ))
             )
         ), grouped_events as (
           select min(id) as id,
                  min(platformEventId) as platformEventId,
                  min(discordMessageId) as discordMessageId,
                  min(guildId) as guildId, min(channelId) as channelId,
                  min(requestId) as requestId,
                  min(logicalResponseId) as logicalResponseId,
                  min(role) as role, min(speakerId) as speakerId,
                  min(speakerName) as speakerName, min(medium) as medium,
                  min(replyToMessageId) as replyToMessageId,
                  group_concat(
                    content, '' order by
                      coalesce(responseChunkIndex, 2147483647), id
                  ) as content,
                  min(attachmentMetadataJson) as attachmentMetadataJson,
                  min(occurredAt) as occurredAt, max(editedAt) as editedAt,
                  max(deletedAt) as deletedAt,
                  min(recentUntil) as recentUntil,
                  min(retentionDeadline) as retentionDeadline,
                  min(contentState) as contentState,
                  min(contentStateReason) as contentStateReason,
                  min(contextOrder) as contextOrder,
                  max(roleOrder) as roleOrder
           from contextual_events
           group by case
             when role = 'chief' and logicalResponseId is not null
             then 'response:' || logicalResponseId
             else 'event:' || cast(id as text)
           end
         )
         select id, platformEventId, discordMessageId, guildId, channelId,
                requestId, logicalResponseId, role, speakerId, speakerName,
                medium, replyToMessageId, content, attachmentMetadataJson,
                occurredAt, editedAt, deletedAt, recentUntil,
                retentionDeadline, contentState, contentStateReason
         from grouped_events
         order by contextOrder desc, roleOrder desc, id desc
         limit @maxMessages`,
      )
      .all({
        beforeEventId: input.beforeEventId ?? null,
        maxMessages,
        now: input.now,
      }) as ConversationRow[];

    const selected: ConversationEvent[] = [];
    let approximateTokens = 0;
    for (const row of rows) {
      const remaining = maxApproxTokens - approximateTokens;
      const tokens = estimateTokens(row.content);
      if (tokens > remaining) {
        if (selected.length === 0) {
          const content = truncateToTokens(row.content, remaining);
          if (content.length > 0) {
            selected.push({ ...row, content });
            approximateTokens = estimateTokens(content);
          }
        }
        break;
      }
      selected.push(row);
      approximateTokens += tokens;
    }
    selected.reverse();
    return { approximateTokens, events: selected };
  }

  public maintain(now: number): { readonly deletedEvents: number } {
    return this.#database.transaction(() => {
      const expiredTextIds = this.#database
        .prepare(
          `select id from conversation_events
           where medium = 'text' and content_state = 'available'
             and retention_deadline <= ?`,
        )
        .pluck()
        .all(now) as number[];
      const deleteSearchRow = this.#database.prepare(
        'delete from conversation_event_fts where rowid = ?',
      );
      for (const id of expiredTextIds) deleteSearchRow.run(id);
      const scrubbed = this.#database
        .prepare(
          `update conversation_events
           set content = '', attachment_metadata_json = '[]',
               content_state = 'scrubbed',
               content_state_reason = 'retention-expired'
           where medium = 'text' and content_state = 'available'
             and retention_deadline <= ?`,
        )
        .run(now).changes;
      const deleted = this.#database
        .prepare(
          `delete from conversation_events
           where medium = 'voice' and retention_deadline <= ?`,
        )
        .run(now).changes;
      return { deletedEvents: scrubbed + deleted };
    })();
  }
}

function estimateTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 3);
}

function truncateToTokens(content: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(content),
    ({ segment }) => segment,
  );
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join('')) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join('');
}
