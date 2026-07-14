import { randomUUID } from 'node:crypto';

export interface UsageBudgetOptions {
  readonly ceilingUsd: number;
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
  readonly id: string;
  readonly occurredAt: number;
  readonly operation: string;
  readonly priority: UsagePriority;
  readonly reservationUsd: number;
  readonly workCategory: UsageWorkCategory;
}

export type UsagePriority = 'interactive' | 'background';
export type UsageWorkCategory = 'interaction' | 'memory' | 'indexing';

export interface UsageWork {
  readonly priority: UsagePriority;
  readonly workCategory: UsageWorkCategory;
}

export interface UsageLedger {
  cancel(id: string): void;
  list(start: number, end: number): UsageLedgerEntry[];
  reconcile(id: string, actualUsd: number, reconciledAt: number): void;
  record(entry: UsageLedgerEntry): void;
}

export type ReservationResult =
  | { readonly allowed: false; readonly reason: 'ceiling' }
  | { readonly allowed: true; readonly id: string };

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
      readonly occurredAt: number;
      readonly priority: UsagePriority;
      readonly workCategory: UsageWorkCategory;
    }
  >();
  #actualUsd = 0;
  #ceilingEmitted = false;
  #monthStart = 0;
  #warningEmitted = false;

  public constructor(options: UsageBudgetOptions) {
    if (options.warningUsd < 0 || options.ceilingUsd <= options.warningUsd) {
      throw new RangeError('usage thresholds must be positive and ordered');
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

    const id = randomUUID();
    this.#reservations.set(id, {
      amountUsd: estimateUsd,
      occurredAt: now,
      ...work,
    });
    this.#ledger?.record({
      actualUsd: null,
      id,
      occurredAt: now,
      operation: kind,
      ...work,
      reservationUsd: estimateUsd,
    });
    return { allowed: true, id };
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
      this.#evaluateThresholds();
    }
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
      id: randomUUID(),
      occurredAt: now,
      operation: 'unreserved',
      priority: 'interactive',
      reservationUsd: 0,
      workCategory: 'interaction',
    });
    this.#actualUsd += amountUsd;
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

  #reservedTotal(): number {
    let total = 0;
    for (const value of this.#reservations.values()) total += value.amountUsd;
    return total;
  }

  #loadMonth(now: number): void {
    this.#monthStart = monthStart(now);
    this.#actualUsd = 0;
    this.#reservations.clear();
    for (const entry of this.#ledger?.list(
      this.#monthStart,
      nextMonth(this.#monthStart),
    ) ?? []) {
      if (entry.actualUsd === null) {
        this.#reservations.set(entry.id, {
          amountUsd: entry.reservationUsd,
          occurredAt: entry.occurredAt,
          priority: entry.priority,
          workCategory: entry.workCategory,
        });
      } else {
        this.#actualUsd += entry.actualUsd;
      }
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
