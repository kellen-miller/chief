import type Database from 'better-sqlite3';

import type { ChiefConversationMessage } from '../agent/chief-agent.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { MemoryService } from '../memory/memory-service.js';
import type {
  ContextTier,
  HistoricalContext,
  HistoricalRollupContext,
  HistoricalSourceContext,
  PreparedContext,
} from './context-types.js';
import { ContextPersistenceError } from './context-errors.js';
import {
  buildLexicalQuery,
  extractLexicalTermSet,
  hasSufficientLexicalOverlap,
} from './lexical-relevance.js';

const TOTAL_CONTEXT_TOKENS = 8_000;
const MAX_RECENT_TOKENS = 6_000;
const MAX_RECENT_MESSAGES = 30;
const SEARCH_LIMIT = 24;
const MAX_LEXICAL_SCAN_MATCHES = SEARCH_LIMIT * 4;
const MAX_VECTOR_DISTANCE = 1.2;
const TIER_ORDER = [
  'source',
  'hourly',
  'daily',
  'weekly',
  'long-term',
] as const;
const TIER_SHARES: Readonly<Record<(typeof TIER_ORDER)[number], number>> = {
  source: 0.35,
  hourly: 0.2,
  daily: 0.15,
  weekly: 0.15,
  'long-term': 0.15,
};

export interface ContextAssemblerOptions {
  readonly channelId: string;
  readonly conversation: ConversationStore;
  readonly database: Database.Database;
  readonly embed: (text: string) => Promise<{
    readonly embedding: Float32Array;
    readonly usageUsd: number;
  }>;
  readonly guildId: string;
  readonly memory: MemoryService;
  readonly timeZone: string;
}

interface RollupSearchRow {
  readonly confidence: number;
  readonly distance?: number;
  readonly id: number;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly summary: string;
  readonly tier: ContextTier;
  readonly topicLabel: string | null;
}

interface LineageRow {
  readonly contentState: 'available' | 'scrubbed';
  readonly contentStateReason:
    'discord-deleted' | 'locally-forgotten' | 'retained' | 'retention-expired';
  readonly discordMessageId: string;
  readonly id: number;
  readonly occurredAt: number;
}

interface RankedHistorical {
  readonly context: HistoricalContext;
  readonly lineageEventIds: ReadonlySet<number>;
  readonly normalizedStatement: string;
  readonly score: number;
  readonly tier: (typeof TIER_ORDER)[number];
}

export class ContextAssembler {
  readonly #channelId: string;
  readonly #conversation: ConversationStore;
  readonly #database: Database.Database;
  readonly #embed: ContextAssemblerOptions['embed'];
  readonly #guildId: string;
  readonly #memory: MemoryService;
  readonly #timeZone: string;

  public constructor(options: ContextAssemblerOptions) {
    this.#channelId = options.channelId;
    this.#conversation = options.conversation;
    this.#database = options.database;
    this.#embed = options.embed;
    this.#guildId = options.guildId;
    this.#memory = options.memory;
    this.#timeZone = options.timeZone;
  }

