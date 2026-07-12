import type Database from 'better-sqlite3';

export type ConversationRole = 'human' | 'chief';
export type ConversationMedium = 'text' | 'voice';

export interface ConversationEventInput {
  readonly content: string;
  readonly medium: ConversationMedium;
  readonly occurredAt: number;
  readonly platformEventId: string;
  readonly requestId: string | null;
  readonly retentionDeadline: number;
  readonly role: ConversationRole;
  readonly speakerId: string | null;
  readonly speakerName: string | null;
}

export interface ConversationEvent extends ConversationEventInput {
  readonly id: number;
}

export interface RecentConversation {
  readonly approximateTokens: number;
  readonly events: readonly ConversationEvent[];
}

interface ConversationRow {
  readonly content: string;
  readonly id: number;
  readonly medium: ConversationMedium;
  readonly occurredAt: number;
  readonly platformEventId: string;
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
    this.#database
      .prepare(
        `insert into conversation_events
           (platform_event_id, request_id, role, speaker_id, speaker_name,
            medium, content, occurred_at, retention_deadline)
         values (@platformEventId, @requestId, @role, @speakerId, @speakerName,
                 @medium, @content, @occurredAt, @retentionDeadline)
         on conflict(platform_event_id) do update set
           request_id = excluded.request_id,
           speaker_name = excluded.speaker_name,
           content = excluded.content,
           retention_deadline = excluded.retention_deadline`,
      )
      .run(event);
    return this.#database
      .prepare('select id from conversation_events where platform_event_id = ?')
      .pluck()
      .get(event.platformEventId) as number;
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
                  e.request_id as requestId, e.role,
                  e.speaker_id as speakerId, e.speaker_name as speakerName,
                  e.medium, e.content, e.occurred_at as occurredAt,
                  e.retention_deadline as retentionDeadline,
                  case when e.role = 'chief' then coalesce(
                    (select min(h.id) from conversation_events h
                     where h.role = 'human' and h.request_id = e.request_id),
                    e.id
                  ) else e.id end as contextOrder,
                  case when e.role = 'chief' then 1 else 0 end as roleOrder
           from conversation_events e
           where e.retention_deadline > @now
             and (
               @beforeEventId is null
               or e.id < @beforeEventId
               or (e.role = 'chief' and exists (
                 select 1 from conversation_events h
                 where h.role = 'human' and h.request_id = e.request_id
                   and h.id < @beforeEventId
               ))
             )
         )
         select id, platformEventId, requestId, role, speakerId, speakerName,
                medium, content, occurredAt, retentionDeadline
         from contextual_events
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
    const result = this.#database
      .prepare('delete from conversation_events where retention_deadline <= ?')
      .run(now);
    return { deletedEvents: result.changes };
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
