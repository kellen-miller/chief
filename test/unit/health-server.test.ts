import { describe, expect, it } from 'vitest';

import {
  contextHealthDiagnostics,
  HealthServer,
} from '../../src/health/health-server.js';

describe('HealthServer', () => {
  it('redacts internal lag reasons into bounded context diagnostics', () => {
    expect(
      contextHealthDiagnostics(
        {
          backfillCounts: { active: 1, failed: 2, paused: 3 },
          degraded: true,
          failedJobs: 4,
          lagMsByTier: {
            daily: 1_999,
            hourly: 9_999,
            'long-term': 0,
            weekly: 20_001,
          },
          pendingJobs: 5,
          reason: 'forget-journal',
        },
        31_999,
      ),
    ).toEqual({
      ageSecondsByTier: {
        daily: 1,
        hourly: 9,
        'long-term': 0,
        weekly: 20,
      },
      backfillCounts: { active: 1, failed: 2, paused: 3 },
      degraded: true,
      failedJobs: 4,
      pendingJobs: 5,
      reason: 'backlog',
      reconciliationAgeSeconds: 31,
    });
  });

  it('serves only non-secret readiness state on loopback', async () => {
    const server = new HealthServer({
      check: () =>
        Promise.resolve({
          database: true,
          discord: true,
          disk: true,
          maintenance: true,
        }),
      port: 0,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.port.toString()}/healthz`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      criticalChecks: {
        database: true,
        discord: true,
        disk: true,
        maintenance: true,
      },
      ready: true,
    });
    await server.stop();
  });

  it('returns service unavailable when any readiness check fails', async () => {
    const server = new HealthServer({
      check: () =>
        Promise.resolve({
          database: true,
          discord: false,
          disk: true,
          maintenance: true,
        }),
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
      ageSecondsByTier: {
        daily: 0,
        hourly: 10,
        'long-term': 0,
        weekly: 0,
      },
      backfillCounts: { active: 1, failed: 0, paused: 0 },
      degraded: true,
      failedJobs: 0,
      pendingJobs: 1,
      reason: 'indexing-budget',
      reconciliationAgeSeconds: 30,
    } as const;
    const server = new HealthServer({
      check: () =>
        Promise.resolve({
          database: true,
          discord: true,
          disk: true,
          maintenance: true,
        }),
      diagnostics: () => Promise.resolve({ context }),
      port: 0,
    });
    await server.start();

    const response = await fetch(
      `http://127.0.0.1:${server.port.toString()}/healthz`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      criticalChecks: {
        database: true,
        discord: true,
        disk: true,
        maintenance: true,
      },
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
    expect(await response.json()).toEqual({
      criticalChecks: {},
      ready: false,
    });
    await server.stop();
  });
});