  public async assemble(input: {
    readonly beforeEventId?: number;
    readonly now: number;
    readonly prompt: string;
  }): Promise<PreparedContext> {
    let recent: ReturnType<ConversationStore['recent']>;
    try {
      recent = this.#conversation.recent({
        ...(input.beforeEventId === undefined
          ? {}
          : { beforeEventId: input.beforeEventId }),
        maxApproxTokens: MAX_RECENT_TOKENS,
        maxMessages: MAX_RECENT_MESSAGES,
        now: input.now,
      });
    } catch (error) {
      throw new ContextPersistenceError(
        'recent conversation persistence failed',
        error,
      );
    }
    const recentConversation = recent.events.map(
      ({ content, role, speakerName }): ChiefConversationMessage => ({
        content,
        role,
        speakerName,
      }),
    );
    let degraded = false;
    let embedded:
      Awaited<ReturnType<ContextAssemblerOptions['embed']>> | undefined;
    let memories: readonly string[] = [];
    try {
      embedded = await this.#embed(input.prompt);
    } catch {
      degraded = true;
      ({ memories } = this.#memory.recallLexical(input.prompt));
    }
    let historicalContext: readonly HistoricalContext[] = [];
    if (embedded !== undefined) {
      ({ memories } = this.#memory.recallPrepared({
        embedding: embedded.embedding,
        now: input.now,
        prompt: input.prompt,
      }));
      try {
        historicalContext = this.#retrieveHistorical({
          ...(input.beforeEventId === undefined
            ? {}
            : { beforeEventId: input.beforeEventId }),
          embedding: embedded.embedding,
          historyTokenAllowance: Math.max(
            0,
            TOTAL_CONTEXT_TOKENS - recent.approximateTokens,
          ),
          now: input.now,
          prompt: input.prompt,
          recentEvents: recent.events,
        });
      } catch {
        degraded = true;
      }
    }
    const historicalTokens = historicalContext.reduce(
      (total, context) => total + estimateTokens(JSON.stringify(context)),
      0,
    );
    return {
      approximateTokens: Math.min(
        TOTAL_CONTEXT_TOKENS,
        recent.approximateTokens + historicalTokens,
      ),
      degraded,
      historicalContext,
      memories,
      recentConversation,
      usageUsd: embedded?.usageUsd ?? 0,
    };
  }

  #retrieveHistorical(input: {
    readonly beforeEventId?: number;
    readonly embedding: Float32Array;
    readonly historyTokenAllowance: number;
    readonly now: number;
    readonly prompt: string;
    readonly recentEvents: ReturnType<ConversationStore['recent']>['events'];
  }): readonly HistoricalContext[] {
    if (input.historyTokenAllowance <= 0) return [];
    const lexicalTerms = extractLexicalTermSet(input.prompt);
    const lexicalQuery = buildLexicalQuery(lexicalTerms.all);
    const recentEventIds = new Set(input.recentEvents.map(({ id }) => id));
    const recentResponseIds = new Set(
      input.recentEvents.flatMap(({ logicalResponseId }) =>
        logicalResponseId === null ? [] : [logicalResponseId],
      ),
    );
    const ranked: RankedHistorical[] = [];
    if (lexicalQuery !== undefined) {
      ranked.push(
        ...this.#sourceCandidates(
          lexicalQuery,
          lexicalTerms.relevance,
          recentEventIds,
          recentResponseIds,
          input.beforeEventId,
        ),
      );
    }
    for (const tier of TIER_ORDER.slice(1) as readonly ContextTier[]) {
      ranked.push(
        ...this.#rollupCandidates(
          tier,
          lexicalQuery,
          lexicalTerms.relevance,
          input.embedding,
          input.beforeEventId,
        ),
      );
    }

    const candidatesByTier = new Map<
      RankedHistorical['tier'],
      RankedHistorical[]
    >(TIER_ORDER.map((tier) => [tier, []]));
    for (const candidate of ranked)
      candidatesByTier.get(candidate.tier)?.push(candidate);
    const recentStatements = new Set(
      input.recentEvents.map(({ content }) => normalizeStatement(content)),
    );
    const acceptedStatements = new Set(recentStatements);
    const acceptedLineage = new Set(recentEventIds);
    const selected: HistoricalContext[] = [];
    for (const tier of TIER_ORDER) {
      let remaining = Math.floor(
        input.historyTokenAllowance * TIER_SHARES[tier],
      );
      const candidates = preferNewestStatements(
        candidatesByTier.get(tier) ?? [],
      );
      candidates.sort((left, right) => right.score - left.score);
      for (const candidate of candidates) {
        if (
          acceptedStatements.has(candidate.normalizedStatement) ||
          intersects(candidate.lineageEventIds, acceptedLineage)
        ) {
          continue;
        }
        const fitted = fitHistoricalContext(candidate.context, remaining);
        if (fitted === null) continue;
        const tokens = estimateTokens(JSON.stringify(fitted));
        selected.push(fitted);
        remaining -= tokens;
        acceptedStatements.add(candidate.normalizedStatement);
        for (const eventId of candidate.lineageEventIds) {
          acceptedLineage.add(eventId);
        }
      }
    }
    return selected;
  }

  #sourceCandidates(
    lexicalQuery: string,
    lexicalTerms: readonly string[],
    recentEventIds: ReadonlySet<number>,
    recentResponseIds: ReadonlySet<string>,
    beforeEventId: number | undefined,
  ): RankedHistorical[] {
    const expanded = this.#conversation.searchTextSourceGroups({
      ...(beforeEventId === undefined ? {} : { beforeEventId }),
      channelId: this.#channelId,
      excludeEventIds: [...recentEventIds],
      excludeLogicalResponseIds: [...recentResponseIds],
      guildId: this.#guildId,
      lexicalQuery,
      lexicalRelevanceTerms: lexicalTerms,
      limit: SEARCH_LIMIT,
    });
    const eligible = expanded.filter(
      (row) =>
        !row.ids.some((id) => recentEventIds.has(id)) &&
        (row.logicalResponseId === null ||
          !recentResponseIds.has(row.logicalResponseId)),
    );
    const timestamps = eligible.map(({ occurredAt }) => occurredAt);
    const newest = Math.max(...timestamps, 0);
    const oldest = Math.min(...timestamps, newest);
    return eligible.map((row, index) => {
      const context: HistoricalSourceContext = {
        confidence: normalizedRank(index, eligible.length),
        evidenceForm: 'source',
        occurredAt: row.occurredAt,
        provenanceQuality: 'source-backed',
        sourceLinks: row.messageIds
          .filter(isDiscordSnowflake)
          .map((messageId) => this.#jumpLink(messageId)),
        speakerName: row.speakerName,
        temporalLabel: this.#sourceTemporalLabel(row.occurredAt),
        text: row.content,
      };
      const recency =
        newest === oldest ? 0 : (row.occurredAt - oldest) / (newest - oldest);
      return {
        context,
        lineageEventIds: new Set(row.ids),
        normalizedStatement: normalizeStatement(row.content),
        score: context.confidence + recency * 0.05,
        tier: 'source' as const,
      };
    });
  }

  #rollupCandidates(
    tier: ContextTier,
    lexicalQuery: string | undefined,
    lexicalTerms: readonly string[],
    embedding: Float32Array,
    beforeEventId: number | undefined,
  ): RankedHistorical[] {
    const lexicalRows =
      lexicalQuery === undefined
        ? []
        : (
            this.#database
              .prepare(
                `select d.id, d.tier, d.period_start as periodStart,
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
               order by bm25(context_document_fts) limit ?`,
              )
              .all(
                lexicalQuery,
                tier,
                this.#guildId,
                this.#channelId,
                beforeEventId ?? null,
                beforeEventId ?? null,
                MAX_LEXICAL_SCAN_MATCHES,
              ) as RollupSearchRow[]
          )
            .filter((row) =>
              hasSufficientLexicalOverlap(lexicalTerms, row.summary),
            )
            .slice(0, SEARCH_LIMIT);
    const serializedEmbedding = JSON.stringify(Array.from(embedding));
    const vectorRows = this.#database
      .prepare(
        `select d.id, d.tier, d.period_start as periodStart,
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
         order by distance limit ?`,
      )
      .all(
        serializedEmbedding,
        tier,
        this.#guildId,
        this.#channelId,
        beforeEventId ?? null,
        beforeEventId ?? null,
        SEARCH_LIMIT,
      ) as RollupSearchRow[];
    const scores = new Map<number, number>();
    lexicalRows.forEach((row, index) => {
      scores.set(row.id, normalizedRank(index, lexicalRows.length));
    });
    vectorRows.forEach((row, index) => {
      if ((row.distance ?? Number.POSITIVE_INFINITY) > MAX_VECTOR_DISTANCE) {
        return;
      }
      scores.set(
        row.id,
        (scores.get(row.id) ?? 0) + normalizedRank(index, vectorRows.length),
      );
    });
    const rowsById = new Map(
      [...lexicalRows, ...vectorRows].map((row) => [row.id, row]),
    );
    const rankedRows = [...scores.entries()].flatMap(([id, score]) => {
      const row = rowsById.get(id);
      return row === undefined ? [] : [{ row, score }];
    });
    const timestamps = rankedRows.map(
      ({ row }) => row.periodEnd ?? row.periodStart,
    );
    const newest = Math.max(...timestamps, 0);
    const oldest = Math.min(...timestamps, newest);
    return rankedRows.flatMap(({ row, score }) => {
      const lineage = this.#lineage(row.id);
      if (lineage.length === 0) return [];
      const timestamp = row.periodEnd ?? row.periodStart;
      const recency =
        newest === oldest ? 0 : (timestamp - oldest) / (newest - oldest);
      const context: HistoricalRollupContext = {
        confidence: row.confidence,
        evidenceForm: 'rollup',
        periodEnd: row.periodEnd,
        periodStart: row.periodStart,
        provenanceQuality: lineage.some(
          ({ contentState }) => contentState !== 'available',
        )
          ? 'summary-only'
          : 'source-backed',
        sourceLinks: lineage
          .filter(
            ({ contentStateReason, discordMessageId }) =>
              contentStateReason !== 'discord-deleted' &&
              contentStateReason !== 'locally-forgotten' &&
              isDiscordSnowflake(discordMessageId),
          )
          .slice(0, 3)
          .map(({ discordMessageId }) => this.#jumpLink(discordMessageId)),
        summary: row.summary,
        temporalLabel: this.#rollupTemporalLabel(row),
        tier,
        ...(row.topicLabel === null ? {} : { topicLabel: row.topicLabel }),
      };
      return [
        {
          context,
          lineageEventIds: new Set(lineage.map(({ id }) => id)),
          normalizedStatement: normalizeStatement(row.summary),
          score: score + recency * 0.05,
          tier,
        },
      ];
    });
  }

  #lineage(documentId: number): LineageRow[] {
    return this.#database
      .prepare(
        `with recursive lineage_documents(id) as (
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
         order by e.occurred_at desc, e.id desc`,
      )
      .all(documentId, this.#guildId, this.#channelId) as LineageRow[];
  }

  #jumpLink(messageId: string): string {
    return `https://discord.com/channels/${this.#guildId}/${this.#channelId}/${messageId}`;
  }

  #sourceTemporalLabel(occurredAt: number): string {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: this.#timeZone,
    }).format(occurredAt);
  }

  #rollupTemporalLabel(
    row: Pick<RollupSearchRow, 'periodStart' | 'tier'>,
  ): string {
    const date = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeZone: this.#timeZone,
    }).format(row.periodStart);
    if (row.tier === 'hourly') {
      return new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        hour: 'numeric',
        month: 'short',
        timeZone: this.#timeZone,
        timeZoneName: 'short',
        year: 'numeric',
      }).format(row.periodStart);
    }
    if (row.tier === 'weekly') return `week of ${date}`;
    if (row.tier === 'long-term') return `since ${date}`;
    return date;
  }
}

