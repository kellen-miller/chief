import type { UsageBudget } from '../usage/usage-budget.js';
import {
  type MemoryInput,
  type PreparedMemoryMutation,
  type SourceObservation,
  type SqliteMemoryStore,
} from './memory-store.js';

export type MemoryAction =
  'conflict' | 'create' | 'forget' | 'no-op' | 'supersede';

export interface MemoryProposal {
  readonly action: MemoryAction;
  readonly canonicalText: string;
  readonly confidence: number;
  readonly kind: string;
  readonly sensitivity: 'none' | 'sensitive';
  readonly targetMemoryId: number | null;
}

export interface ExtractionResult {
  readonly proposals: readonly MemoryProposal[];
  readonly usageUsd: number;
}

export interface EmbeddingResult {
  readonly embedding: Float32Array;
  readonly usageUsd: number;
}

export type ExplicitMemoryIntent = 'correct' | 'forget' | 'remember';

export type MemoryMutationReceipt =
  | {
      readonly status:
        'ambiguous' | 'budget-paused' | 'failed' | 'rejected-sensitive';
    }
  | {
      readonly memoryIds: readonly number[];
      readonly status: 'conflict' | 'created' | 'forgotten' | 'superseded';
    };

export type AutomaticMemoryResult =
  | { readonly status: 'completed' | 'failed' | 'idle' }
  | {
      readonly notBefore: number;
      readonly status: 'budget-deferred' | 'retry';
    };

export interface MemoryServiceOptions {
  readonly budget: UsageBudget;
  readonly embed: (text: string) => Promise<EmbeddingResult>;
  readonly estimateUsd: number;
  readonly extract: (source: {
    readonly candidateMemories: readonly {
      readonly canonicalText: string;
      readonly id: number;
    }[];
    readonly content: string;
    readonly explicitRemember: boolean;
  }) => Promise<ExtractionResult>;
  readonly leaseDurationMs?: number;
  readonly limit?: number;
  readonly maxAttempts?: number;
  readonly store: SqliteMemoryStore;
}

export class MemoryPersistenceError extends Error {
  public constructor(cause: unknown) {
    super('durable memory persistence failed', { cause });
    this.name = 'MemoryPersistenceError';
  }
}

export class MemoryService {
  readonly #options: MemoryServiceOptions;

  public constructor(options: MemoryServiceOptions) {
    this.#options = options;
  }

  public observeAutomatic(source: SourceObservation): number {
    return this.#options.store.observe(source);
  }

  public observeExplicit(source: SourceObservation): number {
    return this.#options.store.observeExplicit(source);
  }

