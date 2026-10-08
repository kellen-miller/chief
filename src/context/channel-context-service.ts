import { createHash, randomBytes } from 'node:crypto';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

import type Database from 'better-sqlite3';

import {
  ConversationStore,
  type ConversationRole,
} from '../conversation/conversation-store.js';
import type { SqliteMemoryStore } from '../memory/memory-store.js';
import type { UsageBudget } from '../usage/usage-budget.js';
import type { DiscordHistorySource } from '../discord/discord-reconciliation-service.js';
import {
  contextCallReservationUsd,
  ContextBackfillService,
  type ContextBackfillPricing,
  type ContextBackfillWorkResult,
} from './context-backfill.js';
import { contextPeriod, type ContextPeriod } from './context-period.js';
import {
  ContextDeletionStore,
  type ContextForgetJournalEntry,
} from './context-deletion-store.js';
import { ContextStore } from './context-store.js';
import {
  extractLexicalTermSet,
  hasCompleteLexicalAnchor,
} from './lexical-relevance.js';
import {
  contextSummaryResultSchema,
  type ContextSummarizer,
  type ContextSummaryResult,
  type ContextSummarySource,
} from './openai-context.js';
import { hasSourceTombstone } from './source-scope.js';
import type {
  ContextCompleteness,
  ContextContentStateReason,
  ContextTier,
} from './context-types.js';

const RECENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PROVISIONAL_ELIGIBILITY_DELAY_MS = 4 * 60 * 1_000;
const PROVISIONAL_DEADLINE_MS = 5 * 60 * 1_000;
const FINAL_HOURLY_DEADLINE_MS = 10 * 60 * 1_000;
const FINAL_DAILY_DEADLINE_MS = 30 * 60 * 1_000;
const FINAL_WEEKLY_DEADLINE_MS = 2 * 60 * 60 * 1_000;
const LONG_TERM_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const HOURLY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DAILY_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

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
  readonly backfillPricing?: ContextBackfillPricing;
  readonly budget?: UsageBudget;
  readonly channelId: string;
  readonly conversation: ConversationStore;
  readonly database: Database.Database;
  readonly embed?: (text: string) => Promise<{
    readonly embedding: Float32Array;
    readonly usageUsd: number;
  }>;
  readonly estimateUsd?: number;
  readonly guildId: string;
  readonly maxSourceTokens?: number;
  readonly memory?: SqliteMemoryStore;
  readonly now?: () => number;
  readonly summarizer?: ContextSummarizer;
  readonly timeZone: string;
  readonly uploadForgetJournal?: (
    entry: ContextForgetJournalEntry,
  ) => Promise<void>;
}

export interface ContextForgetRequest {
  readonly canModerateContext: boolean;
  readonly confirmationNonce?: string;
  readonly content: string;
  readonly now: number;
  readonly requestMessageId: string;
  readonly requesterId: string;
}

export type ContextForgetReceipt =
  | {
      readonly status:
        | 'clarification-required'
        | 'confirmation-expired'
        | 'confirmation-invalid'
        | 'unauthorized';
    }
  | {
      readonly confirmationNonce: string;
      readonly documentCount: number;
      readonly memoryCount: number;
      readonly sourceCount: number;
      readonly status: 'confirmation-required';
    }
  | {
      readonly documentCount: number;
      readonly memoryCount: number;
      readonly sourceCount: number;
      readonly status: 'forgotten' | 'journal-pending';
    };

export type ContextJobResult =
  | { readonly status: 'idle' }
  | {
      readonly completeness: ContextCompleteness;
      readonly documentId: number;
      readonly status: 'completed';
      readonly tier: ContextTier;
    }
  | {
      readonly notBefore: number;
      readonly reason:
        | 'indexing-budget'
        | 'interactive-headroom'
        | 'overall-budget'
        | 'run-budget'
        | 'usage-contract';
      readonly status: 'budget-deferred';
    }
  | { readonly status: 'failed' }
  | { readonly notBefore: number; readonly status: 'retry' };

export interface ContextStatus {
  readonly backfillCounts: Readonly<
    Record<'active' | 'failed' | 'paused', number>
  >;
  readonly degraded: boolean;
  readonly failedJobs: number;
  readonly lagMsByTier: Readonly<Record<ContextTier, number>>;
  readonly pendingJobs: number;
  readonly reason:
    | 'backlog'
    | 'forget-journal'
    | 'indexing-budget'
    | 'interactive-headroom'
    | 'migration-accounting-ambiguous'
    | 'overall-budget'
    | 'provider'
    | 'run-budget'
    | null;
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

interface ContextJobRow {
  readonly attemptCount: number;
  readonly backfillRunId: number | null;
  readonly completeness: ContextCompleteness;
  readonly id: number;
  readonly jobKey: string;
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly sourceRevisionChecksum: string;
  readonly sourceDocumentIdsJson: string;
  readonly tier: ContextTier;
  readonly timeZone: string;
  readonly topicKey: string | null;
  readonly topicLabel: string | null;
  readonly usageReservationId: string | null;
}

interface ContextSummarySegment {
  readonly originalSourceIds: readonly string[];
  readonly result: ContextSummaryResult;
}

interface ContextSummaryPlan {
  readonly finalResult: ContextSummaryResult;
  readonly segments: readonly ContextSummarySegment[];
  readonly suppliedSourceIds: readonly string[];
  readonly topicProposals: ContextSummaryResult['topicProposals'];
  readonly visibleInputTokens: number;
  readonly visibleOutputTokens: number;
  readonly visibleUsageUsd: number;
}

interface SummaryNode {
  readonly leafIndexes: readonly number[];
  readonly result: ContextSummaryResult;
  readonly topicProposals: ContextSummaryResult['topicProposals'];
}

export class ChannelContextService {
  readonly #backfill: ContextBackfillService;
  readonly #budget: UsageBudget | undefined;
  readonly #channelId: string;
  readonly #conversation: ConversationStore;
  readonly #database: Database.Database;
  readonly #embed:
    | ((text: string) => Promise<{
        readonly embedding: Float32Array;
        readonly usageUsd: number;
      }>)
    | undefined;
  readonly #estimateUsd: number;
  readonly #guildId: string;
  readonly #memory: SqliteMemoryStore | undefined;
  readonly #maxSourceTokens: number;
  readonly #now: () => number;
  readonly #summarizer: ContextSummarizer | undefined;
  readonly #timeZone: string;
  readonly #uploadForgetJournal:
    ((entry: ContextForgetJournalEntry) => Promise<void>) | undefined;