function normalizedRank(index: number, count: number): number {
  return count <= 1 ? 1 : 1 - index / count;
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/u.test(value);
}

function normalizeStatement(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function fitHistoricalContext(
  context: HistoricalContext,
  maximumTokens: number,
): HistoricalContext | null {
  if (estimateTokens(JSON.stringify(context)) <= maximumTokens) return context;
  const content =
    context.evidenceForm === 'source' ? context.text : context.summary;
  const characters = Array.from(content);
  let low = 0;
  let high = characters.length;
  let fitted: HistoricalContext | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shortened = `${characters.slice(0, middle).join('').trimEnd()}…`;
    const candidate: HistoricalContext =
      context.evidenceForm === 'source'
        ? { ...context, text: shortened }
        : { ...context, summary: shortened };
    if (estimateTokens(JSON.stringify(candidate)) <= maximumTokens) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

function intersects(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function preferNewestStatements(
  candidates: readonly RankedHistorical[],
): RankedHistorical[] {
  const newest = new Map<string, RankedHistorical>();
  for (const candidate of candidates) {
    const current = newest.get(candidate.normalizedStatement);
    if (
      current === undefined ||
      historicalInstant(candidate.context) > historicalInstant(current.context)
    ) {
      newest.set(candidate.normalizedStatement, candidate);
    }
  }
  return [...newest.values()];
}

function historicalInstant(context: HistoricalContext): number {
  return context.evidenceForm === 'source'
    ? context.occurredAt
    : (context.periodEnd ?? context.periodStart);
}
