import { describe, expect, it } from 'vitest';

import { PaidWorkQueue } from '../../src/usage/paid-work-queue.js';

describe('PaidWorkQueue', () => {
  it('runs a pending interaction before queued background work', async () => {
    const queue = new PaidWorkQueue();
    const order: string[] = [];
    let releaseActive = (): void => undefined;
    const active = queue.background(
      () =>
        new Promise<void>((resolve) => {
          order.push('active-background');
          releaseActive = resolve;
        }),
    );
    await Promise.resolve();

    const background = queue.background(() => {
      order.push('queued-background');
      return Promise.resolve();
    });
    const interactive = queue.interactive(() => {
      order.push('interactive');
      return Promise.resolve();
    });
    releaseActive();

    await Promise.all([active, background, interactive]);
    expect(order).toEqual([
      'active-background',
      'interactive',
      'queued-background',
    ]);
  });

  it('stops accepting work and waits for the active job on shutdown', async () => {
    const queue = new PaidWorkQueue();
    let releaseActive = (): void => undefined;
    const active = queue.background(
      () =>
        new Promise<void>((resolve) => {
          releaseActive = resolve;
        }),
    );
    await Promise.resolve();

    const shutdown = queue.shutdown();
    await expect(queue.interactive(() => Promise.resolve())).rejects.toThrow(
      'paid work queue is closed',
    );
    let stopped = false;
    void shutdown.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseActive();
    await expect(Promise.all([active, shutdown])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