  public constructor(options: ChannelContextServiceOptions) {
    this.#budget = options.budget;
    this.#channelId = options.channelId;
    this.#conversation = options.conversation;
    this.#database = options.database;
    this.#embed = options.embed;
    this.#estimateUsd = contextCallReservationUsd(
      options.backfillPricing ?? {
        embeddingInputPerMillionUsd: 0,
        summaryInputPerMillionUsd: 0,
        summaryOutputPerMillionUsd: 0,
      },
      options.estimateUsd ?? 0.05,
    );
    this.#guildId = options.guildId;
    this.#memory = options.memory;
    this.#maxSourceTokens = options.maxSourceTokens ?? 8_000;
    if (
      !Number.isSafeInteger(this.#maxSourceTokens) ||
      this.#maxSourceTokens <= 0
    ) {
      throw new RangeError(
        'maximum context source tokens must be a positive integer',
      );
    }
    this.#now = options.now ?? Date.now;
    this.#summarizer = options.summarizer;
    this.#timeZone = options.timeZone;
    this.#uploadForgetJournal = options.uploadForgetJournal;
    this.#backfill = new ContextBackfillService({
      applySource: (source, backfillRunId) =>
        this.#applyFromBackfill(
          {
            attachmentMetadataJson: source.attachmentMetadataJson,
            canModerateContext: source.canModerateContext,
            content: source.content,
            editedAt: source.editedAt,
            memoryExtraction:
              source.authorKind === 'human' ? 'automatic' : 'none',
            messageId: source.messageId,
            occurredAt: source.occurredAt,
            platformEventId: source.messageId,
            replyToMessageId: source.replyToMessageId,
            requestId: source.messageId,
            revisionChecksum: source.revisionChecksum,
            role: source.authorKind === 'chief' ? 'chief' : 'human',
            speakerId: source.requesterId,
            speakerName: source.speakerName,
            type: 'upsert',
          },
          backfillRunId,
        ),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      channelId: options.channelId,
      database: options.database,
      ...(options.embed === undefined ? {} : { embed: options.embed }),
      ...(options.estimateUsd === undefined
        ? {}
        : { estimateUsd: options.estimateUsd }),
      guildId: options.guildId,
      ...(options.maxSourceTokens === undefined
        ? {}
        : { maxSourceTokens: options.maxSourceTokens }),
      ...(options.now === undefined ? {} : { now: options.now }),
      pricing: options.backfillPricing ?? {
        embeddingInputPerMillionUsd: 0,
        summaryInputPerMillionUsd: 0,
        summaryOutputPerMillionUsd: 0,
      },
      ...(options.summarizer === undefined
        ? {}
        : { summarizer: options.summarizer }),
      timeZone: options.timeZone,
    });
  }

  public attachHistorySource(history: DiscordHistorySource): void {
    this.#backfill.attachHistorySource(history);
  }

  public apply(change: ContextSourceChange): ContextApplyResult {
    return this.#database.transaction(() =>
      change.type === 'upsert'
        ? this.#applyUpsert(change)
        : this.#applySuppression(change),
    )();
  }

  public async applyAuthoritativeSuppression(
    change: ContextSourceSuppression,
  ): Promise<ContextApplyResult> {
    const deletion = new ContextDeletionStore({
      channelId: this.#channelId,
      database: this.#database,
      guildId: this.#guildId,
      memory: this.#memory,
      timeZone: this.#timeZone,
    });
    const prepared = deletion.prepareAuthoritativeSourceJournal({
      now: change.deletedAt,
      reason: change.reason,
      sourceScopeId: this.#sourceScopeId(change.messageId),
    });
    if (!prepared.uploaded) {
      if (this.#uploadForgetJournal === undefined) {
        throw new Error('forget journal uploader is unavailable');
      }
      await this.#uploadForgetJournal(prepared.entry);
    }
    const result = this.#database.transaction(() =>
      this.#suppress(change, deletion, prepared.entry),
    )();
    return { eventId: result.eventId, status: 'suppressed' };
  }

  #applyFromBackfill(
    change: ContextSourceUpsert,
    backfillRunId: number,
  ): ContextApplyResult {
    return this.#database.transaction(() =>
      this.#applyUpsert(change, null, backfillRunId),
    )();
  }

  public hasSource(messageId: string): boolean {
    return this.#eventId(messageId) !== null;
  }

  public async forget(
    request: ContextForgetRequest,
  ): Promise<ContextForgetReceipt> {
    const memory = this.#memory;
    if (memory === undefined) {
      return { status: 'clarification-required' };
    }
    const deletion = new ContextDeletionStore({
      channelId: this.#channelId,
      database: this.#database,
      guildId: this.#guildId,
      memory,
      timeZone: this.#timeZone,
    });
    if (request.confirmationNonce !== undefined) {
      const confirmation = deletion.confirmation({
        confirmationChecksum: digest(request.confirmationNonce),
        now: request.now,
        requesterId: request.requesterId,
      });
      if (confirmation.status === 'expired') {
        return { status: 'confirmation-expired' };
      }
      if (confirmation.status === 'invalid') {
        return { status: 'confirmation-invalid' };
      }
      if (
        !deletion.requesterCanDelete(
          confirmation.candidates,
          request.requesterId,
          request.canModerateContext,
        )
      ) {
        return { status: 'unauthorized' };
      }
      return this.#finishForget(
        deletion,
        deletion.delete({
          candidates: confirmation.candidates,
          confirmationRequestId: confirmation.requestId,
          now: request.now,
          requestSourceScopeIds: [confirmation.requestSourceScopeId],
        }),
        request.now,
      );
    }
    const target = extractForgetTarget(request.content);
    if (target === null) return { status: 'clarification-required' };
    const excludedScopeId = this.#sourceScopeId(request.requestMessageId);
    const candidates =
      target.scope === 'member'
        ? deletion.discoverMember(target.target, excludedScopeId)
        : deletion.discover(target.target, excludedScopeId);
    if (!candidates.complete) {
      return {
        status:
          request.canModerateContext || !target.broad
            ? 'clarification-required'
            : 'unauthorized',
      };
    }
    if (
      candidates.sourceScopeIds.length === 0 &&
      candidates.documentKeys.length === 0 &&
      candidates.memoryIds.length === 0
    ) {
      return {
        status:
          (target.scope === 'member' || target.broad) &&
          !request.canModerateContext
            ? 'unauthorized'
            : 'clarification-required',
      };
    }
    if (
      !deletion.requesterCanDelete(
        candidates,
        request.requesterId,
        request.canModerateContext,
      )
    ) {
      return {
        status: target.broad ? 'unauthorized' : 'clarification-required',
      };
    }
    const narrowSelfSource = deletion.isNarrowSelfSource(
      candidates,
      request.requesterId,
    );
    if (
      !narrowSelfSource &&
      !target.broad &&
      candidates.sourceScopeIds.length !== 1
    ) {
      return { status: 'clarification-required' };
    }
    if (target.broad || !narrowSelfSource) {
      const confirmationNonce = randomBytes(12).toString('hex');
      deletion.createConfirmation({
        candidates,
        confirmationChecksum: digest(confirmationNonce),
        now: request.now,
        requestSourceScopeId: excludedScopeId,
        requesterId: request.requesterId,
        scopeType:
          target.scope === 'member'
            ? 'member'
            : target.broad
              ? 'topic'
              : 'source',
      });
      return {
        confirmationNonce,
        documentCount: candidates.documentKeys.length,
        memoryCount: candidates.memoryIds.length,
        sourceCount: candidates.sourceScopeIds.length,
        status: 'confirmation-required',
      };
    }
    const result = deletion.delete({
      candidates,
      now: request.now,
      requestSourceScopeIds: [excludedScopeId],
    });
    return this.#finishForget(deletion, result, request.now);
  }

  async #finishForget(
    deletion: ContextDeletionStore,
    result: ReturnType<ContextDeletionStore['delete']>,
    now: number,
  ): Promise<ContextForgetReceipt> {
    try {
      if (this.#uploadForgetJournal === undefined) {
        throw new Error('forget journal uploader is unavailable');
      }
      await this.#uploadForgetJournal(result.journal);
      deletion.markJournalUploaded(result.journalId, now);
      return {
        documentCount: result.documentCount,
        memoryCount: result.memoryCount,
        sourceCount: result.sourceCount,
        status: 'forgotten',
      };
    } catch {
      deletion.markJournalFailed(result.journalId, now);
      return {
        documentCount: result.documentCount,
        memoryCount: result.memoryCount,
        sourceCount: result.sourceCount,
        status: 'journal-pending',
      };
    }
  }

  public async flushForgetJournal(
    now: number,
  ): Promise<{ readonly status: 'failed' | 'idle' | 'uploaded' }> {
    const memory = this.#memory;
    if (memory === undefined) return { status: 'idle' };
    const deletion = new ContextDeletionStore({
      channelId: this.#channelId,
      database: this.#database,
      guildId: this.#guildId,
      memory,
      timeZone: this.#timeZone,
    });
    const pending = deletion.nextForgetJournal(now);
    if (pending === null) return { status: 'idle' };
    try {
      if (this.#uploadForgetJournal === undefined) {
        throw new Error('forget journal uploader is unavailable');
      }
      await this.#uploadForgetJournal(pending.entry);
      deletion.markJournalUploaded(pending.id, now);
      return { status: 'uploaded' };
    } catch {
      deletion.markJournalFailed(pending.id, now);
      return { status: 'failed' };
    }
  }

  public replayForgetJournal(
    entry: ContextForgetJournalEntry,
    now: number,
  ): void {
    const memory = this.#memory;
    if (memory === undefined) {
      throw new Error('context forget replay requires durable memory storage');
    }
    new ContextDeletionStore({
      channelId: this.#channelId,
      database: this.#database,
      guildId: this.#guildId,
      memory,
      timeZone: this.#timeZone,
    }).replayForgetJournal(entry, now);
  }

  public recordDeliveredReply(input: DeliveredReplyInput): void {
    if (
      input.chunks.length === 0 ||
      input.chunks.some(({ messageId }) => !/^\d{17,20}$/u.test(messageId))
    ) {
      throw new Error('delivered replies require Discord message snowflakes');
    }
    this.#database.transaction(() => {
      const existingOccurredAt = queries
        .channelContextRecordDeliveredReplySelectConversationEvents(
          this.#database,
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
          queries
            .channelContextRecordDeliveredReplyUpdateConversationEvents(
              this.#database,
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
      const expiringIds = queries
        .channelContextMaintainSelectConversationEvents(this.#database)
        .pluck()
        .all(now);
      const result = this.#conversation.maintain(now);
      for (const eventId of expiringIds) {
        this.#invalidateEventJobs(eventId, true);
      }
      const expiringDocumentIds = queries
        .channelContextMaintainSelectContextDocuments(this.#database)
        .pluck()
        .all(now);
      const deleteFts = this.#database.prepare(
        readSqliteStatement('context/deleteContextDocumentFts'),
      );
      const deleteVector = this.#database.prepare(
        readSqliteStatement('context/deleteContextDocumentVector'),
      );
      for (const documentId of expiringDocumentIds) {
        deleteFts.run(documentId);
        deleteVector.run(BigInt(documentId));
      }
      if (expiringDocumentIds.length > 0) {
        const placeholders = expiringDocumentIds.map(() => '?').join(', ');
        this.#database
          .prepare(
            readSqliteStatement(
              'context/channelContextServiceMaintainUpdateContextDocuments',
              [placeholders],
            ),
          )
          .run(now, ...expiringDocumentIds);
      }
      queries
        .channelContextMaintainDeleteContextDeletionRequests(this.#database)
        .run(now);
      return result;
    })();
  }

  public nextDeadline(
    now: number,
    lane: 'live' | 'backfill' = 'live',
  ): number | null {
    if (lane === 'backfill') return this.#backfill.nextDeadline();
    return (
      (queries
        .channelContextNextDeadlineSelectContextJobs(this.#database)
        .pluck()
        .get(now, now) as number | null) ?? null
    );
  }

  public status(now: number): ContextStatus {
    const backfillRows = queries
      .channelContextStatusSelectContextBackfills(this.#database)
      .all() as { readonly count: number; readonly status: string }[];
    const backfillCounts = { active: 0, failed: 0, paused: 0 };
    for (const row of backfillRows) {
      if (row.status in backfillCounts) {
        backfillCounts[row.status as keyof typeof backfillCounts] = row.count;
      }
    }
    const pendingJobs = Number(
      queries
        .channelContextStatusSelectContextJobs(this.#database)
        .pluck()
        .get(),
    );
    const failedJobs = Number(
      queries
        .channelContextStatusSelectContextJobs2(this.#database)
        .pluck()
        .get(),
    );
    const accountingHeld =
      queries
        .channelContextStatusSelectContextAccountingHolds(this.#database)
        .pluck()
        .get() === 1;
    const lagMsByTier = Object.fromEntries(
      (['hourly', 'daily', 'weekly', 'long-term'] as const).map((tier) => {
        const deadline = queries
          .channelContextStatusSelectContextJobs3(this.#database)
          .pluck()
          .get(tier, now) as number | null;
        return [tier, deadline === null ? 0 : Math.max(0, now - deadline)];
      }),
    ) as Record<ContextTier, number>;
    const overdue = queries
      .channelContextStatusSelectContextJobs4(this.#database)
      .get(now) as { readonly error: string | null } | undefined;
    const journalPending =
      queries
        .channelContextStatusSelectContextForgetJournal(this.#database)
        .pluck()
        .get() === 1;
    const reason = journalPending
      ? 'forget-journal'
      : accountingHeld
        ? 'migration-accounting-ambiguous'
        : contextLagReason(
            overdue?.error,
            this.#summarizer !== undefined && this.#embed !== undefined,
          );
    return {
      backfillCounts,
      degraded:
        journalPending ||
        accountingHeld ||
        overdue !== undefined ||
        failedJobs > 0,
      failedJobs,
      lagMsByTier,
      pendingJobs,
      reason,
    };
  }

  public runNext(now: number): Promise<ContextJobResult>;
  public runNext(
    now: number,
    lane: 'backfill',
  ): Promise<ContextBackfillWorkResult>;
  public async runNext(
    now: number,
    lane: 'live' | 'backfill' = 'live',
  ): Promise<ContextJobResult | ContextBackfillWorkResult> {
    if (lane === 'backfill') return this.#backfill.runNext(now);
    const job = this.#leaseNextJob(now);
    if (job === null) return { status: 'idle' };
    const budget = this.#budget;
    const summarizer = this.#summarizer;
    const embed = this.#embed;
    if (budget !== undefined && job.usageReservationId !== null) {
      try {
        budget.reconcileConservatively(job.usageReservationId);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'unknown usage reservation'
        ) {
          throw error;
        }
      }
      queries
        .channelContextRunNextUpdateContextJobs(this.#database)
        .run(job.id);
    }
    if (this.#provisionalObsolete(job, now)) {
      this.#completeEmptyJob(job.id);
      return { status: 'idle' };
    }
    if (
      budget === undefined ||
      summarizer === undefined ||
      embed === undefined
    ) {
      this.#retryJob(job, now + retryDelay(job.attemptCount), 'provider');
      return job.attemptCount >= DEFAULT_MAX_ATTEMPTS
        ? { status: 'failed' }
        : { notBefore: now + retryDelay(job.attemptCount), status: 'retry' };
    }

    const sources = this.#jobSources(job);
    if (sources.length === 0) {
      this.#completeEmptyJob(job.id);
      return { status: 'idle' };
    }
    const sourceGroups = segmentSources(sources, this.#maxSourceTokens);
    const estimatedCalls =
      sourceGroups.length === 1 ? 1 : sourceGroups.length * 2 + 1;
    const reservation = budget.reserve(
      'context-rollup',
      this.#estimateUsd * estimatedCalls,
      {
        ...(job.backfillRunId === null
          ? {}
          : { backfillRunId: job.backfillRunId }),
        priority: 'background',
        workCategory: 'indexing',
      },
    );
    if (!reservation.allowed) {
      const reason = contextBudgetReason(reservation.reason);
      const notBefore =
        reservation.reason === 'interactive-headroom'
          ? now + 5_000
          : nextUtcMonth(now);
      this.#deferJob(job.id, notBefore, reason);
      if (job.backfillRunId !== null) {
        this.#pauseBackfillRun(job.backfillRunId, reason, now);
      }
      return { notBefore, reason, status: 'budget-deferred' };
    }
    queries
      .channelContextRunNextUpdateContextJobs2(this.#database)
      .run(reservation.id, job.id);

    try {
      const plan = await this.#summarizeSources(job, sourceGroups, summarizer);
      const embedded = await embed(plan.finalResult.summary);
      const usageUsd =
        plan.segments.reduce(
          (total, segment) => total + segment.result.usageUsd,
          0,
        ) +
        plan.visibleUsageUsd +
        embedded.usageUsd;
      if (usageUsd > reservation.reservedUsd) {
        budget.reconcileConservatively(reservation.id);
        queries
          .channelContextRunNextUpdateContextJobs3(this.#database)
          .run(job.id, reservation.id);
        this.#deferJob(
          job.id,
          now + retryDelay(job.attemptCount),
          'usage-contract',
        );
        if (job.backfillRunId !== null) {
          this.#pauseBackfillRun(job.backfillRunId, 'usage-contract', now);
        }
        return {
          notBefore: now + retryDelay(job.attemptCount),
          reason: 'usage-contract',
          status: 'budget-deferred',
        };
      }
      let documentId = 0;
      const commit = this.#database.transaction((): boolean => {
        const commitNow = this.#now();
        this.#assertCurrentLease(job, reservation.id, commitNow);
        if (this.#provisionalObsolete(job, commitNow)) {
          this.#completeEmptyJob(job.id);
          return true;
        }
        const documentKey = job.jobKey.replace(/:(?:final|provisional)$/u, '');
        const revision =
          ((queries
            .channelContextRunNextSelectContextDocuments(this.#database)
            .pluck()
            .get(documentKey) as number | null) ?? 0) + 1;
        const previousDocumentIds = queries
          .channelContextRunNextSelectContextDocuments2(this.#database)
          .pluck()
          .all(documentKey);
        this.#suppressDocumentDescendants(
          previousDocumentIds,
          'retention-expired',
          now,
        );
        const store = new ContextStore(this.#database);
        const internalIds = plan.segments.map((segment, index) => {
          const lineage = parseSourceLineage(segment.originalSourceIds);
          const segmentKey = `${documentKey}:segment:${String(index)}`;
          const segmentRevision =
            ((queries
              .channelContextRunNextSelectContextDocuments3(this.#database)
              .pluck()
              .get(segmentKey) as number | null) ?? 0) + 1;
          return store.activateDocumentRevision({
            completeness: job.completeness,
            confidence: segment.result.confidence,
            createdAt: now,
            documentKey: segmentKey,
            embedding: new Float32Array(),
            eventIds: lineage.eventIds,
            generationInputTokens: segment.result.inputTokens,
            generationOutputTokens: segment.result.outputTokens,
            generationUsageUsd: segment.result.usageUsd,
            isInternal: true,
            parentDocumentIds: lineage.parentDocumentIds,
            periodEnd: job.periodEnd,
            periodStart: job.periodStart,
            retentionDeadline: retentionDeadline(job.tier, job.periodEnd),
            revision: segmentRevision,
            sourceRevisionChecksum: job.sourceRevisionChecksum,
            summary: segment.result.summary,
            tier: job.tier,
            timeZone: job.timeZone,
            topicKey: job.topicKey,
            topicLabel: job.topicLabel,
          });
        });
        const directLineage = parseSourceLineage(plan.suppliedSourceIds);
        documentId = store.activateDocumentRevision({
          completeness: job.completeness,
          confidence: plan.finalResult.confidence,
          createdAt: now,
          documentKey,
          embedding: embedded.embedding,
          eventIds: internalIds.length === 0 ? directLineage.eventIds : [],
          generationInputTokens: plan.visibleInputTokens,
          generationOutputTokens: plan.visibleOutputTokens,
          generationUsageUsd: plan.visibleUsageUsd + embedded.usageUsd,
          parentDocumentIds:
            internalIds.length === 0
              ? directLineage.parentDocumentIds
              : internalIds,
          periodEnd: job.periodEnd,
          periodStart: job.periodStart,
          retentionDeadline: retentionDeadline(job.tier, job.periodEnd),
          revision,
          sourceRevisionChecksum: job.sourceRevisionChecksum,
          summary: plan.finalResult.summary,
          tier: job.tier,
          timeZone: job.timeZone,
          topicKey: job.topicKey,
          topicLabel: job.topicLabel,
        });
        queries
          .channelContextRunNextUpdateContextJobs4(this.#database)
          .run(job.id);
        if (job.completeness === 'final') {
          this.#scheduleDownstream(
            job,
            documentId,
            plan.topicProposals,
            plan.finalResult.summary,
            now,
          );
        }
        return false;
      });
      const obsolete = budget.reconcileWith(reservation.id, usageUsd, commit);
      if (obsolete) return { status: 'idle' };
      return {
        completeness: job.completeness,
        documentId,
        status: 'completed',
        tier: job.tier,
      };
    } catch {
      budget.reconcileConservatively(reservation.id);
      queries
        .channelContextRunNextUpdateContextJobs5(this.#database)
        .run(job.id, reservation.id);
      const notBefore = now + retryDelay(job.attemptCount);
      const status = this.#retryJob(job, notBefore, 'provider');
      return status === 'failed' ? { status } : { notBefore, status: 'retry' };
    }
  }

  async #summarizeSources(
    job: ContextJobRow,
    sourceGroups: readonly (readonly ContextSummarySource[])[],
    summarizer: ContextSummarizer,
  ): Promise<ContextSummaryPlan> {
    if (sourceGroups.length === 1) {
      const finalResult = await summarizeStrict(
        summarizer,
        job,
        sourceGroups[0] ?? [],
      );
      return {
        finalResult,
        segments: [],
        suppliedSourceIds: [
          ...new Set(sourceGroups[0]?.map(({ id }) => sourceBaseId(id)) ?? []),
        ],
        topicProposals: finalResult.topicProposals.map((proposal) => ({
          ...proposal,
          sourceIds: [...new Set(proposal.sourceIds.map(sourceBaseId))],
        })),
        visibleInputTokens: finalResult.inputTokens,
        visibleOutputTokens: finalResult.outputTokens,
        visibleUsageUsd: finalResult.usageUsd,
      };
    }

    const segments: ContextSummarySegment[] = [];
    let nodes: SummaryNode[] = [];
    for (const group of sourceGroups) {
      const result = await summarizeStrict(summarizer, job, group);
      const originalSourceIds = [
        ...new Set(group.map(({ id }) => sourceBaseId(id))),
      ];
      const leafIndex = segments.length;
      segments.push({ originalSourceIds, result });
      nodes.push({ leafIndexes: [leafIndex], result, topicProposals: [] });
    }

    let visibleInputTokens = 0;
    let visibleOutputTokens = 0;
    let visibleUsageUsd = 0;
    for (let round = 0; round < 12; round += 1) {
      const aggregateSources = nodes.map((node, index) => ({
        id: `segment:${String(round)}:${String(index)}`,
        text: node.result.summary,
      }));
      const groups = segmentSources(aggregateSources, this.#maxSourceTokens);
      const nextNodes: SummaryNode[] = [];
      for (const group of groups) {
        const result = await summarizeStrict(summarizer, job, group);
        visibleInputTokens += result.inputTokens;
        visibleOutputTokens += result.outputTokens;
        visibleUsageUsd += result.usageUsd;
        const referencedLeafIndexes = (sourceIds: readonly string[]) => {
          const referenced = new Set(sourceIds.map(sourceBaseId));
          return [
            ...new Set(
              nodes.flatMap((node, index) =>
                referenced.has(`segment:${String(round)}:${String(index)}`)
                  ? node.leafIndexes
                  : [],
              ),
            ),
          ];
        };
        const leafIndexes = referencedLeafIndexes(result.sourceIds);
        nextNodes.push({
          leafIndexes,
          result,
          topicProposals: result.topicProposals.map((proposal) => ({
            label: proposal.label,
            sourceIds: [
              ...new Set(
                referencedLeafIndexes(proposal.sourceIds).flatMap(
                  (leafIndex) => segments[leafIndex]?.originalSourceIds ?? [],
                ),
              ),
            ],
          })),
        });
      }
      if (nextNodes.length === 1) {
        return {
          finalResult: nextNodes[0]?.result ?? failSummaryPlan(),
          segments,
          suppliedSourceIds: [
            ...new Set(
              sourceGroups.flatMap((group) =>
                group.map(({ id }) => sourceBaseId(id)),
              ),
            ),
          ],
          topicProposals: nextNodes[0]?.topicProposals ?? [],
          visibleInputTokens,
          visibleOutputTokens,
          visibleUsageUsd,
        };
      }
      nodes = nextNodes;
    }
    throw new Error('context segmentation did not converge');
  }

  #leaseNextJob(now: number): ContextJobRow | null {
    return this.#database.transaction(() => {
      const row = queries
        .channelContextLeaseNextJobSelectContextJobs(this.#database)
        .get(now, now) as ContextJobRow | undefined;
      if (row === undefined) return null;
      queries
        .channelContextLeaseNextJobUpdateContextJobs(this.#database)
        .run(now + DEFAULT_LEASE_MS, row.id);
      return { ...row, attemptCount: row.attemptCount + 1 };
    })();
  }

  #jobSources(job: ContextJobRow): ContextSummarySource[] {
    if (job.tier === 'hourly') {
      return queries
        .channelContextJobSourcesSelectConversationEvents(this.#database)
        .all(
          this.#guildId,
          this.#channelId,
          job.periodStart,
          job.periodEnd,
        ) as ContextSummarySource[];
    }
    const childTier =
      job.tier === 'daily' ? 'hourly' : job.tier === 'weekly' ? 'daily' : null;
    if (childTier !== null) {
      return queries
        .channelContextJobSourcesSelectContextDocuments(this.#database)
        .all(
          childTier,
          job.periodStart,
          job.periodEnd,
        ) as ContextSummarySource[];
    }
    const configuredIds = parseDocumentIds(job.sourceDocumentIdsJson);
    const activeTopicId = queries
      .channelContextJobSourcesSelectContextDocuments2(this.#database)
      .pluck()
      .get(job.topicKey);
    const ids = [
      ...new Set([
        ...configuredIds,
        ...(activeTopicId === undefined ? [] : [activeTopicId]),
      ]),
    ];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.#database
      .prepare(
        readSqliteStatement(
          'context/channelContextServiceJobSourcesSelectContextDocuments',
          [placeholders],
        ),
      )
      .all(...ids) as ContextSummarySource[];
  }

  #completeEmptyJob(jobId: number): void {
    queries
      .channelContextCompleteEmptyJobUpdateContextJobs(this.#database)
      .run(jobId);
  }

  #provisionalObsolete(job: ContextJobRow, now: number): boolean {
    if (job.completeness !== 'provisional') return false;
    if (job.periodEnd !== null && now >= job.periodEnd) return true;
    const documentKey = job.jobKey.replace(/:(?:final|provisional)$/u, '');
    return (
      queries
        .channelContextProvisionalObsoleteSelectContextDocuments(this.#database)
        .pluck()
        .get(documentKey) === 1
    );
  }

  #deferJob(jobId: number, notBefore: number, reason: string): void {
    queries
      .channelContextDeferJobUpdateContextJobs(this.#database)
      .run(notBefore, reason, jobId);
  }

  #retryJob(
    job: ContextJobRow,
    notBefore: number,
    errorCategory: string,
  ): 'failed' | 'pending' {
    const status =
      job.attemptCount >= DEFAULT_MAX_ATTEMPTS ? 'failed' : 'pending';
    const result = queries
      .channelContextRetryJobUpdateContextJobs(this.#database)
      .run(
        status,
        notBefore,
        errorCategory,
        job.id,
        job.sourceRevisionChecksum,
        job.attemptCount,
      );
    return result.changes === 1 ? status : 'failed';
  }

  #assertCurrentLease(
    job: ContextJobRow,
    reservationId: string,
    now: number,
  ): void {
    const current = queries
      .channelContextAssertCurrentLeaseSelectContextJobs(this.#database)
      .pluck()
      .get(
        job.id,
        now,
        job.attemptCount,
        job.sourceRevisionChecksum,
        reservationId,
      );
    if (current !== 1)
      throw new Error('context job lease is no longer current');
  }

  #scheduleDownstream(
    job: ContextJobRow,
    documentId: number,
    topicProposals: ContextSummaryResult['topicProposals'],
    summary: string,
    now: number,
  ): void {
    if (job.tier === 'hourly') {
      const period = contextPeriod({
        instant: job.periodStart,
        tier: 'daily',
        timeZone: this.#timeZone,
      });
      this.#upsertDerivedJob(
        period,
        'daily',
        this.#documentRevisionChecksum('hourly', period.start, period.end),
        period.end,
        period.end + FINAL_DAILY_DEADLINE_MS,
        job.backfillRunId,
      );
      return;
    }
    if (job.tier === 'daily') {
      const period = contextPeriod({
        instant: job.periodStart,
        tier: 'weekly',
        timeZone: this.#timeZone,
      });
      this.#upsertDerivedJob(
        period,
        'weekly',
        this.#documentRevisionChecksum('daily', period.start, period.end),
        period.end,
        period.end + FINAL_WEEKLY_DEADLINE_MS,
        job.backfillRunId,
      );
      for (const proposal of topicProposals) {
        const sourceDocumentIds = parseSourceLineage(
          proposal.sourceIds,
        ).parentDocumentIds;
        if (sourceDocumentIds.length === 0) continue;
        this.#upsertTopicJob(
          proposal.label,
          sourceDocumentIds,
          job.periodStart,
          now,
          undefined,
          job.backfillRunId,
        );
      }
      return;
    }
    if (job.tier === 'weekly') {
      const topics = queries
        .channelContextScheduleDownstreamSelectContextDocuments(this.#database)
        .all() as {
        readonly topicKey: string;
        readonly topicLabel: string;
      }[];
      for (const topic of topics) {
        if (
          !hasCompleteLexicalAnchor(
            extractLexicalTermSet(topic.topicLabel).relevance,
            summary,
          )
        ) {
          continue;
        }
        this.#upsertTopicJob(
          topic.topicLabel,
          [documentId],
          job.periodStart,
          now,
          topic.topicKey,
          job.backfillRunId,
        );
      }
    }
  }

  #documentRevisionChecksum(
    tier: ContextTier,
    periodStart: number,
    periodEnd: number,
  ): string {
    const rows = queries
      .channelContextDocumentRevisionChecksumSelectContextDocuments(
        this.#database,
      )
      .all(tier, periodStart, periodEnd);
    return digest(rows);
  }

  #upsertDerivedJob(
    period: ContextPeriod,
    tier: Exclude<ContextTier, 'hourly' | 'long-term'>,
    checksum: string,
    notBefore: number,
    freshnessDeadline: number,
    backfillRunId: number | null,
  ): void {
    queries
      .channelContextUpsertDerivedJobInsertContextJobs(this.#database)
      .run(
        `${period.key}:final`,
        tier,
        period.start,
        period.end,
        period.timeZone,
        checksum,
        notBefore,
        freshnessDeadline,
        backfillRunId,
      );
  }

  #upsertTopicJob(
    topicLabel: string,
    sourceDocumentIds: readonly number[],
    periodStart: number,
    now: number,
    existingTopicKey?: string,
    backfillRunId: number | null = null,
  ): void {
    const topicKey =
      existingTopicKey ??
      digest(topicLabel.trim().toLocaleLowerCase('en-US')).slice(0, 32);
    const activeTopicId = queries
      .channelContextUpsertTopicJobSelectContextDocuments(this.#database)
      .pluck()
      .get(topicKey);
    const allSourceIds = [
      ...new Set([
        ...sourceDocumentIds,
        ...(activeTopicId === undefined ? [] : [activeTopicId]),
      ]),
    ];
    const checksum = this.#documentIdsChecksum(allSourceIds);
    queries
      .channelContextUpsertTopicJobInsertContextJobs(this.#database)
      .run(
        `long-term:${this.#timeZone}:${topicKey}:final`,
        periodStart,
        this.#timeZone,
        topicKey,
        topicLabel,
        checksum,
        JSON.stringify(allSourceIds),
        now,
        now + LONG_TERM_DEADLINE_MS,
        backfillRunId,
      );
  }

  #documentIdsChecksum(documentIds: readonly number[]): string {
    if (documentIds.length === 0) return digest([]);
    const placeholders = documentIds.map(() => '?').join(', ');
    const rows = this.#database
      .prepare(
        readSqliteStatement('context/selectContextDocumentRevisions', [
          placeholders,
        ]),
      )
      .all(...documentIds);
    return digest(rows);
  }

  #applyUpsert(
    change: ContextSourceUpsert,
    logicalResponseId: string | null = null,
    backfillRunId: number | null = null,
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
    const canonical = queries
      .channelContextApplyUpsertSelectConversationEvents(this.#database)
      .get(eventId) as {
      content: string;
      contentState: string;
      occurredAt: number;
    };
    if (canonical.contentState !== 'available') {
      return { eventId, status: 'suppressed' };
    }

    this.#database
      .prepare(readSqliteStatement('conversation/deleteConversationEventFts'))
      .run(eventId);
    this.#database
      .prepare(readSqliteStatement('conversation/insertConversationEventFts'))
      .run(eventId, canonical.content);
    this.#scheduleHourlyJobs(canonical.occurredAt, backfillRunId);
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
    const result = this.#suppress(
      change,
      new ContextDeletionStore({
        channelId: this.#channelId,
        database: this.#database,
        guildId: this.#guildId,
        memory: this.#memory,
        timeZone: this.#timeZone,
      }),
    );
    return { eventId: result.eventId, status: 'suppressed' };
  }

  #suppress(
    change: ContextSourceSuppression,
    deletion: ContextDeletionStore,
    preuploadedJournal?: ContextForgetJournalEntry,
  ): ReturnType<ContextDeletionStore['suppressSource']> {
    const reason = change.reason;
    if (
      (change.type === 'delete' && reason !== 'discord-deleted') ||
      (change.type === 'forget' && reason !== 'locally-forgotten')
    ) {
      throw new Error('context suppression type and reason do not match');
    }
    return deletion.suppressSource({
      now: change.deletedAt,
      ...(preuploadedJournal === undefined ? {} : { preuploadedJournal }),
      reason,
      sourceScopeId: this.#sourceScopeId(change.messageId),
    });
  }

  #scheduleHourlyJobs(
    occurredAt: number,
    backfillRunId: number | null = null,
  ): void {
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone: this.#timeZone,
    });
    const checksum = this.#sourceRevisionChecksum(period);
    const now = this.#now();
    if (now < period.end) {
      this.#upsertJob(
        period,
        'provisional',
        checksum,
        now + PROVISIONAL_ELIGIBILITY_DELAY_MS,
        now + PROVISIONAL_DEADLINE_MS,
        backfillRunId,
      );
    }
    this.#upsertJob(
      period,
      'final',
      checksum,
      period.end,
      period.end + FINAL_HOURLY_DEADLINE_MS,
      backfillRunId,
    );
  }

  #upsertJob(
    period: ContextPeriod,
    completeness: 'final' | 'provisional',
    checksum: string,
    notBefore: number,
    freshnessDeadline: number,
    backfillRunId: number | null,
  ): void {
    queries
      .channelContextUpsertJobInsertContextJobs(this.#database)
      .run(
        `${period.key}:${completeness}`,
        period.start,
        period.end,
        period.timeZone,
        completeness,
        checksum,
        notBefore,
        freshnessDeadline,
        backfillRunId,
      );
  }

  #pauseBackfillRun(runId: number, reason: string, now: number): void {
    queries
      .channelContextPauseBackfillRunUpdateContextBackfills(this.#database)
      .run(reason, now, runId);
  }

  #sourceRevisionChecksum(period: ContextPeriod): string {
    const rows = queries
      .channelContextSourceRevisionChecksumSelectConversationEvents(
        this.#database,
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
        readSqliteStatement(
          'context/channelContextServiceSuppressDescendantsSelectContextDocumentEvents',
        ),
      )
      .pluck()
      .all(eventId) as number[];
    for (const documentId of documentIds) {
      this.#database
        .prepare(readSqliteStatement('context/deleteContextDocumentFts'))
        .run(documentId);
      this.#database
        .prepare(readSqliteStatement('context/deleteContextDocumentVector'))
        .run(BigInt(documentId));
    }
    if (documentIds.length === 0) return;
    const placeholders = documentIds.map(() => '?').join(', ');
    this.#database
      .prepare(
        readSqliteStatement('context/suppressContextDocuments', [placeholders]),
      )
      .run(reason, now, ...documentIds);
  }

  #suppressDocumentDescendants(
    parentDocumentIds: readonly number[],
    reason: ContextContentStateReason,
    now: number,
  ): void {
    if (parentDocumentIds.length === 0) return;
    const placeholders = parentDocumentIds.map(() => '?').join(', ');
    const documentIds = this.#database
      .prepare(
        readSqliteStatement(
          'context/channelContextServiceSuppressDocumentDescendantsSelectContextDocumentParents',
          [placeholders],
        ),
      )
      .pluck()
      .all(...parentDocumentIds) as number[];
    for (const documentId of documentIds) {
      this.#database
        .prepare(readSqliteStatement('context/deleteContextDocumentFts'))
        .run(documentId);
      this.#database
        .prepare(readSqliteStatement('context/deleteContextDocumentVector'))
        .run(BigInt(documentId));
    }
    if (documentIds.length === 0) return;
    const affectedPlaceholders = documentIds.map(() => '?').join(', ');
    this.#database
      .prepare(
        readSqliteStatement('context/suppressContextDocuments', [
          affectedPlaceholders,
        ]),
      )
      .run(reason, now, ...documentIds);
  }

  #invalidateEventJobs(eventId: number, pendingOnly = false): void {
    const occurredAt = queries
      .channelContextInvalidateEventJobsSelectConversationEvents(this.#database)
      .pluck()
      .get(eventId);
    if (occurredAt === undefined) return;
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone: this.#timeZone,
    });
    this.#database
      .prepare(
        readSqliteStatement(
          'context/channelContextServiceInvalidateEventJobsUpdateContextJobs',
          [
            pendingOnly
              ? readSqliteStatement('context/incompleteContextJobFilter')
              : '',
          ],
        ),
      )
      .run(period.timeZone, period.start, period.end);
  }

  #eventId(messageId: string): number | null {
    return (
      queries
        .channelContextEventIdSelectConversationEvents(this.#database)
        .pluck()
        .get(this.#guildId, this.#channelId, messageId) ?? null
    );
  }

  #existingRevision(messageId: string): ExistingSourceRevision | null {
    return (
      (queries
        .channelContextExistingRevisionSelectConversationEvents(this.#database)
        .get(this.#guildId, this.#channelId, messageId) as
        ExistingSourceRevision | undefined) ?? null
    );
  }

  #hasTombstone(scopeId: string): boolean {
    return hasSourceTombstone(this.#database, scopeId);
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

function assertSuppliedSourceIds(
  sourceIds: readonly string[],
  suppliedIds: ReadonlySet<string>,
): void {
  if (sourceIds.some((sourceId) => !suppliedIds.has(sourceId))) {
    throw new Error('context summary referenced an unknown source');
  }
}

async function summarizeStrict(
  summarizer: ContextSummarizer,
  job: ContextJobRow,
  sources: readonly ContextSummarySource[],
): Promise<ContextSummaryResult> {
  const suppliedIds = new Set(sources.map(({ id }) => id));
  const result = contextSummaryResultSchema.parse(
    await summarizer.summarize({
      completeness: job.completeness,
      sources,
      tier: job.tier,
      ...(job.topicLabel === null ? {} : { topicLabel: job.topicLabel }),
    }),
  );
  assertSuppliedSourceIds(result.sourceIds, suppliedIds);
  for (const proposal of result.topicProposals) {
    assertSuppliedSourceIds(proposal.sourceIds, suppliedIds);
  }
  return result;
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function segmentSources(
  sources: readonly ContextSummarySource[],
  maximumTokens: number,
): (readonly ContextSummarySource[])[] {
  const maximumCharacters = maximumTokens * 4;
  const pieces = sources.flatMap((source) => {
    if (approximateTokens(source.text) <= maximumTokens) return [source];
    const count = Math.ceil(source.text.length / maximumCharacters);
    return Array.from({ length: count }, (_, index) => ({
      id: `${source.id}#part:${String(index)}`,
      text: source.text.slice(
        index * maximumCharacters,
        (index + 1) * maximumCharacters,
      ),
    }));
  });
  const groups: ContextSummarySource[][] = [];
  let current: ContextSummarySource[] = [];
  let currentTokens = 0;
  for (const piece of pieces) {
    const tokens = approximateTokens(piece.text);
    if (current.length > 0 && currentTokens + tokens > maximumTokens) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(piece);
    currentTokens += tokens;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function sourceBaseId(sourceId: string): string {
  return sourceId.replace(/#part:\d+$/u, '');
}

function parseSourceLineage(sourceIds: readonly string[]): {
  readonly eventIds: readonly number[];
  readonly parentDocumentIds: readonly number[];
} {
  const eventIds = sourceIds
    .filter((id) => id.startsWith('event:'))
    .map((id) => Number(id.slice('event:'.length)));
  const parentDocumentIds = sourceIds
    .filter((id) => id.startsWith('document:'))
    .map((id) => Number(id.slice('document:'.length)));
  if (
    eventIds.some((id) => !Number.isSafeInteger(id)) ||
    parentDocumentIds.some((id) => !Number.isSafeInteger(id))
  ) {
    throw new Error('context summary referenced an unknown source');
  }
  return {
    eventIds: [...new Set(eventIds)],
    parentDocumentIds: [...new Set(parentDocumentIds)],
  };
}

function failSummaryPlan(): never {
  throw new Error('context segmentation produced no summary');
}

function contextBudgetReason(
  reason:
    'ceiling' | 'indexing-ceiling' | 'interactive-headroom' | 'run-ceiling',
):
  'indexing-budget' | 'interactive-headroom' | 'overall-budget' | 'run-budget' {
  switch (reason) {
    case 'indexing-ceiling':
      return 'indexing-budget';
    case 'interactive-headroom':
      return reason;
    case 'run-ceiling':
      return 'run-budget';
    case 'ceiling':
      return 'overall-budget';
  }
}

function contextLagReason(
  error: string | null | undefined,
  providerAvailable: boolean,
): ContextStatus['reason'] {
  if (!providerAvailable) return 'provider';
  switch (error) {
    case 'indexing-budget':
    case 'interactive-headroom':
    case 'migration-accounting-ambiguous':
    case 'overall-budget':
    case 'provider':
    case 'run-budget':
      return error;
    case null:
    case undefined:
      return 'backlog';
    default:
      return 'backlog';
  }
}

function nextUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function retryDelay(attemptCount: number): number {
  if (attemptCount >= DEFAULT_MAX_ATTEMPTS) return 24 * 60 * 60 * 1_000;

  return Math.min(3_600_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

function parseDocumentIds(value: string): number[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error('context job has invalid source document IDs');
  }
  return parsed as number[];
}

function extractForgetTarget(content: string): {
  readonly broad: boolean;
  readonly scope: 'member' | 'subject';
  readonly target: string;
} | null {
  const match = /\bforget\b\s+(?:that\s+)?([\s\S]+)/iu.exec(content);
  const target = match?.[1]?.replace(/[.!?]+$/u, '').trim();
  if (target === undefined || target.length === 0) return null;
  const member = /\b(?:messages?\s+)?(?:from|by)\s+([\s\S]+)$/iu.exec(
    target,
  )?.[1];
  if (member !== undefined) {
    return { broad: true, scope: 'member', target: member.trim() };
  }
  const broad = /\b(?:all|every|everything|topic|whole)\b/iu.test(target);
  const subject = target
    .replace(
      /^(?:(?:all|every)\s+(?:messages?|records?)|everything|the\s+whole\s+topic)\s+(?:about\s+)?/iu,
      '',
    )
    .replace(/^topic\s+(?:about\s+)?/iu, '')
    .trim();
  return { broad, scope: 'subject', target: subject };
}

function retentionDeadline(
  tier: ContextTier,
  periodEnd: number | null,
): number | null {
  if (periodEnd === null) return null;
  if (tier === 'hourly') return periodEnd + HOURLY_RETENTION_MS;
  if (tier === 'daily') return periodEnd + DAILY_RETENTION_MS;
  return null;
}
