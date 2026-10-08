import type Database from 'better-sqlite3';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

import type {
  ContextContentState,
  ContextContentStateReason,
} from '../context/context-types.js';
import { hasSufficientLexicalOverlap } from '../context/lexical-relevance.js';

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

export interface ConversationSourceGroup {
  readonly content: string;
  readonly ids: readonly number[];
  readonly logicalResponseId: string | null;
  readonly messageIds: readonly string[];
  readonly occurredAt: number;
  readonly speakerName: string | null;
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

interface ConversationSourceRow {
  readonly content: string;
  readonly discordMessageId: string;
  readonly id: number;
  readonly logicalResponseId: string | null;
  readonly occurredAt: number;
  readonly responseChunkIndex: number | null;
  readonly role: ConversationRole;
  readonly speakerName: string | null;
}

const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_MAX_APPROX_TOKENS = 6_000;
const SOURCE_SEARCH_PAGE_SIZE = 24;
const MAX_SOURCE_SCAN_MATCHES = 96;

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
    queries.conversationRecordInsertConversationEvents(this.#database).run(row);
    const eventId = queries
      .conversationRecordSelectConversationEvents(this.#database)
      .pluck()
      .get(row.guildId, row.channelId, row.discordMessageId);
    if (eventId === undefined)
      throw new Error('recorded conversation event missing');

    return eventId;
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
        readSqliteStatement('conversationStoreRecentSelectConversationEvents'),
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
        const content = truncateToTokens(row.content, remaining);
        if (content.length > 0) {
          selected.push({ ...row, content });
          approximateTokens += estimateTokens(content);
        }
        break;
      }
      selected.push(row);
      approximateTokens += tokens;
    }
    selected.reverse();
    return { approximateTokens, events: selected };
  }

  public searchTextSourceGroups(input: {
    readonly beforeEventId?: number;
    readonly channelId: string;
    readonly excludeEventIds?: readonly number[];
    readonly excludeLogicalResponseIds?: readonly string[];
    readonly guildId: string;
    readonly lexicalQuery: string;
    readonly lexicalRelevanceTerms: readonly string[];
    readonly limit: number;
  }): readonly ConversationSourceGroup[] {
    if (input.limit <= 0) return [];
    const excludedEventIds = input.excludeEventIds ?? [];
    const excludedResponseIds = input.excludeLogicalResponseIds ?? [];
    const eventExclusion =
      excludedEventIds.length === 0
        ? ''
        : readSqliteStatement('excludedConversationEventFilter', [
            excludedEventIds.map(() => '?').join(', '),
          ]);
    const responseExclusion =
      excludedResponseIds.length === 0
        ? ''
        : readSqliteStatement('excludedLogicalResponseFilter', [
            excludedResponseIds.map(() => '?').join(', '),
          ]);
    const search = this.#database.prepare(
      readSqliteStatement(
        'conversationStoreSearchTextSourceGroupsSelectConversationEventFts',
        [eventExclusion, responseExclusion],
      ),
    );
    const groups: ConversationSourceGroup[] = [];
    const seen = new Set<string>();
    const pageSize = Math.max(input.limit, SOURCE_SEARCH_PAGE_SIZE);
    let offset = 0;
    while (groups.length < input.limit && offset < MAX_SOURCE_SCAN_MATCHES) {
      const batchSize = Math.min(pageSize, MAX_SOURCE_SCAN_MATCHES - offset);
      const matches = search.all(
        input.lexicalQuery,
        input.guildId,
        input.channelId,
        input.beforeEventId ?? null,
        input.beforeEventId ?? null,
        ...excludedEventIds,
        ...excludedResponseIds,
        batchSize,
        offset,
      ) as ConversationSourceRow[];
      offset += matches.length;
      for (const match of matches) {
        const key =
          match.role === 'chief' && match.logicalResponseId !== null
            ? `response:${match.logicalResponseId}`
            : `event:${String(match.id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rows =
          match.role === 'chief' && match.logicalResponseId !== null
            ? (queries
                .conversationSearchTextSourceGroupsSelectConversationEvents(
                  this.#database,
                )
                .all(
                  input.guildId,
                  input.channelId,
                  match.logicalResponseId,
                  input.beforeEventId ?? null,
                  input.beforeEventId ?? null,
                ) as ConversationSourceRow[])
            : [match];
        const content = rows.map((row) => row.content).join('');
        const searchableContent = rows.map((row) => row.content).join(' ');
        if (
          !hasSufficientLexicalOverlap(
            input.lexicalRelevanceTerms,
            searchableContent,
          )
        ) {
          continue;
        }
        groups.push({
          content,
          ids: rows.map(({ id }) => id),
          logicalResponseId: match.logicalResponseId,
          messageIds: rows.map(({ discordMessageId }) => discordMessageId),
          occurredAt: Math.min(...rows.map(({ occurredAt }) => occurredAt)),
          speakerName: match.speakerName,
        });
        if (groups.length === input.limit) break;
      }
      if (matches.length < batchSize) break;
    }
    return groups;
  }

  public maintain(now: number): { readonly deletedEvents: number } {
    return this.#database.transaction(() => {
      const expiredTextIds = queries
        .conversationMaintainSelectConversationEvents(this.#database)
        .pluck()
        .all(now);
      const deleteSearchRow = this.#database.prepare(
        readSqliteStatement('deleteConversationEventFts'),
      );
      for (const id of expiredTextIds) deleteSearchRow.run(id);
      const scrubbed = queries
        .conversationMaintainUpdateConversationEvents(this.#database)
        .run(now).changes;
      const deleted = queries
        .conversationMaintainDeleteConversationEvents(this.#database)
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
