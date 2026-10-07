import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeHealth } from '../../src/ops/health-probe.ts';

const healthy = {
  ready: true,
  criticalChecks: {
    database: true,
    discord: true,
    disk: true,
    maintenance: true,
  },
};

afterEach(() => vi.restoreAllMocks());

describe('health probe boundary', () => {
  it('retains valid readiness and 503 critical checks', async () => {
    const unready = {
      ready: false,
      criticalChecks: { ...healthy.criticalChecks, database: false },
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(healthy))
      .mockResolvedValueOnce(Response.json(unready, { status: 503 }));
    expect(await probeHealth()).toEqual({
      health: healthy,
      reason: null,
      status: 200,
    });
    expect(await probeHealth()).toEqual({
      health: unready,
      reason: 'http',
      status: 503,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8080/healthz');
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects malformed, incomplete, or contradictory responses', async () => {
    for (const body of [
      'SECRET invalid JSON',
      'null',
      '[]',
      '{}',
      JSON.stringify({ ready: true, criticalChecks: null }),
      JSON.stringify({ ready: true, criticalChecks: { discord: true } }),
      JSON.stringify({ ...healthy, ready: false }),
      JSON.stringify({
        ...healthy,
        criticalChecks: { ...healthy.criticalChecks, disk: 'false' },
      }),
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body));
      expect(await probeHealth()).toEqual({
        health: {},
        reason: 'response',
        status: 200,
      });
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(healthy, { status: 503 }),
    );
    expect(await probeHealth()).toEqual({
      health: {},
      reason: 'http',
      status: 503,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('SECRET', { status: 500 }),
    );
    expect(await probeHealth()).toEqual({
      health: {},
      reason: 'http',
      status: 500,
    });
  });

  it('classifies connection failures and timeouts without leaking errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('SECRET provider payload'),
    );
    expect(await probeHealth()).toEqual({
      health: {},
      reason: 'connection',
      status: null,
    });
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    expect(await probeHealth()).toEqual({
      health: {},
      reason: 'timeout',
      status: null,
    });
  });
});
