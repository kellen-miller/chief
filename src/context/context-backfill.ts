import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { NormalizedTextSource } from '../app/conversation-orchestrator.js';
import type {
  DiscordHistoryPage,
  DiscordHistorySource,
} from '../discord/discord-reconciliation-service.js';
import type { UsageBudget } from '../usage/usage-budget.js';
import { contextPeriod } from './context-period.js';
import { ContextStore } from './context-store.js';
import {
  contextSummaryResultSchema,
  type ContextSummarizer,
  type ContextSummaryResult,
  type ContextSummarySource,
} from './openai-context.js';
import { hasSourceTombstone } from './source-scope.js';

export interface ContextBackfillPricing {
  readonly embeddingInputPerMillionUsd: number;
  readonly summaryInputPerMillionUsd: number;
  readonly summaryOutputPerMillionUsd: number;
}

export interface ContextBackfillServiceOptions {
  readonly applySource?: (
    source: NormalizedTextSource,
    backfillRunId: number,
  ) => unknown;
  readonly budget?: UsageBudget;
  readonly channelId: string;
  readonly database: Database.Database;
  readonly embed?: (text: string) => Promise<{
    readonly embedding: Float32Array;
    readonly usageUsd: number;
  }>;
  readonly estimateUsd?: number;
  readonly guildId: string;
  readonly history?: DiscordHistorySource;
  readonly maxSourceTokens?: number;
  readonly now?: () => number;
  readonly pricing: ContextBackfillPricing;
  readonly summarizer?: ContextSummarizer;
  readonly timeZone?: string;
}

export interface ContextBackfillStatus {
  readonly actualUsageUsd: number;
  readonly alreadyIngestedCount: number;
  readonly eligibleBytes: number;
  readonly eligibleCount: number;
  readonly eligibleTokens: number;
  readonly estimatedUsageUsd: number;
  readonly maximumUsageUsd: number | null;
  readonly newestOccurredAt: number | null;
  readonly oldestOccurredAt: number | null;
  readonly pageCount: number;
  readonly pauseReason: string | null;
  readonly runId: number;
  readonly runKey: string;
  readonly status:
    'active' | 'completed' | 'dry-run' | 'failed' | 'paused' | 'ready';
}

interface BackfillRow {
  readonly actualUsageUsd: number;
  readonly alreadyIngestedCount: number;
  readonly eligibleBytes: number;
  readonly eligibleCount: number;
  readonly eligibleTokens: number;
  readonly estimatedUsageUsd: number;
  readonly maximumUsageUsd: number | null;
  readonly newestOccurredAt: number | null;
  readonly oldestOccurredAt: number | null;
  readonly pageCount: number;
  readonly pauseReason: string | null;
  readonly runId: number;
  readonly runKey: string;
  readonly status: ContextBackfillStatus['status'];
}

interface ActiveBackfillRow {
  readonly nextPageIndex: number | null;
  readonly runId: number;
}

interface BackfillPageRow {
  readonly completedAt: number | null;
  readonly newestSourceId: string;
  readonly oldestSourceId: string;
  readonly pageIndex: number;
  readonly requestBeforeSourceId: string | null;
}

interface ExistingRevisionRow {
  readonly editedAt: number | null;
  readonly occurredAt: number;
  readonly revisionChecksum: string;
}

interface BackfillSegment {
  readonly key: string;
  readonly pageIndex: number;
  readonly periodEnd: number;
  readonly periodKey: string;
  readonly periodStart: number;
  readonly sources: readonly BackfillSegmentSource[];
}

interface BackfillSegmentSource extends ContextSummarySource {
  readonly normalized: NormalizedTextSource;
}

export type ContextBackfillWorkResult =
  | { readonly status: 'completed'; readonly runId: number }
  | { readonly status: 'idle' }
  | {
      readonly reason:
        | 'indexing-budget'
        | 'interactive-headroom'
        | 'overall-budget'
        | 'run-budget'
        | 'usage-contract';
      readonly status: 'budget-paused';
    }
  | { readonly status: 'retry' };

