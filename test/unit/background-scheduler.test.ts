import { describe, expect, it, vi } from 'vitest';

import { BackgroundScheduler } from '../../src/usage/background-scheduler.js';
import { PaidWorkQueue } from '../../src/usage/paid-work-queue.js';

describe('BackgroundScheduler', () => {
  it('runs the due live job with the earliest freshness deadline', async () => {
    const memoryRun = vi.fn(() => Promise.resolve());
    const contextRun = vi.fn(() => Promise.resolve());
    const scheduler = new BackgroundScheduler({
      context: {
        nextDeadline: () => 10,
        runOne: contextRun,
      },
      memory: {
        nextDeadline: () => 20,
        runOne: memoryRun,
      },
      queue: new PaidWorkQueue(),
    });

    await expect(scheduler.runBackgroundOne(30)).resolves.toEqual({
      kind: 'context',
      status: 'completed',
    });
    expect(contextRun).toHaveBeenCalledWith(30);
    expect(memoryRun).not.toHaveBeenCalled();
  });

  it('runs eligible work before its future freshness deadline', async () => {
    const contextRun = vi.fn(() => Promise.resolve());
    const scheduler = new BackgroundScheduler({
      context: {
        nextDeadline: () => 110,
        runOne: contextRun,
      },
      memory: {
        nextDeadline: () => null,
        runOne: vi.fn(),
      },
      queue: new PaidWorkQueue(),
    });

    await expect(scheduler.runBackgroundOne(100)).resolves.toMatchObject({
      kind: 'context',
    });
    expect(contextRun).toHaveBeenCalledWith(100);
  });

  it('fairly rotates memory and context work with equal deadlines', async () => {
    const order: string[] = [];
    const scheduler = new BackgroundScheduler({
      context: {
        nextDeadline: () => 10,
        runOne: () => {
          order.push('context');
          return Promise.resolve();
        },
      },
      memory: {
        nextDeadline: () => 10,
        runOne: () => {
          order.push('memory');
          return Promise.resolve();
        },
      },
      queue: new PaidWorkQueue(),
    });

    await scheduler.runBackgroundOne(10);
    await scheduler.runBackgroundOne(10);

    expect(order).toEqual(['context', 'memory']);
  });

  it('selects backfill only when no live job is due', async () => {
    const order: string[] = [];
    let memoryDeadline: number | null = 20;
    const scheduler = new BackgroundScheduler({
      backfill: {
        nextDeadline: () => 1,
        runOne: () => {
          order.push('backfill');
          return Promise.resolve();
        },
      },
      context: {
        nextDeadline: () => null,
        runOne: vi.fn(),
      },
      memory: {
        nextDeadline: () => memoryDeadline,
        runOne: () => {
          order.push('memory');
          return Promise.resolve();
        },
      },
      queue: new PaidWorkQueue(),
    });

    await scheduler.runBackgroundOne(20);
    memoryDeadline = null;
    await scheduler.runBackgroundOne(20);

    expect(order).toEqual(['memory', 'backfill']);
  });
});
