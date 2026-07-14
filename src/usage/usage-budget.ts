import { randomUUID } from 'node:crypto';

export interface UsageBudgetOptions {
  readonly backgroundHeadroomUsd?: number;
  readonly ceilingUsd: number;
  readonly indexingCeilingUsd?: number;
  readonly ledger?: UsageLedger;
  readonly now?: () => number;
  readonly onThreshold?: (
    event: 'ceiling' | 'warning',
    snapshot: UsageSnapshot,
  ) => void;
  readonly warningUsd: number;
}

export interface UsageLedgerEntry {
  readonly actualUsd: number | null;
  readonly backfillRunId?: number | null;
  readonly id: string;
  readonly occurredAt: number;
  readonly operation: string;
  readonly originBackfillRunId: number | null;
  readonly priority: UsagePriority;
  readonly reservationOrigin: UsageReservationOrigin;
  readonly reservationUsd: number;
  readonly workCategory: UsageWorkCategory;
}

export type UsagePriority = 'interactive' | 'background';
export type UsageReservationOrigin = 'ambiguous' | 'backfill' | 'live';
export type UsageWorkCategory = 'interaction' | 'memory' | 'indexing';

export interface UsageWork {
  readonly backfillRunId?: number;
  readonly priority: UsagePriority;
  readonly workCategory: UsageWorkCategory;
}

export interface UsageLedger {
  backfillRun(runId: number): {
    readonly actualUsd: number;
    readonly maximumUsd: number;
  } | null;
  cancel(id: string): void;
  list(start: number, end: number): UsageLedgerEntry[];
  listOutstanding(): UsageLedgerEntry[];
  reconcile(id: string, actualUsd: number, reconciledAt: number): void;
  record(entry: UsageLedgerEntry): void;
}

export type ReservationResult =
  | {
      readonly allowed: false;
      readonly reason:
        'ceiling' | 'indexing-ceiling' | 'interactive-headroom' | 'run-ceiling';
    }
  | {
      readonly allowed: true;
      readonly id: string;
      readonly reservedUsd: number;
    };

export interface UsageSnapshot {
  readonly actualUsd: number;
  readonly reservedUsd: number;
  readonly warningRaised: boolean;
}

export class UsageBudget {
  readonly #ledger: UsageLedger | undefined;
  readonly #now: () => number;
  readonly #options: UsageBudgetOptions;
  readonly #reservations = new Map<
    string,
    {
      readonly amountUsd: number;
      readonly backfillRunId: number | undefined;
      readonly occurredAt: number;
      readonly priority: UsagePriority;
      readonly workCategory: UsageWorkCategory;
    }
  >();
  readonly #actualByCategory = new Map<UsageWorkCategory, number>();
  #actualUsd = 0;
  #ceilingEmitted = false;
  #monthStart = 0;
  #warningEmitted = false;

  public constructor(options: UsageBudgetOptions) {
    if (options.warningUsd < 0 || options.ceilingUsd <= options.warningUsd) {
      throw new RangeError('usage thresholds must be positive and ordered');
    }
    if (
      options.indexingCeilingUsd !== undefined &&
      (options.indexingCeilingUsd <= 0 ||
        options.indexingCeilingUsd > options.ceilingUsd)
    ) {
      throw new RangeError(
        'indexing ceiling must be positive and no greater than overall ceiling',
      );
    }
    if (
      options.backgroundHeadroomUsd !== undefined &&
      (options.backgroundHeadroomUsd < 0 ||
        options.backgroundHeadroomUsd > options.ceilingUsd)
    ) {
      throw new RangeError(
        'background headroom must be non-negative and no greater than overall ceiling',
      );
    }
    this.#options = options;
    this.#ledger = options.ledger;
    this.#now = options.now ?? Date.now;
    this.#loadMonth(this.#now());
  }