const DEFAULT_MAX_SOURCE_TOKENS = 8_000;
const ESTIMATED_OUTPUT_TOKENS_PER_CALL = 1_200;
const MAX_AGGREGATE_INPUT_TOKENS = ESTIMATED_OUTPUT_TOKENS_PER_CALL * 2;
const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RECENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class ContextBackfillService {
  readonly #applySource:
    | ((source: NormalizedTextSource, backfillRunId: number) => unknown)
    | undefined;
  readonly #budget: UsageBudget | undefined;
  readonly #channelId: string;
  readonly #database: Database.Database;
  readonly #embed:
    | ((text: string) => Promise<{
        readonly embedding: Float32Array;
        readonly usageUsd: number;
      }>)
    | undefined;
  readonly #estimateUsd: number;
  readonly #guildId: string;
  #history: DiscordHistorySource | undefined;
  readonly #maxSourceTokens: number;
  readonly #now: () => number;
  readonly #pricing: ContextBackfillPricing;
  readonly #summarizer: ContextSummarizer | undefined;
  readonly #timeZone: string;

  public constructor(options: ContextBackfillServiceOptions) {
    this.#applySource = options.applySource;
    this.#budget = options.budget;
    this.#channelId = options.channelId;
    this.#database = options.database;
    this.#embed = options.embed;
    this.#estimateUsd = contextCallReservationUsd(
      options.pricing,
      options.estimateUsd ?? 0.05,
    );
    this.#guildId = options.guildId;
    this.#history = options.history;
    this.#maxSourceTokens =
      options.maxSourceTokens ?? DEFAULT_MAX_SOURCE_TOKENS;
    this.#now = options.now ?? Date.now;
    this.#pricing = options.pricing;
    this.#summarizer = options.summarizer;
    this.#timeZone = options.timeZone ?? 'America/New_York';
    if (
      !Number.isSafeInteger(this.#maxSourceTokens) ||
      this.#maxSourceTokens <= 0
    ) {
      throw new RangeError('backfill source token limit must be positive');
    }
    if (!Number.isFinite(this.#estimateUsd) || this.#estimateUsd < 0) {
      throw new RangeError('backfill estimate must be finite and non-negative');
    }
    for (const value of Object.values(options.pricing)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError('backfill prices must be finite and non-negative');
      }
    }
  }

  public attachHistorySource(history: DiscordHistorySource): void {
    this.#history = history;
  }

  public nextDeadline(): number | null {
    if (this.#history === undefined) return null;
    return (
      (this.#database
        .prepare(
          `select min(coalesce(b.activated_at, b.created_at))
           from context_backfills b
           where b.scope_id = ? and b.status = 'active'
             and (
               b.next_page_index is not null
               or exists(
                 select 1 from context_jobs j
                 where j.backfill_run_id = b.id and j.status = 'failed'
               )
               or not exists(
                 select 1 from context_jobs j
                 where j.backfill_run_id = b.id
                   and j.status in ('pending', 'leased')
               )
             )`,
        )
        .pluck()
        .get(this.#scopeId()) as number | null) ?? null
    );
  }

  public async runNext(now: number): Promise<ContextBackfillWorkResult> {
    const run = this.#activeRun();
    if (run === null) return { status: 'idle' };
    const budget = this.#budget;
    if (budget !== undefined) {
      this.#recoverOutstandingReservations(run.runId, budget);
    }
    if (run.nextPageIndex === null) return this.#finalizeRun(run.runId, now);
    const history = this.#history;
    const summarizer = this.#summarizer;
    const embed = this.#embed;
    if (
      history === undefined ||
      budget === undefined ||
      summarizer === undefined ||
      embed === undefined
    ) {
      return { status: 'idle' };
    }
    const page = this.#page(run.runId, run.nextPageIndex);
    if (page === null) throw new Error('backfill manifest page is missing');
    const boundedSources = await this.#refetchManifestSources(history, page);
    if (boundedSources === null) return { status: 'retry' };
    const recent = boundedSources.filter(
      ({ occurredAt }) => occurredAt >= now - RAW_RETENTION_MS,
    );
    if (recent.length > 0) {
      const applySource = this.#applySource;
      if (applySource === undefined) return { status: 'retry' };
      for (const source of [...recent].sort(compareSourceOldestFirst)) {
        applySource(source, run.runId);
      }
    }
    const old = boundedSources.filter(
      (source) =>
        source.occurredAt < now - RAW_RETENTION_MS &&
        this.#sourceEligibleForRun(run.runId, page.pageIndex, source) &&
        !this.#sourceTombstoned(source.messageId),
    );
    const segments = buildSegments(
      old,
      page.pageIndex,
      this.#maxSourceTokens,
      this.#timeZone,
    );
    const segment = segments.find(
      (candidate) => !this.#segmentCommitted(run.runId, candidate),
    );
    if (segment === undefined) {
      this.#completePage(run.runId, page.pageIndex, now);
      return { status: 'completed', runId: run.runId };
    }
    const priorSegments = this.#priorAggregateDocument(segment);
    const estimatedCalls = priorSegments.length === 0 ? 1 : 2;
    const reservation = budget.reserve(
      'context-backfill',
      this.#estimateUsd * estimatedCalls,
      {
        backfillRunId: run.runId,
        priority: 'background',
        workCategory: 'indexing',
      },
    );
    if (!reservation.allowed) {
      const reason = backfillBudgetReason(reservation.reason);
      this.#pause(run.runId, reason, now);
      return { reason, status: 'budget-paused' };
    }
    const expectedRevisions = new Map(
      segment.sources.map(({ normalized }) => [
        normalized.messageId,
        this.#existingRevision(normalized.messageId),
      ]),
    );
    try {
      const segmentResult = await summarizeBackfill(
        summarizer,
        segment.sources,
      );
      const aggregate = await this.#aggregateResult(
        summarizer,
        segmentResult,
        priorSegments,
      );
      const embedded = await embed(aggregate.result.summary);
      const usageUsd =
        segmentResult.usageUsd +
        aggregate.additionalUsageUsd +
        embedded.usageUsd;
      if (usageUsd > reservation.reservedUsd) {
        budget.reconcileConservatively(reservation.id);
        this.#pause(run.runId, 'usage-contract', now);
        return { reason: 'usage-contract', status: 'budget-paused' };
      }
      const commit = this.#database.transaction(() => {
        this.#assertSegmentCommitCurrent(
          run.runId,
          page.pageIndex,
          segment,
          expectedRevisions,
        );
        const eventIds = segment.sources.map(({ normalized }) =>
          this.#insertExpiredIdentity(run.runId, page.pageIndex, normalized),
        );
        const store = new ContextStore(this.#database);
        const internalDocumentId = store.activateBackfillDocumentRevision({
          completeness: 'final',
          confidence: segmentResult.confidence,
          createdAt: now,
          documentKey: `${segment.periodKey}:backfill:${run.runId.toString()}:${segment.key}`,
          embedding: new Float32Array(),
          eventIds,
          generationInputTokens: segmentResult.inputTokens,
          generationOutputTokens: segmentResult.outputTokens,
          generationUsageUsd: segmentResult.usageUsd,
          isInternal: true,
          parentDocumentIds: [],
          periodEnd: segment.periodEnd,
          periodStart: segment.periodStart,
          retentionDeadline: now + RAW_RETENTION_MS,
          revision: 1,
          summary: segmentResult.summary,
          tier: 'hourly',
          timeZone: this.#timeZone,
          topicKey: null,
        });
        const parentDocumentIds = [
          ...priorSegments.map(({ id }) => id),
          internalDocumentId,
        ];
        const revision =
          Number(
            this.#database
              .prepare(
                `select coalesce(max(revision), 0) from context_documents
                 where document_key = ?`,
              )
              .pluck()
              .get(segment.periodKey),
          ) + 1;
        const documentId = store.activateDocumentRevision({
          completeness: 'final',
          confidence: aggregate.result.confidence,
          createdAt: now,
          documentKey: segment.periodKey,
          embedding: embedded.embedding,
          eventIds: [],
          generationInputTokens: aggregate.inputTokens,
          generationOutputTokens: aggregate.outputTokens,
          generationUsageUsd: aggregate.additionalUsageUsd + embedded.usageUsd,
          parentDocumentIds,
          periodEnd: segment.periodEnd,
          periodStart: segment.periodStart,
          retentionDeadline: now + RAW_RETENTION_MS,
          revision,
          summary: aggregate.result.summary,
          tier: 'hourly',
          timeZone: this.#timeZone,
          topicKey: null,
        });
        this.#database
          .prepare(
            `insert into context_backfill_segments
               (run_id, segment_key, page_index, period_start, period_end,
                source_checksum, source_count, document_id,
                actual_usage_usd, committed_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            run.runId,
            segment.key,
            page.pageIndex,
            segment.periodStart,
            segment.periodEnd,
            segmentChecksum(segment),
            segment.sources.length,
            documentId,
            usageUsd,
            now,
          );
        this.#scheduleDaily(segment.periodStart, now, run.runId);
        if (
          segments.every(
            (candidate) =>
              candidate.key === segment.key ||
              this.#segmentCommitted(run.runId, candidate),
          )
        ) {
          this.#completePage(run.runId, page.pageIndex, now);
        }
      });
      budget.reconcileWith(reservation.id, usageUsd, commit);
      return { status: 'completed', runId: run.runId };
    } catch {
      budget.reconcileConservatively(reservation.id);
      return { status: 'retry' };
    }
  }

  public activate(input: {
    readonly confirmGuildId: string;
    readonly maximumUsageUsd: number;
  }): ContextBackfillStatus {
    if (input.confirmGuildId !== this.#guildId) {
      throw new Error('backfill guild confirmation does not match');
    }
    if (!Number.isFinite(input.maximumUsageUsd) || input.maximumUsageUsd <= 0) {
      throw new RangeError('backfill maximum usage must be positive');
    }
    const runId = this.#database
      .prepare(
        `select id from context_backfills
         where scope_id = ? and status = 'ready'
         order by id desc limit 1`,
      )
      .pluck()
      .get(this.#scopeId()) as number | undefined;
    if (runId === undefined) {
      throw new Error('backfill activation requires a completed dry-run');
    }
    const now = this.#now();
    this.#database
      .prepare(
        `update context_backfills
         set status = 'active', maximum_usage_usd = ?, activated_at = ?,
             pause_reason = null, updated_at = ?
         where id = ? and status = 'ready'`,
      )
      .run(input.maximumUsageUsd, now, now, runId);
    const result = this.status(runId);
    if (result === null) throw new Error('activated backfill disappeared');
    return result;
  }

  public async dryRun(input: {
    readonly replace: boolean;
  }): Promise<ContextBackfillStatus> {
    const history = this.#requireHistory();
    const unfinished = this.#database
      .prepare(
        `select id, status from context_backfills
         where scope_id = ?
           and status in ('dry-run', 'ready', 'active', 'paused')
         order by id desc limit 1`,
      )
      .get(this.#scopeId()) as
      { readonly id: number; readonly status: string } | undefined;
    if (unfinished !== undefined && !input.replace) {
      throw new Error(
        `backfill run ${unfinished.id.toString()} is unfinished; resume it or use --replace`,
      );
    }
    const createdAt = this.#now();
    const runId = this.#database.transaction(() => {
      if (unfinished !== undefined) {
        const outstanding = this.#database
          .prepare(
            `select exists(
               select 1 from usage_ledger
               where backfill_run_id = ? and actual_usd is null
             )`,
          )
          .pluck()
          .get(unfinished.id);
        if (outstanding === 1) {
          throw new Error(
            'unfinished backfill has outstanding paid work; retry replacement after it settles',
          );
        }
        this.#database
          .prepare(
            `update context_backfills
             set status = 'failed', pause_reason = 'replaced', updated_at = ?
             where id = ?`,
          )
          .run(createdAt, unfinished.id);
      }
      return Number(
        this.#database
          .prepare(
            `insert into context_backfills
               (run_key, scope_id, status, created_at, updated_at)
             values (?, ?, 'dry-run', ?, ?)`,
          )
          .run(randomUUID(), this.#scopeId(), createdAt, createdAt)
          .lastInsertRowid,
      );
    })();
    return this.#scanDryRun(runId, history);
  }

  public async resume(runId: number): Promise<ContextBackfillStatus> {
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw new RangeError('backfill run ID must be a positive integer');
    }
    const current = this.status(runId);
    if (current === null) throw new Error('backfill run was not found');
    if (current.pauseReason === 'migration-accounting-rebuild-required') {
      throw new Error(
        'backfill accounting is ambiguous; rebuild required before resume',
      );
    }
    if (current.status === 'dry-run') {
      return this.#scanDryRun(runId, this.#requireHistory());
    }
    if (current.status !== 'paused') {
      throw new Error('only paused or incomplete backfills can resume');
    }
    const now = this.#now();
    this.#database
      .prepare(
        `update context_backfills
         set status = 'active', pause_reason = null, updated_at = ?
         where id = ? and scope_id = ? and status = 'paused'`,
      )
      .run(now, runId, this.#scopeId());
    const resumed = this.status(runId);
    if (resumed === null) throw new Error('resumed backfill disappeared');
    return resumed;
  }

  public status(runId?: number): ContextBackfillStatus | null {
    const row = this.#database
      .prepare(
        `select id as runId, run_key as runKey, status,
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
         where scope_id = ? ${runId === undefined ? '' : 'and id = ?'}
         order by id desc limit 1`,
      )
      .get(
        ...(runId === undefined ? [this.#scopeId()] : [this.#scopeId(), runId]),
      ) as BackfillRow | undefined;
    return row ?? null;
  }

  async #scanDryRun(
    runId: number,
    history: DiscordHistorySource,
  ): Promise<ContextBackfillStatus> {
    const startedAt = this.#now();
    const progress = this.#database
      .prepare(
        `select cursor_source_id as cursorSourceId,
                page_count as pageCount
         from context_backfills
         where id = ? and scope_id = ? and status = 'dry-run'`,
      )
      .get(runId, this.#scopeId()) as
      | { readonly cursorSourceId: string | null; readonly pageCount: number }
      | undefined;
    if (progress === undefined) {
      throw new Error('backfill dry-run is not resumable');
    }
    let cursor = progress.cursorSourceId;
    let pageIndex = progress.pageCount;
    const seenMessageIds = await this.#manifestSeenIds(
      runId,
      history,
      progress.pageCount,
    );
    for (;;) {
      const page = await history.fetchPage({
        afterMessageId: null,
        cursor,
        mode: 'backfill',
        retentionCutoff: Number.MIN_SAFE_INTEGER,
        scanUpperBoundMessageId: null,
      });
      if (page.rateLimited || !page.complete) {
        throw new Error(
          page.rateLimited
            ? 'Discord history dry-run was rate-limited'
            : 'Discord history dry-run was incomplete',
        );
      }
      this.#recordManifestPage(
        runId,
        pageIndex,
        cursor,
        page,
        startedAt,
        seenMessageIds,
      );
      pageIndex += 1;
      if (page.nextCursor === null) break;
      if (page.nextCursor === cursor) {
        throw new Error('Discord history dry-run cursor did not advance');
      }
      cursor = page.nextCursor;
    }
    this.#completeManifest(runId, pageIndex, this.#now());
    const result = this.status(runId);
    if (result === null) throw new Error('backfill dry-run disappeared');
    return result;
  }

  #recordManifestPage(
    runId: number,
    pageIndex: number,
    requestBeforeSourceId: string | null,
    page: DiscordHistoryPage,
    now: number,
    seenMessageIds: Set<string>,
  ): void {
    const coverage = page.coverage;
    if (coverage === null) {
      if (page.items.length === 0) return;
      throw new Error('Discord history page is missing coverage');
    }
    const sources = page.items.flatMap(({ source }) => {
      if (source === undefined || seenMessageIds.has(source.messageId)) {
        return [];
      }
      seenMessageIds.add(source.messageId);
      return [source];
    });
    const eligibleBytes = sources.reduce(
      (total, source) => total + Buffer.byteLength(source.content),
      0,
    );
    const eligibleTokens = sources.reduce(
      (total, source) => total + approximateTokens(source.content),
      0,
    );
    const alreadyIngestedCount = sources.filter(({ messageId }) =>
      this.#database
        .prepare(
          `select exists(
             select 1 from conversation_events
             where guild_id = ? and channel_id = ? and discord_message_id = ?
           )`,
        )
        .pluck()
        .get(this.#guildId, this.#channelId, messageId),
    ).length;
    const occurred = sources.map(({ occurredAt }) => occurredAt);
    this.#database.transaction(() => {
      this.#database
        .prepare(
          `insert into context_backfill_pages
             (run_id, page_index, request_before_source_id,
              oldest_source_id, newest_source_id, eligible_count,
              eligible_bytes, eligible_tokens, identity_checksum)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          pageIndex,
          requestBeforeSourceId,
          coverage.oldestMessageId,
          coverage.newestMessageId,
          sources.length,
          eligibleBytes,
          eligibleTokens,
          digest(
            page.items.map(({ messageId, occurredAt, revisionChecksum }) => ({
              messageId,
              occurredAt,
              revisionChecksum,
            })),
          ),
        );
      this.#database
        .prepare(
          `update context_backfills set
             cursor_source_id = ?, eligible_count = eligible_count + ?,
             already_ingested_count = already_ingested_count + ?,
             eligible_bytes = eligible_bytes + ?,
             eligible_tokens = eligible_tokens + ?, page_count = page_count + 1,
             oldest_source_id = case
               when oldest_source_id is null then ?
               when cast(? as integer) < cast(oldest_source_id as integer)
                 then ? else oldest_source_id end,
             newest_source_id = case
               when newest_source_id is null then ?
               when cast(? as integer) > cast(newest_source_id as integer)
                 then ? else newest_source_id end,
             oldest_occurred_at = case
               when ? is null then oldest_occurred_at
               when oldest_occurred_at is null then ?
               else min(oldest_occurred_at, ?) end,
             newest_occurred_at = case
               when ? is null then newest_occurred_at
               when newest_occurred_at is null then ?
               else max(newest_occurred_at, ?) end,
             updated_at = ? where id = ? and status = 'dry-run'`,
        )
        .run(
          page.nextCursor,
          sources.length,
          alreadyIngestedCount,
          eligibleBytes,
          eligibleTokens,
          coverage.oldestMessageId,
          coverage.oldestMessageId,
          coverage.oldestMessageId,
          coverage.newestMessageId,
          coverage.newestMessageId,
          coverage.newestMessageId,
          minimum(occurred),
          minimum(occurred),
          minimum(occurred),
          maximum(occurred),
          maximum(occurred),
          maximum(occurred),
          now,
          runId,
        );
    })();
  }

  #completeManifest(runId: number, pageCount: number, now: number): void {
    const pages = this.#database
      .prepare(
        `select page_index as pageIndex,
                request_before_source_id as requestBeforeSourceId,
                oldest_source_id as oldestSourceId,
                newest_source_id as newestSourceId,
                eligible_count as eligibleCount,
                eligible_bytes as eligibleBytes,
                eligible_tokens as eligibleTokens,
                identity_checksum as identityChecksum
         from context_backfill_pages where run_id = ? order by page_index`,
      )
      .all(runId);
    const eligibleTokens = Number(
      this.#database
        .prepare('select eligible_tokens from context_backfills where id = ?')
        .pluck()
        .get(runId),
    );
    const calls = Math.max(
      pageCount,
      Math.ceil(eligibleTokens / DEFAULT_MAX_SOURCE_TOKENS),
    );
    const outputTokens = calls * ESTIMATED_OUTPUT_TOKENS_PER_CALL;
    const estimatedUsageUsd =
      (eligibleTokens / 1_000_000) * this.#pricing.summaryInputPerMillionUsd +
      (outputTokens / 1_000_000) *
        (this.#pricing.summaryOutputPerMillionUsd +
          this.#pricing.embeddingInputPerMillionUsd);
    this.#database
      .prepare(
        `update context_backfills
         set status = 'ready', cursor_source_id = null,
             next_page_index = ?, estimated_usage_usd = ?,
             manifest_checksum = ?, updated_at = ?
         where id = ? and status = 'dry-run'`,
      )
      .run(
        pageCount === 0 ? null : pageCount - 1,
        estimatedUsageUsd,
        digest(pages),
        now,
        runId,
      );
  }

  async #manifestSeenIds(
    runId: number,
    history: DiscordHistorySource,
    pageCount: number,
  ): Promise<Set<string>> {
    const seen = new Set<string>();
    if (pageCount === 0) return seen;
    const pages = this.#database
      .prepare(
        `select request_before_source_id as requestBeforeSourceId
         from context_backfill_pages
         where run_id = ? order by page_index`,
      )
      .all(runId) as { readonly requestBeforeSourceId: string | null }[];
    for (const page of pages) {
      const fetched = await history.fetchPage({
        afterMessageId: null,
        cursor: page.requestBeforeSourceId,
        mode: 'backfill',
        retentionCutoff: Number.MIN_SAFE_INTEGER,
        scanUpperBoundMessageId: null,
      });
      if (fetched.rateLimited || !fetched.complete) {
        throw new Error('Discord history dry-run resume could not rebuild');
      }
      for (const item of fetched.items) {
        if (item.source !== undefined) seen.add(item.source.messageId);
      }
    }
    return seen;
  }

  #activeRun(): ActiveBackfillRow | null {
    return (
      (this.#database
        .prepare(
          `select id as runId, next_page_index as nextPageIndex
           from context_backfills
           where scope_id = ? and status = 'active'
           order by activated_at, id limit 1`,
        )
        .get(this.#scopeId()) as ActiveBackfillRow | undefined) ?? null
    );
  }

  #page(runId: number, pageIndex: number): BackfillPageRow | null {
    return (
      (this.#database
        .prepare(
          `select page_index as pageIndex,
                  request_before_source_id as requestBeforeSourceId,
                  oldest_source_id as oldestSourceId,
                  newest_source_id as newestSourceId,
                  completed_at as completedAt
           from context_backfill_pages
           where run_id = ? and page_index = ?`,
        )
        .get(runId, pageIndex) as BackfillPageRow | undefined) ?? null
    );
  }

  #boundedPageSources(
    fetched: DiscordHistoryPage,
    page: BackfillPageRow,
  ): NormalizedTextSource[] {
    const lower =
      BigInt(page.oldestSourceId) <= BigInt(page.newestSourceId)
        ? BigInt(page.oldestSourceId)
        : BigInt(page.newestSourceId);
    const upper =
      BigInt(page.oldestSourceId) >= BigInt(page.newestSourceId)
        ? BigInt(page.oldestSourceId)
        : BigInt(page.newestSourceId);
    const selected = new Map<string, NormalizedTextSource>();
    for (const item of fetched.items) {
      const source = item.source;
      const id = BigInt(item.messageId);
      if (source === undefined || id < lower || id > upper) continue;
      const existing = selected.get(source.messageId);
      if (existing === undefined || sourceIsNewer(source, existing)) {
        selected.set(source.messageId, source);
      }
    }
    return [...selected.values()];
  }

  async #refetchManifestSources(
    history: DiscordHistorySource,
    page: BackfillPageRow,
  ): Promise<NormalizedTextSource[] | null> {
    let cursor = page.requestBeforeSourceId;
    const selected = new Map<string, NormalizedTextSource>();
    for (;;) {
      const fetched = await history.fetchPage({
        afterMessageId: null,
        cursor,
        mode: 'backfill',
        retentionCutoff: Number.MIN_SAFE_INTEGER,
        scanUpperBoundMessageId: cursor === null ? page.newestSourceId : null,
      });
      if (fetched.rateLimited || !fetched.complete) return null;
      for (const source of this.#boundedPageSources(fetched, page)) {
        const existing = selected.get(source.messageId);
        if (existing === undefined || sourceIsNewer(source, existing)) {
          selected.set(source.messageId, source);
        }
      }
      const coveredOldest = fetched.coverage?.oldestMessageId;
      if (
        coveredOldest !== undefined &&
        BigInt(coveredOldest) <= BigInt(page.oldestSourceId)
      ) {
        return [...selected.values()];
      }
      if (coveredOldest === undefined || fetched.nextCursor === null)
        return null;
      if (fetched.nextCursor === cursor) return null;
      cursor = fetched.nextCursor;
    }
  }

  #sourceEligibleForRun(
    runId: number,
    pageIndex: number,
    source: NormalizedTextSource,
  ): boolean {
    const existing = this.#database
      .prepare(
        `select id, content_state as contentState,
                content_state_reason as contentStateReason,
                revision_checksum as revisionChecksum
         from conversation_events
         where guild_id = ? and channel_id = ? and discord_message_id = ?`,
      )
      .get(this.#guildId, this.#channelId, source.messageId) as
      | {
          readonly contentState: string;
          readonly contentStateReason: string;
          readonly id: number;
          readonly revisionChecksum: string;
        }
      | undefined;
    if (existing === undefined) return true;
    if (
      existing.contentState !== 'scrubbed' ||
      existing.contentStateReason !== 'retention-expired' ||
      existing.revisionChecksum !== source.revisionChecksum
    ) {
      return false;
    }
    const identity = this.#database
      .prepare(
        `select first_page_index as firstPageIndex,
                revision_checksum as revisionChecksum
         from context_backfill_source_identities
         where run_id = ? and message_id = ? and event_id = ?`,
      )
      .get(runId, source.messageId, existing.id) as
      | { readonly firstPageIndex: number; readonly revisionChecksum: string }
      | undefined;
    return (
      identity?.firstPageIndex === pageIndex &&
      identity.revisionChecksum === source.revisionChecksum
    );
  }

  #sourceTombstoned(messageId: string): boolean {
    return hasSourceTombstone(
      this.#database,
      `${this.#scopeId()}/${messageId}`,
    );
  }

  #segmentCommitted(runId: number, segment: BackfillSegment): boolean {
    const checksum = this.#database
      .prepare(
        `select source_checksum from context_backfill_segments
         where run_id = ? and segment_key = ?`,
      )
      .pluck()
      .get(runId, segment.key) as string | undefined;
    return checksum === segmentChecksum(segment);
  }

  #priorAggregateDocument(segment: BackfillSegment): {
    readonly id: number;
    readonly summary: string;
  }[] {
    return this.#database
      .prepare(
        `select id, summary from context_documents
         where document_key = ? and tier = 'hourly'
           and period_start = ? and period_end = ? and timezone = ?
           and state = 'active' and content_state = 'available'
           and is_internal = 0
         order by revision desc limit 1`,
      )
      .all(
        segment.periodKey,
        segment.periodStart,
        segment.periodEnd,
        this.#timeZone,
      ) as {
      readonly id: number;
      readonly summary: string;
    }[];
  }

  async #aggregateResult(
    summarizer: ContextSummarizer,
    segmentResult: ContextSummaryResult,
    priorSegments: readonly { readonly id: number; readonly summary: string }[],
  ): Promise<{
    readonly additionalUsageUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly result: ContextSummaryResult;
  }> {
    if (priorSegments.length === 0) {
      return {
        additionalUsageUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        result: segmentResult,
      };
    }
    const sources = [
      ...priorSegments.map(({ id, summary }) => ({
        id: `document:${id.toString()}`,
        text: summary,
      })),
      { id: 'segment:new', text: segmentResult.summary },
    ];
    if (
      sources.reduce(
        (total, source) => total + approximateTokens(source.text),
        0,
      ) > MAX_AGGREGATE_INPUT_TOKENS
    ) {
      throw new Error('backfill aggregate input exceeded its hard token bound');
    }
    const result = await summarizeBackfill(summarizer, sources);
    return {
      additionalUsageUsd: result.usageUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      result,
    };
  }

  #existingRevision(messageId: string): ExistingRevisionRow | null {
    return (
      (this.#database
        .prepare(
          `select occurred_at as occurredAt, edited_at as editedAt,
                  revision_checksum as revisionChecksum
           from conversation_events
           where guild_id = ? and channel_id = ? and discord_message_id = ?`,
        )
        .get(this.#guildId, this.#channelId, messageId) as
        ExistingRevisionRow | undefined) ?? null
    );
  }

  #assertSegmentCommitCurrent(
    runId: number,
    pageIndex: number,
    segment: BackfillSegment,
    expectedRevisions: ReadonlyMap<string, ExistingRevisionRow | null>,
  ): void {
    const currentRun = this.#database
      .prepare(
        `select exists(
           select 1 from context_backfills
           where id = ? and scope_id = ? and status = 'active'
             and next_page_index = ?
         )`,
      )
      .pluck()
      .get(runId, this.#scopeId(), pageIndex);
    if (currentRun !== 1 || this.#segmentCommitted(runId, segment)) {
      throw new Error('backfill segment is no longer current');
    }
    for (const { normalized } of segment.sources) {
      if (this.#sourceTombstoned(normalized.messageId)) {
        throw new Error('backfill source is tombstoned');
      }
      const expected = expectedRevisions.get(normalized.messageId) ?? null;
      const current = this.#existingRevision(normalized.messageId);
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error('backfill source revision changed');
      }
    }
  }

  #insertExpiredIdentity(
    runId: number,
    pageIndex: number,
    source: NormalizedTextSource,
  ): number {
    const existing = this.#database
      .prepare(
        `select id from conversation_events
         where guild_id = ? and channel_id = ? and discord_message_id = ?`,
      )
      .pluck()
      .get(this.#guildId, this.#channelId, source.messageId) as
      number | undefined;
    const eventId =
      existing ??
      Number(
        this.#database
          .prepare(
            `insert into conversation_events
             (platform_event_id, discord_message_id, guild_id, channel_id,
              request_id, logical_response_id, role, speaker_id, speaker_name,
              medium, reply_to_message_id, content,
              attachment_metadata_json, occurred_at, edited_at, deleted_at,
              recent_until, retention_deadline, content_state,
              content_state_reason, revision_checksum, response_chunk_index)
           values (?, ?, ?, ?, null, null, ?, ?, null, 'text', ?, '', '[]',
                   ?, ?, null, ?, ?, 'scrubbed', 'retention-expired', ?, null)`,
          )
          .run(
            source.messageId,
            source.messageId,
            this.#guildId,
            this.#channelId,
            source.authorKind === 'chief' ? 'chief' : 'human',
            source.requesterId,
            source.replyToMessageId,
            source.occurredAt,
            source.editedAt,
            source.occurredAt + RECENT_RETENTION_MS,
            source.occurredAt + RAW_RETENTION_MS,
            source.revisionChecksum,
          ).lastInsertRowid,
      );
    this.#database
      .prepare(
        `insert into context_backfill_source_identities
           (run_id, message_id, event_id, first_page_index,
            revision_checksum, occurred_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(run_id, message_id) do nothing`,
      )
      .run(
        runId,
        source.messageId,
        eventId,
        pageIndex,
        source.revisionChecksum,
        source.occurredAt,
      );
    return eventId;
  }

  #scheduleDaily(
    hourlyPeriodStart: number,
    now: number,
    backfillRunId: number,
  ): void {
    const period = contextPeriod({
      instant: hourlyPeriodStart,
      tier: 'daily',
      timeZone: this.#timeZone,
    });
    const sourceDocuments = this.#database
      .prepare(
        `select id, revision from context_documents
         where tier = 'hourly' and completeness = 'final'
           and state = 'active' and content_state = 'available'
           and is_internal = 0 and period_start >= ? and period_end <= ?
         order by period_start, id`,
      )
      .all(period.start, period.end);
    const checksum = digest(sourceDocuments);
    this.#database
      .prepare(
        `insert into context_jobs
           (job_key, tier, period_start, period_end, timezone, topic_key,
            completeness, source_revision_checksum, not_before,
            freshness_deadline, source_document_ids_json, backfill_run_id)
         values (?, 'daily', ?, ?, ?, null, 'final', ?, ?, ?, '[]', ?)
         on conflict(job_key) do update set
           source_revision_checksum = excluded.source_revision_checksum,
           status = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then 'pending' else context_jobs.status end,
           not_before = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then excluded.not_before else context_jobs.not_before end,
           lease_expires_at = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then null else context_jobs.lease_expires_at end,
           usage_reservation_id = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then null else context_jobs.usage_reservation_id end,
           last_error_category = case
             when context_jobs.source_revision_checksum !=
                  excluded.source_revision_checksum
             then null else context_jobs.last_error_category end,
           backfill_run_id = case
             when excluded.backfill_run_id is not null
             then excluded.backfill_run_id
             when context_jobs.status = 'completed' then null
             else context_jobs.backfill_run_id end`,
      )
      .run(
        `${period.key}:final`,
        period.start,
        period.end,
        period.timeZone,
        checksum,
        Math.min(now, period.end),
        period.end + 30 * 60 * 1_000,
        backfillRunId,
      );
  }

  #completePage(runId: number, pageIndex: number, now: number): void {
    const nextPageIndex = pageIndex - 1;
    this.#database
      .prepare(
        `update context_backfill_pages set completed_at = coalesce(completed_at, ?)
         where run_id = ? and page_index = ?`,
      )
      .run(now, runId, pageIndex);
    this.#database
      .prepare(
        `update context_backfills
         set next_page_index = case when ? < 0 then null else ? end,
             updated_at = ?
         where id = ? and status = 'active' and next_page_index = ?`,
      )
      .run(nextPageIndex, nextPageIndex, now, runId, pageIndex);
  }

  #finalizeRun(runId: number, now: number): ContextBackfillWorkResult {
    const failed = Number(
      this.#database
        .prepare(
          `select count(*) from context_jobs
           where backfill_run_id = ? and status = 'failed'`,
        )
        .pluck()
        .get(runId),
    );
    if (failed > 0) {
      this.#pause(runId, 'induced-job-failed', now);
      return { status: 'retry' };
    }
    const outstanding = Number(
      this.#database
        .prepare(
          `select count(*) from context_jobs
           where backfill_run_id = ? and status in ('pending', 'leased')`,
        )
        .pluck()
        .get(runId),
    );
    if (outstanding > 0) return { status: 'idle' };
    const outstandingReservations = Number(
      this.#database
        .prepare(
          `select count(*) from usage_ledger
           where backfill_run_id = ? and actual_usd is null`,
        )
        .pluck()
        .get(runId),
    );
    if (outstandingReservations > 0) return { status: 'idle' };
    this.#database
      .prepare(
        `update context_backfills
         set status = 'completed', completed_at = ?, updated_at = ?
         where id = ? and status = 'active' and next_page_index is null`,
      )
      .run(now, now, runId);
    return { runId, status: 'completed' };
  }

  #pause(runId: number, reason: string, now: number): void {
    this.#database
      .prepare(
        `update context_backfills
         set status = 'paused', pause_reason = ?, updated_at = ?
         where id = ? and status = 'active'`,
      )
      .run(reason, now, runId);
  }

  #recoverOutstandingReservations(runId: number, budget: UsageBudget): void {
    const ids = this.#database
      .prepare(
        `select id from usage_ledger
         where backfill_run_id = ? and actual_usd is null order by occurred_at`,
      )
      .pluck()
      .all(runId) as string[];
    for (const id of ids) {
      try {
        budget.reconcileConservatively(id);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'unknown usage reservation'
        ) {
          throw error;
        }
      }
    }
  }

  #requireHistory(): DiscordHistorySource {
    if (this.#history === undefined) {
      throw new Error('Discord history source is unavailable');
    }
    return this.#history;
  }

  #scopeId(): string {
    return `${this.#guildId}/${this.#channelId}`;
  }
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contextCallReservationUsd(
  pricing: ContextBackfillPricing,
  configuredMinimumUsd: number,
): number {
  const hardProviderBound =
    0.5 * pricing.summaryInputPerMillionUsd +
    0.0012 * pricing.summaryOutputPerMillionUsd +
    0.0012 * pricing.embeddingInputPerMillionUsd;
  return Math.max(configuredMinimumUsd, hardProviderBound);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function minimum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function compareSourceOldestFirst(
  left: NormalizedTextSource,
  right: NormalizedTextSource,
): number {
  if (left.occurredAt !== right.occurredAt) {
    return left.occurredAt - right.occurredAt;
  }
  const leftId = BigInt(left.messageId);
  const rightId = BigInt(right.messageId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function sourceIsNewer(
  incoming: NormalizedTextSource,
  existing: NormalizedTextSource,
): boolean {
  const incomingRevisionAt = incoming.editedAt ?? incoming.occurredAt;
  const existingRevisionAt = existing.editedAt ?? existing.occurredAt;
  return (
    incomingRevisionAt > existingRevisionAt ||
    (incomingRevisionAt === existingRevisionAt &&
      incoming.revisionChecksum > existing.revisionChecksum)
  );
}

function buildSegments(
  sources: readonly NormalizedTextSource[],
  pageIndex: number,
  maximumTokens: number,
  timeZone: string,
): BackfillSegment[] {
  const periods = new Map<
    string,
    {
      readonly end: number;
      readonly key: string;
      readonly sources: NormalizedTextSource[];
      readonly start: number;
    }
  >();
  for (const source of [...sources].sort(compareSourceOldestFirst)) {
    const period = contextPeriod({
      instant: source.occurredAt,
      tier: 'hourly',
      timeZone,
    });
    const existing = periods.get(period.key);
    if (existing === undefined) {
      periods.set(period.key, {
        end: period.end,
        key: period.key,
        sources: [source],
        start: period.start,
      });
    } else {
      existing.sources.push(source);
    }
  }
  const result: BackfillSegment[] = [];
  for (const period of [...periods.values()].sort(
    (left, right) => left.start - right.start,
  )) {
    const pieces = period.sources.flatMap((source) => {
      const maximumCharacters = maximumTokens * 4;
      const count = Math.max(
        1,
        Math.ceil(source.content.length / maximumCharacters),
      );
      return Array.from({ length: count }, (_, index) => ({
        id: `source:${source.messageId}#part:${index.toString()}`,
        normalized: source,
        text: source.content.slice(
          index * maximumCharacters,
          (index + 1) * maximumCharacters,
        ),
      }));
    });
    let current: BackfillSegmentSource[] = [];
    let currentTokens = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      result.push({
        key: `${pageIndex.toString()}:${period.start.toString()}:${digest(
          current.map(({ id, normalized, text }) => ({
            id,
            revisionChecksum: normalized.revisionChecksum,
            textChecksum: digest(text),
          })),
        )}`,
        pageIndex,
        periodEnd: period.end,
        periodKey: period.key,
        periodStart: period.start,
        sources: current,
      });
      current = [];
      currentTokens = 0;
    };
    for (const piece of pieces) {
      const tokens = approximateTokens(piece.text);
      if (current.length > 0 && currentTokens + tokens > maximumTokens) flush();
      current.push(piece);
      currentTokens += tokens;
    }
    flush();
  }
  return result;
}

async function summarizeBackfill(
  summarizer: ContextSummarizer,
  sources: readonly ContextSummarySource[],
): Promise<ContextSummaryResult> {
  const result = contextSummaryResultSchema.parse(
    await summarizer.summarize({
      completeness: 'final',
      sources,
      tier: 'hourly',
    }),
  );
  const supplied = new Set(sources.map(({ id }) => id));
  if (result.sourceIds.some((sourceId) => !supplied.has(sourceId))) {
    throw new Error('backfill summary referenced an unknown source');
  }
  for (const proposal of result.topicProposals) {
    if (proposal.sourceIds.some((sourceId) => !supplied.has(sourceId))) {
      throw new Error('backfill topic referenced an unknown source');
    }
  }
  return result;
}

function segmentChecksum(segment: BackfillSegment): string {
  return digest(
    segment.sources.map(({ id, normalized, text }) => ({
      id,
      messageId: normalized.messageId,
      revisionChecksum: normalized.revisionChecksum,
      textChecksum: digest(text),
    })),
  );
}

function backfillBudgetReason(
  reason:
    'ceiling' | 'indexing-ceiling' | 'interactive-headroom' | 'run-ceiling',
):
  'indexing-budget' | 'interactive-headroom' | 'overall-budget' | 'run-budget' {
  switch (reason) {
    case 'ceiling':
      return 'overall-budget';
    case 'indexing-ceiling':
      return 'indexing-budget';
    case 'interactive-headroom':
      return reason;
    case 'run-ceiling':
      return 'run-budget';
  }
}