  public async recall(prompt: string): Promise<{
    readonly memories: readonly string[];
    readonly usageUsd: number;
  }> {
    const embedded = await this.#options.embed(prompt);
    let memories;
    try {
      memories = this.#options.store.retrieve({
        embedding: embedded.embedding,
        limit: this.#options.limit ?? 6,
        now: Date.now(),
        text: prompt,
      });
    } catch (error) {
      throw new MemoryPersistenceError(error);
    }
    return {
      memories: memories.map((memory) => memory.canonicalText),
      usageUsd: embedded.usageUsd,
    };
  }

  public async applyExplicit(input: {
    readonly intent: ExplicitMemoryIntent;
    readonly now: number;
    readonly source: SourceObservation;
    readonly sourceEventId: number;
  }): Promise<MemoryMutationReceipt> {
    const reservation = this.#options.budget.reserve(
      'memory-extraction',
      this.#options.estimateUsd,
    );
    if (!reservation.allowed) return { status: 'budget-paused' };

    try {
      if (input.intent === 'forget') {
        const target = extractForgetTarget(input.source.content);
        const candidate =
          target === null
            ? undefined
            : this.#options.store.findLexical(target, 1)[0];
        const mutations: PreparedMemoryMutation[] =
          candidate === undefined
            ? []
            : [{ action: 'forget', targetMemoryId: candidate.id }];
        const applied = this.#options.store.applyPreparedMutationBatch({
          completedAt: input.now,
          mutations,
          sourceEventId: input.sourceEventId,
        });
        this.#options.budget.cancel(reservation.id);
        const memoryIds = applied.flatMap(({ memoryId }) =>
          memoryId === null ? [] : [memoryId],
        );
        return memoryIds.length === 0
          ? { status: 'ambiguous' }
          : { memoryIds, status: 'forgotten' };
      }

      const extraction = await this.#options.extract({
        candidateMemories: this.#options.store.findLexical(
          input.source.content,
          10,
        ),
        content: input.source.content,
        explicitRemember: true,
      });
      if (
        extraction.proposals.some(
          (proposal) => proposal.sensitivity === 'sensitive',
        )
      ) {
        this.#options.store.applyPreparedMutationBatch({
          completedAt: input.now,
          mutations: [],
          sourceEventId: input.sourceEventId,
        });
        this.#options.budget.reconcile(reservation.id, extraction.usageUsd);
        return { status: 'rejected-sensitive' };
      }

      const prepared = await this.#prepareMutations(
        extraction.proposals,
        input.source,
        input.sourceEventId,
        input.now,
        true,
      );
      const applied = this.#options.store.applyPreparedMutationBatch({
        completedAt: input.now,
        mutations: prepared.mutations,
        sourceEventId: input.sourceEventId,
      });
      this.#options.budget.reconcile(
        reservation.id,
        extraction.usageUsd + prepared.embeddingUsageUsd,
      );
      const memoryIds = applied.flatMap(({ memoryId }) =>
        memoryId === null ? [] : [memoryId],
      );
      if (memoryIds.length === 0) return { status: 'ambiguous' };
      if (applied.some(({ action }) => action === 'conflict')) {
        return { memoryIds, status: 'conflict' };
      }
      if (applied.some(({ action }) => action === 'supersede')) {
        return { memoryIds, status: 'superseded' };
      }
      if (applied.some(({ action }) => action === 'forget')) {
        return { memoryIds, status: 'forgotten' };
      }
      return { memoryIds, status: 'created' };
    } catch {
      this.#options.budget.reconcile(reservation.id, this.#options.estimateUsd);
      return { status: 'failed' };
    }
  }

  public async runAutomaticOne(now: number): Promise<AutomaticMemoryResult> {
    const job = this.#options.store.leaseNextJob(
      now,
      this.#options.leaseDurationMs ?? 60_000,
    );
    if (job === null) return { status: 'idle' };

    const reservation = this.#options.budget.reserve(
      'memory-extraction',
      this.#options.estimateUsd,
    );
    if (!reservation.allowed) {
      const notBefore = nextUtcMonth(now);
      this.#options.store.deferForBudget(job.id, notBefore);
      return { notBefore, status: 'budget-deferred' };
    }

    try {
      const source = this.#options.store.getJobSource(job.id);
      if (source === null) {
        this.#options.budget.cancel(reservation.id);
        this.#options.store.completeJob(job.id);
        return { status: 'completed' };
      }
      const forgetTarget = extractForgetTarget(source.content);
      if (forgetTarget !== null) {
        const candidate = this.#options.store.findLexical(forgetTarget, 1)[0];
        this.#options.store.applyPreparedMutationBatch({
          completedAt: now,
          jobId: job.id,
          mutations:
            candidate === undefined
              ? []
              : [{ action: 'forget', targetMemoryId: candidate.id }],
          sourceEventId: source.id,
        });
        this.#options.budget.cancel(reservation.id);
        return { status: 'completed' };
      }
      const extraction = await this.#options.extract({
        candidateMemories: this.#options.store.findLexical(source.content, 10),
        content: source.content,
        explicitRemember: false,
      });
      const prepared = await this.#prepareMutations(
        extraction.proposals,
        source,
        source.id,
        now,
        false,
      );
      this.#options.store.applyPreparedMutationBatch({
        completedAt: now,
        jobId: job.id,
        mutations: prepared.mutations,
        sourceEventId: source.id,
      });
      this.#options.budget.reconcile(
        reservation.id,
        extraction.usageUsd + prepared.embeddingUsageUsd,
      );
      return { status: 'completed' };
    } catch {
      this.#options.budget.reconcile(reservation.id, this.#options.estimateUsd);
      const notBefore = now + retryDelay(job.attemptCount);
      const status = this.#options.store.retryJob(
        job.id,
        notBefore,
        this.#options.maxAttempts ?? 5,
      );
      return status === 'failed' ? { status } : { notBefore, status: 'retry' };
    }
  }

  async #prepareMutations(
    proposals: readonly MemoryProposal[],
    source: Pick<
      SourceObservation,
      'occurredAt' | 'platformSourceId' | 'speakerId'
    >,
    sourceEventId: number,
    now: number,
    explicit: boolean,
  ): Promise<{
    readonly embeddingUsageUsd: number;
    readonly mutations: readonly PreparedMemoryMutation[];
  }> {
    const mutations: PreparedMemoryMutation[] = [];
    let embeddingUsageUsd = 0;
    for (const proposal of proposals) {
      if (!isAccepted(proposal, explicit)) continue;
      if (proposal.action === 'no-op') continue;
      if (proposal.action === 'forget') {
        if (proposal.targetMemoryId !== null) {
          mutations.push({
            action: 'forget',
            targetMemoryId: proposal.targetMemoryId,
          });
        }
        continue;
      }
      const embedded = await this.#options.embed(proposal.canonicalText);
      embeddingUsageUsd += embedded.usageUsd;
      const memory: MemoryInput = {
        canonicalText: proposal.canonicalText,
        confidence: proposal.confidence,
        embedding: embedded.embedding,
        kind: proposal.kind,
        provenance: {
          confidence: proposal.confidence,
          occurredAt: source.occurredAt,
          platformSourceId: source.platformSourceId,
          speakerId: source.speakerId,
          supersessionHistory: [],
        },
        sourceEventId,
        timestamp: now,
      };
      if (
        (proposal.action === 'conflict' || proposal.action === 'supersede') &&
        proposal.targetMemoryId !== null
      ) {
        mutations.push({
          action: proposal.action,
          memory,
          targetMemoryId: proposal.targetMemoryId,
        });
      } else {
        mutations.push({ action: 'create', memory });
      }
    }
    return { embeddingUsageUsd, mutations };
  }
}

export function detectExplicitMemoryIntent(
  content: string,
): ExplicitMemoryIntent | null {
  const match = explicitMemoryMatch(content);
  return (
    (match?.[1]?.toLowerCase() as ExplicitMemoryIntent | undefined) ?? null
  );
}

function isAccepted(proposal: MemoryProposal, explicit: boolean): boolean {
  if (proposal.sensitivity !== 'none') return false;
  if (proposal.action === 'no-op' || proposal.action === 'forget') return true;
  if (proposal.canonicalText.trim().length === 0) return false;
  return proposal.confidence >= (explicit ? 0.75 : 0.85);
}

function extractForgetTarget(content: string): string | null {
  const match = explicitMemoryMatch(content);
  if (match?.[1]?.toLowerCase() !== 'forget') return null;
  return match[2]?.replace(/^that\s+/iu, '') ?? null;
}

function explicitMemoryMatch(content: string): RegExpExecArray | null {
  return /\bchief\s*[,—:-]?\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:(?:please|kindly)\s+)?(remember|correct|forget)\b\s*(.*)/iu.exec(
    content,
  );
}

function nextUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function retryDelay(attemptCount: number): number {
  return Math.min(3_600_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}