  public reserve(
    kind: string,
    estimateUsd: number,
    work: UsageWork = {
      priority: 'interactive',
      workCategory: 'interaction',
    },
  ): ReservationResult {
    const now = this.#now();
    this.#refreshMonth(now);
    if (estimateUsd < 0 || !Number.isFinite(estimateUsd)) {
      throw new RangeError('reservation must be a finite non-negative amount');
    }
    if (
      this.#actualUsd + this.#reservedTotal() + estimateUsd >
      this.#options.ceilingUsd
    ) {
      return { allowed: false, reason: 'ceiling' };
    }
    const indexingCeiling =
      this.#options.indexingCeilingUsd ?? this.#options.ceilingUsd;
    if (
      work.workCategory === 'indexing' &&
      this.#categoryActual('indexing') +
        this.#reservedTotal('indexing') +
        estimateUsd >
        indexingCeiling
    ) {
      return { allowed: false, reason: 'indexing-ceiling' };
    }
    if (work.backfillRunId !== undefined) {
      const run = this.#ledger?.backfillRun(work.backfillRunId) ?? null;
      if (
        run === null ||
        run.actualUsd +
          this.#reservedRunTotal(work.backfillRunId) +
          estimateUsd >
          run.maximumUsd
      ) {
        return { allowed: false, reason: 'run-ceiling' };
      }
    }
    if (
      work.priority === 'background' &&
      this.#actualUsd +
        this.#reservedTotal() +
        estimateUsd +
        (this.#options.backgroundHeadroomUsd ?? 0) >
        this.#options.ceilingUsd
    ) {
      return { allowed: false, reason: 'interactive-headroom' };
    }

    const id = randomUUID();
    this.#reservations.set(id, {
      amountUsd: estimateUsd,
      backfillRunId: work.backfillRunId,
      occurredAt: now,
      ...work,
    });
    this.#ledger?.record({
      actualUsd: null,
      backfillRunId: work.backfillRunId ?? null,
      id,
      occurredAt: now,
      operation: kind,
      originBackfillRunId: work.backfillRunId ?? null,
      ...work,
      reservationOrigin: work.backfillRunId === undefined ? 'live' : 'backfill',
      reservationUsd: estimateUsd,
    });
    return { allowed: true, id, reservedUsd: estimateUsd };
  }

  public reconcile(reservationId: string, actualUsd: number): void {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      throw new Error('unknown usage reservation');
    }
    validateAmount(actualUsd, 'usage');
    const now = this.#now();
    this.#ledger?.reconcile(reservationId, actualUsd, now);
    this.#reservations.delete(reservationId);
    this.#refreshMonth(now);
    if (monthStart(reservation.occurredAt) === this.#monthStart) {
      this.#actualUsd += actualUsd;
      this.#actualByCategory.set(
        reservation.workCategory,
        this.#categoryActual(reservation.workCategory) + actualUsd,
      );
      this.#evaluateThresholds();
    }
  }

  public reconcileConservatively(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      throw new Error('unknown usage reservation');
    }
    this.reconcile(reservationId, reservation.amountUsd);
  }

  public cancel(reservationId: string): void {
    if (!this.#reservations.delete(reservationId)) {
      throw new Error('unknown usage reservation');
    }
    this.#ledger?.cancel(reservationId);
  }

  public recordActual(amountUsd: number): {
    readonly ceilingReached: boolean;
    readonly warningRaised: boolean;
  } {
    validateAmount(amountUsd, 'usage');
    const now = this.#now();
    this.#refreshMonth(now);
    this.#ledger?.record({
      actualUsd: amountUsd,
      backfillRunId: null,
      id: randomUUID(),
      occurredAt: now,
      operation: 'unreserved',
      originBackfillRunId: null,
      priority: 'interactive',
      reservationOrigin: 'live',
      reservationUsd: 0,
      workCategory: 'interaction',
    });
    this.#actualUsd += amountUsd;
    this.#actualByCategory.set(
      'interaction',
      this.#categoryActual('interaction') + amountUsd,
    );
    const { ceilingReached, warningRaised } = this.#evaluateThresholds();
    return {
      ceilingReached,
      warningRaised,
    };
  }

  public snapshot(): UsageSnapshot {
    this.#refreshMonth(this.#now());
    return {
      actualUsd: this.#actualUsd,
      reservedUsd: this.#reservedTotal(),
      warningRaised: this.#warningEmitted,
    };
  }

  public canAfford(estimateUsd: number): boolean {
    validateAmount(estimateUsd, 'reservation');
    this.#refreshMonth(this.#now());
    return (
      this.#actualUsd + this.#reservedTotal() + estimateUsd <=
      this.#options.ceilingUsd
    );
  }

  #reservedTotal(category?: UsageWorkCategory): number {
    let total = 0;
    for (const value of this.#reservations.values()) {
      if (
        monthStart(value.occurredAt) === this.#monthStart &&
        (category === undefined || value.workCategory === category)
      ) {
        total += value.amountUsd;
      }
    }
    return total;
  }

  #categoryActual(category: UsageWorkCategory): number {
    return this.#actualByCategory.get(category) ?? 0;
  }

  #reservedRunTotal(runId: number): number {
    let total = 0;
    for (const reservation of this.#reservations.values()) {
      if (reservation.backfillRunId === runId) total += reservation.amountUsd;
    }
    return total;
  }

  #loadMonth(now: number): void {
    this.#monthStart = monthStart(now);
    this.#actualUsd = 0;
    this.#actualByCategory.clear();
    this.#reservations.clear();
    for (const entry of this.#ledger?.list(
      this.#monthStart,
      nextMonth(this.#monthStart),
    ) ?? []) {
      if (entry.actualUsd === null) {
        this.#reservations.set(entry.id, {
          amountUsd: entry.reservationUsd,
          backfillRunId: entry.backfillRunId ?? undefined,
          occurredAt: entry.occurredAt,
          priority: entry.priority,
          workCategory: entry.workCategory,
        });
      } else {
        this.#actualUsd += entry.actualUsd;
        this.#actualByCategory.set(
          entry.workCategory,
          this.#categoryActual(entry.workCategory) + entry.actualUsd,
        );
      }
    }
    for (const entry of this.#ledger?.listOutstanding() ?? []) {
      if (this.#reservations.has(entry.id)) continue;
      this.#reservations.set(entry.id, {
        amountUsd: entry.reservationUsd,
        backfillRunId: entry.backfillRunId ?? undefined,
        occurredAt: entry.occurredAt,
        priority: entry.priority,
        workCategory: entry.workCategory,
      });
    }
    this.#warningEmitted = this.#actualUsd >= this.#options.warningUsd;
    this.#ceilingEmitted = this.#actualUsd >= this.#options.ceilingUsd;
  }

  #evaluateThresholds(): {
    readonly ceilingReached: boolean;
    readonly warningRaised: boolean;
  } {
    const warningRaised =
      !this.#warningEmitted && this.#actualUsd >= this.#options.warningUsd;
    if (warningRaised) {
      this.#warningEmitted = true;
      this.#options.onThreshold?.('warning', this.snapshot());
    }
    const ceilingReached = this.#actualUsd >= this.#options.ceilingUsd;
    if (ceilingReached && !this.#ceilingEmitted) {
      this.#ceilingEmitted = true;
      this.#options.onThreshold?.('ceiling', this.snapshot());
    }
    return { ceilingReached, warningRaised };
  }

  #refreshMonth(now: number): void {
    if (monthStart(now) !== this.#monthStart) this.#loadMonth(now);
  }
}

function monthStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function validateAmount(amountUsd: number, label: string): void {
  if (amountUsd < 0 || !Number.isFinite(amountUsd)) {
    throw new RangeError(`${label} must be a finite non-negative amount`);
  }
}
