import { describe, expect, it, vi } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteUsageLedger } from '../../src/usage/sqlite-usage-ledger.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

describe('UsageBudget', () => {
  it('refuses a reservation that could cross the monthly ceiling', () => {
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    budget.recordActual(9.8);

    expect(budget.reserve('voice-response', 0.25)).toEqual({
      allowed: false,
      reason: 'ceiling',
    });
  });

  it('reconciles a conservative reservation to actual usage', () => {
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const reservation = budget.reserve('hosted-search', 0.1);
    if (!reservation.allowed) throw new Error('reservation should be allowed');

    budget.reconcile(reservation.id, 0.02);

    expect(budget.snapshot()).toMatchObject({
      actualUsd: 0.02,
      reservedUsd: 0,
    });
  });

  it('emits the warning threshold only once', () => {
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });

    expect(budget.recordActual(5.1).warningRaised).toBe(true);
    expect(budget.recordActual(0.1).warningRaised).toBe(false);
  });

  it('restores actual usage and reservations after a restart', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const ledger = new SqliteUsageLedger(database);
    const now = () => Date.UTC(2026, 6, 11);
    const first = new UsageBudget({
      ceilingUsd: 10,
      ledger,
      now,
      warningUsd: 5,
    });
    first.recordActual(4);
    expect(first.reserve('voice', 2)).toMatchObject({ allowed: true });

    const restarted = new UsageBudget({
      ceilingUsd: 10,
      ledger,
      now,
      warningUsd: 5,
    });
    expect(restarted.snapshot()).toEqual({
      actualUsd: 4,
      reservedUsd: 2,
      warningRaised: false,
    });
    expect(restarted.reserve('text', 4.01)).toEqual({
      allowed: false,
      reason: 'ceiling',
    });
    database.close();
  });

  it('starts a fresh budget at the next UTC month', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const ledger = new SqliteUsageLedger(database);
    let current = Date.UTC(2026, 6, 31, 23, 59);
    const budget = new UsageBudget({
      ceilingUsd: 10,
      ledger,
      now: () => current,
      warningUsd: 5,
    });
    budget.recordActual(9);

    current = Date.UTC(2026, 7, 1);
    expect(budget.snapshot()).toEqual({
      actualUsd: 0,
      reservedUsd: 0,
      warningRaised: false,
    });
    expect(budget.reserve('text', 10)).toMatchObject({ allowed: true });
    database.close();
  });

  it('validates amounts and reservation ownership', () => {
    expect(() => new UsageBudget({ ceilingUsd: 1, warningUsd: 1 })).toThrow(
      RangeError,
    );
    const budget = new UsageBudget({ ceilingUsd: 2, warningUsd: 1 });
    expect(() => budget.reserve('bad', Number.NaN)).toThrow(RangeError);
    expect(() => budget.recordActual(-1)).toThrow(RangeError);
    expect(() => {
      budget.cancel('missing');
    }).toThrow(/unknown/u);
    expect(() => {
      budget.reconcile('missing', 0);
    }).toThrow(/unknown/u);
    const reservation = budget.reserve('cancel', 0.5);
    if (!reservation.allowed) throw new Error('reservation should be allowed');
    budget.cancel(reservation.id);
    expect(budget.snapshot().reservedUsd).toBe(0);
  });

  it('emits warning and ceiling events once and reports affordability', () => {
    const onThreshold = vi.fn<(event: 'ceiling' | 'warning') => void>();
    const budget = new UsageBudget({
      ceilingUsd: 2,
      onThreshold,
      warningUsd: 1,
    });
    expect(budget.canAfford(2)).toBe(true);
    budget.recordActual(1);
    budget.recordActual(1);
    budget.recordActual(0.1);
    expect(onThreshold.mock.calls.map(([event]) => event)).toEqual([
      'warning',
      'ceiling',
    ]);
    expect(budget.canAfford(0)).toBe(false);
  });
});
