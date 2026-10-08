import { createHash, randomUUID } from 'node:crypto';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

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
      (queries
        .contextBackfillNextDeadlineSelectContextBackfills(this.#database)
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
            queries
              .contextBackfillRunNextSelectContextDocuments(this.#database)
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
        queries
          .contextBackfillRunNextInsertContextBackfillSegments(this.#database)
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
    const runId = queries
      .contextBackfillActivateSelectContextBackfills(this.#database)
      .pluck()
      .get(this.#scopeId());
    if (runId === undefined) {
      throw new Error('backfill activation requires a completed dry-run');
    }
    const now = this.#now();
    queries
      .contextBackfillActivateUpdateContextBackfills(this.#database)
      .run(input.maximumUsageUsd, now, now, runId);
    const result = this.status(runId);
    if (result === null) throw new Error('activated backfill disappeared');
    return result;
  }

  public async dryRun(input: {
    readonly replace: boolean;
  }): Promise<ContextBackfillStatus> {
    const history = this.#requireHistory();
    const unfinished = queries
      .contextBackfillDryRunSelectContextBackfills(this.#database)
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
        const outstanding = queries
          .contextBackfillDryRunSelectUsageLedger(this.#database)
          .pluck()
          .get(unfinished.id);
        if (outstanding === 1) {
          throw new Error(
            'unfinished backfill has outstanding paid work; retry replacement after it settles',
          );
        }
        queries
          .contextBackfillDryRunUpdateContextBackfills(this.#database)
          .run(createdAt, unfinished.id);
      }
      return Number(
        queries
          .contextBackfillDryRunInsertContextBackfills(this.#database)
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
    queries
      .contextBackfillResumeUpdateContextBackfills(this.#database)
      .run(now, runId, this.#scopeId());
    const resumed = this.status(runId);
    if (resumed === null) throw new Error('resumed backfill disappeared');
    return resumed;
  }

  public status(runId?: number): ContextBackfillStatus | null {
    const row = this.#database
      .prepare(
        readSqliteStatement('contextBackfillStatusSelectContextBackfills', [
          runId === undefined ? '' : readSqliteStatement('backfillRunIdFilter'),
        ]),
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
    const progress = queries
      .contextBackfillScanDryRunSelectContextBackfills(this.#database)
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
      queries
        .contextBackfillRecordManifestPageSelectConversationEvents(
          this.#database,
        )
        .pluck()
        .get(this.#guildId, this.#channelId, messageId),
    ).length;
    const occurred = sources.map(({ occurredAt }) => occurredAt);
    this.#database.transaction(() => {
      queries
        .contextBackfillRecordManifestPageInsertContextBackfillPages(
          this.#database,
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
      queries
        .contextBackfillRecordManifestPageUpdateContextBackfills(this.#database)
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
    const pages = queries
      .contextBackfillCompleteManifestSelectContextBackfillPages(this.#database)
      .all(runId);
    const eligibleTokens = Number(
      queries
        .contextBackfillCompleteManifestSelectContextBackfills(this.#database)
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
    queries
      .contextBackfillCompleteManifestUpdateContextBackfills(this.#database)
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
    const pages = queries
      .contextBackfillManifestSeenIdsSelectContextBackfillPages(this.#database)
      .all(runId) as {
      readonly requestBeforeSourceId: string | null;
    }[];
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
      (queries
        .contextBackfillActiveRunSelectContextBackfills(this.#database)
        .get(this.#scopeId()) as ActiveBackfillRow | undefined) ?? null
    );
  }

  #page(runId: number, pageIndex: number): BackfillPageRow | null {
    return (
      (queries
        .contextBackfillPageSelectContextBackfillPages(this.#database)
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
    const existing = queries
      .contextBackfillSourceEligibleForRunSelectConversationEvents(
        this.#database,
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
    const identity = queries
      .contextBackfillSourceEligibleForRunSelectContextBackfillSourceIdentities(
        this.#database,
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
    const checksum = queries
      .contextBackfillSegmentCommittedSelectContextBackfillSegments(
        this.#database,
      )
      .pluck()
      .get(runId, segment.key);
    return checksum === segmentChecksum(segment);
  }

  #priorAggregateDocument(segment: BackfillSegment): {
    readonly id: number;
    readonly summary: string;
  }[] {
    return queries
      .contextBackfillPriorAggregateDocumentSelectContextDocuments(
        this.#database,
      )
      .all(
        segment.periodKey,
        segment.periodStart,
        segment.periodEnd,
        this.#timeZone,
      );
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
      (queries
        .contextBackfillExistingRevisionSelectConversationEvents(this.#database)
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
    const currentRun = queries
      .contextBackfillAssertSegmentCommitCurrentSelectContextBackfills(
        this.#database,
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
    const existing = queries
      .contextBackfillInsertExpiredIdentitySelectConversationEvents(
        this.#database,
      )
      .pluck()
      .get(this.#guildId, this.#channelId, source.messageId);
    const eventId =
      existing ??
      Number(
        queries
          .contextBackfillInsertExpiredIdentityInsertConversationEvents(
            this.#database,
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
    queries
      .contextBackfillInsertExpiredIdentityInsertContextBackfillSourceIdentities(
        this.#database,
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
    const sourceDocuments = queries
      .contextBackfillScheduleDailySelectContextDocuments(this.#database)
      .all(period.start, period.end);
    const checksum = digest(sourceDocuments);
    queries
      .contextBackfillScheduleDailyInsertContextJobs(this.#database)
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
    queries
      .contextBackfillCompletePageUpdateContextBackfillPages(this.#database)
      .run(now, runId, pageIndex);
    queries
      .contextBackfillCompletePageUpdateContextBackfills(this.#database)
      .run(nextPageIndex, nextPageIndex, now, runId, pageIndex);
  }

  #finalizeRun(runId: number, now: number): ContextBackfillWorkResult {
    const failed = Number(
      queries
        .contextBackfillFinalizeRunSelectContextJobs(this.#database)
        .pluck()
        .get(runId),
    );
    if (failed > 0) {
      this.#pause(runId, 'induced-job-failed', now);
      return { status: 'retry' };
    }
    const outstanding = Number(
      queries
        .contextBackfillFinalizeRunSelectContextJobs2(this.#database)
        .pluck()
        .get(runId),
    );
    if (outstanding > 0) return { status: 'idle' };
    const outstandingReservations = Number(
      queries
        .contextBackfillFinalizeRunSelectUsageLedger(this.#database)
        .pluck()
        .get(runId),
    );
    if (outstandingReservations > 0) return { status: 'idle' };
    queries
      .contextBackfillFinalizeRunUpdateContextBackfills(this.#database)
      .run(now, now, runId);
    return { runId, status: 'completed' };
  }

  #pause(runId: number, reason: string, now: number): void {
    queries
      .contextBackfillPauseUpdateContextBackfills(this.#database)
      .run(reason, now, runId);
  }

  #recoverOutstandingReservations(runId: number, budget: UsageBudget): void {
    const ids = queries
      .contextBackfillRecoverOutstandingReservationsSelectUsageLedger(
        this.#database,
      )
      .pluck()
      .all(runId);
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
