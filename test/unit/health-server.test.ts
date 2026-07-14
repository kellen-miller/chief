import { describe, expect, it } from 'vitest';

import { HealthServer } from '../../src/health/health-server.js';

describe('HealthServer', () => {
  it('serves only non-secret readiness state on loopback', async () => {
    const server = new HealthServer({
      check: () =>
        Promise.resolve({ database: true, discord: true, disk: true }),
      port: 0,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.port.toString()}/healthz`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checks: { database: true, discord: true, disk: true },
      ready: true,
    });
    await server.stop();
  });

  it('returns service unavailable when any readiness check fails', async () => {
    const server = new HealthServer({
      check: () => Promise.resolve({ database: true, discord: false }),
      port: 0,
    });
    await server.start();
    const response = await fetch(
      `http://127.0.0.1:${server.port.toString()}/healthz`,
    );
    expect(response.status).toBe(503);
    expect(
      (await fetch(`http://127.0.0.1:${server.port.toString()}/missing`))
        .status,
    ).toBe(404);
    await server.stop();
    await server.stop();
  });

  it('exposes degraded context diagnostics without failing readiness', async () => {
    const context = {
      degraded: true,
      failedJobs: 0,
      lagMsByTier: { daily: 0, hourly: 10_000, 'long-term': 0, weekly: 0 },
      pendingJobs: 1,
      reason: 'indexing-budget',
    } as const;
    const server = new HealthServer({
      check: () => Promise.resolve({ database: true, discord: true }),
      diagnostics: () => Promise.resolve({ context }),
      port: 0,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.port.toString()}/healthz`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checks: { database: true, discord: true },
      diagnostics: { context },
      ready: true,
    });
    await server.stop();
  });

  it('maps a failed check to a redacted unavailable response', async () => {
    const server = new HealthServer({
      check: () => Promise.reject(new Error('secret provider detail')),
      port: 0,
    });
    await server.start();
    await server.start();
    const response = await fetch(
      `http://127.0.0.1:${server.port.toString()}/healthz`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ checks: {}, ready: false });
    await server.stop();
  });
});
