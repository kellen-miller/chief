import type { PaidWorkQueue } from './paid-work-queue.js';

export type LiveBackgroundKind = 'context' | 'memory';

export interface BackgroundWorkSource {
  nextDeadline(now: number): number | null;
  runOne(now: number): Promise<unknown>;
}

export interface BackgroundSchedulerOptions {
  readonly backfill?: BackgroundWorkSource;
  readonly context: BackgroundWorkSource;
  readonly memory: BackgroundWorkSource;
  readonly now?: () => number;
  readonly queue: PaidWorkQueue;
}

export type BackgroundSchedulerResult =
  | { readonly status: 'idle' }
  | {
      readonly kind: LiveBackgroundKind | 'backfill';
      readonly status: 'completed';
    };

export class BackgroundScheduler {
  readonly #options: BackgroundSchedulerOptions;
  #lastLiveKind: LiveBackgroundKind | undefined;

  public constructor(options: BackgroundSchedulerOptions) {
    this.#options = options;
  }

  public runBackgroundOne(now: number): Promise<BackgroundSchedulerResult> {
    return this.#options.queue.background(async () => {
      const current = this.#options.now?.() ?? now;
      const selected =
        this.#selectLive(current) ??
        this.#selectBackfill(this.#options.backfill, current);
      if (selected === null) return { status: 'idle' };
      await selected.source.runOne(current);
      return { kind: selected.kind, status: 'completed' };
    });
  }

  #selectBackfill(
    source: BackgroundWorkSource | undefined,
    now: number,
  ): {
    readonly kind: 'backfill';
    readonly source: BackgroundWorkSource;
  } | null {
    if (source === undefined) return null;
    const deadline = source.nextDeadline(now);
    return deadline !== null && deadline <= now
      ? { kind: 'backfill', source }
      : null;
  }

  #selectLive(now: number): {
    readonly kind: LiveBackgroundKind;
    readonly source: BackgroundWorkSource;
  } | null {
    const candidates = (
      [
        ['context', this.#options.context] as const,
        ['memory', this.#options.memory] as const,
      ] satisfies readonly (readonly [
        LiveBackgroundKind,
        BackgroundWorkSource,
      ])[]
    )
      .map(([kind, source]) => ({
        deadline: source.nextDeadline(now),
        kind,
        source,
      }))
      .filter(
        (candidate): candidate is typeof candidate & { deadline: number } =>
          candidate.deadline !== null,
      )
      .sort((left, right) => left.deadline - right.deadline);
    const first = candidates[0];
    const selected =
      first !== undefined &&
      candidates[1]?.deadline === first.deadline &&
      first.kind === this.#lastLiveKind
        ? candidates[1]
        : first;
    if (selected !== undefined) this.#lastLiveKind = selected.kind;
    return selected === undefined
      ? null
      : { kind: selected.kind, source: selected.source };
  }
}
