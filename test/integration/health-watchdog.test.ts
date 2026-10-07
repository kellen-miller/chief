import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { healthWatchdog } from '../../src/ops/health-watchdog.ts';

const now = Date.parse('2026-10-07T12:00:00Z') / 1000;
const healthy = {
  ready: true,
  criticalChecks: {
    database: true,
    discord: true,
    disk: true,
    maintenance: true,
  },
};
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chief-watchdog-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'logger'),
    '#!/bin/sh\nprintf "%s\\n" "$3" >>"$TEST_LOG"\n',
    { mode: 0o755 },
  );
  vi.stubEnv('CHIEF_DATA_DIR', root);
  vi.stubEnv('TEST_LOG', join(root, 'events'));
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('persistent health watchdog', () => {
  it('emits GCP alert events only after the real CLI readiness gate fails', async () => {
    vi.useRealTimers();
    let health = {
      ready: false,
      criticalChecks: { ...healthy.criticalChecks, discord: false },
    };
    const server = createServer((_, response) => {
      response.writeHead(health.ready ? 200 : 503).end(JSON.stringify(health));
    });
    server.listen(8080, '127.0.0.1');
    await once(server, 'listening');
    try {
      for (const scenario of [
        'transient',
        'sustained',
        'healthy',
        'database',
        'deployment',
      ]) {
        if (scenario === 'sustained')
          writeFileSync(
            join(root, 'health-watchdog.json'),
            JSON.stringify({ unready_since: Date.now() / 1000 - 61 }),
          );
        if (scenario === 'healthy') health = healthy;
        if (scenario === 'database')
          health = {
            ready: false,
            criticalChecks: { ...healthy.criticalChecks, database: false },
          };
        if (scenario === 'deployment') {
          health = {
            ready: false,
            criticalChecks: { ...healthy.criticalChecks, discord: false },
          };
          writeFileSync(
            join(root, 'deployment-monitoring.json'),
            JSON.stringify({
              started: Math.floor(Date.now() / 1000),
              status: 'active',
            }),
          );
        }

        const child = spawn(
          process.execPath,
          [resolve('src/ops/cli.ts'), 'health-watchdog'],
          { timeout: 10000 },
        );
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const [code] = (await once(child, 'close')) as [number];
        expect(code, scenario).toBe(
          scenario === 'sustained' || scenario === 'database' ? 1 : 0,
        );
        expect(stderr).not.toContain('SECRET');
      }

      const events = readFileSync(join(root, 'events'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { msg: string });
      expect(
        events.filter((event) => event.msg === 'chief_health_failed'),
      ).toHaveLength(2);
      expect(
        events.filter((event) => event.msg === 'chief_health_probe_failed'),
      ).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('debounces outages across runs and resets on recovery', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('SECRET'));
    await healthWatchdog();
    expect(
      JSON.parse(readFileSync(join(root, 'health-watchdog.json'), 'utf8')),
    ).toEqual({ unready_since: now });
    vi.setSystemTime((now + 59) * 1000);
    await healthWatchdog();
    vi.setSystemTime((now + 60) * 1000);
    const discord = {
      ready: false,
      criticalChecks: { ...healthy.criticalChecks, discord: false },
    };
    fetch.mockResolvedValueOnce(Response.json(discord, { status: 503 }));
    await expect(healthWatchdog()).rejects.toThrow('Not ready: discord');
    fetch.mockResolvedValueOnce(Response.json(healthy));
    await healthWatchdog();
    expect(
      JSON.parse(readFileSync(join(root, 'health-watchdog.json'), 'utf8')),
    ).toEqual({ unready_since: null });
    vi.setSystemTime((now + 120) * 1000);
    await healthWatchdog();
    const events = readFileSync(join(root, 'events'), 'utf8');
    expect(events).toContain('"reason":"connection"');
    expect(events).toContain('"reason":"http"');
    expect(events).not.toContain('SECRET');
  });

  it('fails sustained unavailable probes and explicit local faults', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('SECRET'));
    await healthWatchdog();
    vi.setSystemTime((now + 60) * 1000);
    await expect(healthWatchdog()).rejects.toThrow(
      'Health/readiness unavailable',
    );
    for (const name of ['database', 'disk', 'maintenance']) {
      writeFileSync(
        join(root, 'health-watchdog.json'),
        '{"unready_since":null}',
      );
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        Response.json(
          {
            ready: false,
            criticalChecks: { ...healthy.criticalChecks, [name]: false },
          },
          { status: 503 },
        ),
      );
      await expect(healthWatchdog()).rejects.toThrow(`Not ready: ${name}`);
    }
  });

  it('suppresses active deployments and probes sampled before completion', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('SECRET'));
    writeFileSync(
      join(root, 'health-watchdog.json'),
      JSON.stringify({ unready_since: now - 60 }),
    );
    const path = join(root, 'deployment-monitoring.json');
    writeFileSync(
      path,
      JSON.stringify({ started: now - 30, status: 'active' }),
    );
    await healthWatchdog();
    writeFileSync(
      path,
      JSON.stringify({ started: now - 30, ended: now, status: 'completed' }),
    );
    await healthWatchdog();
    vi.setSystemTime((now + 1) * 1000);
    await healthWatchdog();
    vi.setSystemTime((now + 61) * 1000);
    await expect(healthWatchdog()).rejects.toThrow(
      'Health/readiness unavailable',
    );
  });

  it('does not suppress abandoned or failed deployment outages', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('SECRET'));
    writeFileSync(
      join(root, 'health-watchdog.json'),
      JSON.stringify({ unready_since: now - 60 }),
    );
    for (const deployment of [
      { started: now - 900, status: 'active' },
      { started: now - 30, ended: now, status: 'failed' },
    ]) {
      writeFileSync(
        join(root, 'deployment-monitoring.json'),
        JSON.stringify(deployment),
      );
      await expect(healthWatchdog()).rejects.toThrow(
        'Health/readiness unavailable',
      );
    }
  });

  it('keeps explicit local faults actionable during deployment maintenance', async () => {
    writeFileSync(
      join(root, 'deployment-monitoring.json'),
      JSON.stringify({ started: now - 30, status: 'active' }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          ready: false,
          criticalChecks: { ...healthy.criticalChecks, disk: false },
        },
        { status: 503 },
      ),
    );
    await expect(healthWatchdog()).rejects.toThrow('Not ready: disk');
  });
});
