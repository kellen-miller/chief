import type { SqliteMemoryStore } from './memory-store.js';
import type { UsageBudget } from '../usage/usage-budget.js';

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

export interface MemoryWorkerOptions {
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
  readonly maxAttempts?: number;
  readonly store: SqliteMemoryStore;
}

export type MemoryWorkerResult =
  | { readonly status: 'completed' | 'failed' | 'idle' }
  | {
      readonly notBefore: number;
      readonly status: 'budget-deferred' | 'retry';
    };

export class MemoryWorker {
  readonly #options: MemoryWorkerOptions;

  public constructor(options: MemoryWorkerOptions) {
    this.#options = options;
  }

  public async runOne(now: number): Promise<MemoryWorkerResult> {
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
      const explicitRemember = /\bchief\s*[,—:-]?\s*remember\b/iu.test(
        source.content,
      );
      const forget = /\bchief\s*[,—:-]?\s*forget\s+(?:that\s+)?(.+)/iu.exec(
        source.content,
      );
      if (forget?.[1] !== undefined) {
        const candidate = this.#options.store.findLexical(forget[1], 1)[0];
        if (candidate !== undefined) this.#options.store.forget(candidate.id);
        this.#options.store.completeJob(job.id);
        this.#options.budget.cancel(reservation.id);
        return { status: 'completed' };
      }
      const candidateMemories = this.#options.store.findLexical(
        source.content,
        10,
      );
      const extraction = await this.#options.extract({
        candidateMemories,
        content: source.content,
        explicitRemember,
      });
      let usageUsd = extraction.usageUsd;
      for (const proposal of extraction.proposals) {
        if (!isAccepted(proposal, explicitRemember)) continue;
        if (proposal.action === 'forget') {
          if (proposal.targetMemoryId !== null) {
            this.#options.store.forget(proposal.targetMemoryId);
          }
          continue;
        }
        if (proposal.action === 'no-op') continue;

        const embedded = await this.#options.embed(proposal.canonicalText);
        usageUsd += embedded.usageUsd;
        const input = {
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
          sourceEventId: source.id,
          timestamp: now,
        };
        if (
          proposal.action === 'supersede' &&
          proposal.targetMemoryId !== null
        ) {
          this.#options.store.supersede(proposal.targetMemoryId, input);
        } else {
          const createdId = this.#options.store.applyMemory(input);
          if (
            proposal.action === 'conflict' &&
            proposal.targetMemoryId !== null
          ) {
            this.#options.store.recordConflict(
              proposal.targetMemoryId,
              createdId,
            );
          }
        }
      }
      this.#options.store.completeJob(job.id);
      this.#options.budget.reconcile(reservation.id, usageUsd);
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
}

function isAccepted(
  proposal: MemoryProposal,
  explicitRemember: boolean,
): boolean {
  if (proposal.sensitivity !== 'none') return false;
  if (proposal.action === 'no-op' || proposal.action === 'forget') return true;
  if (proposal.canonicalText.trim().length === 0) return false;
  return proposal.confidence >= (explicitRemember ? 0.75 : 0.85);
}

function nextUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function retryDelay(attemptCount: number): number {
  return Math.min(3_600_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}
