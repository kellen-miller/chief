import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildReports,
  collectSnapshot,
  monitor,
  parseErrors,
  type MonitorSnapshot,
  type MonitorState,
} from '../../src/ops/monitor.ts';

const now = Date.parse('2026-10-04T13:00:00Z') / 1000;
function snapshot(): MonitorSnapshot {
  return {
    deployment: {},
    sampled_at: now,
    health: {
      ready: true,
      criticalChecks: {
        database: true,
        discord: true,
        disk: true,
        maintenance: true,
      },
      diagnostics: {
        context: { degraded: false, failedJobs: 0, pendingJobs: 2 },
        usage: {
          actualUsd: 1,
          reservedUsd: 0.2,
          ceilingUsd: 10,
          warningUsd: 5,
        },
        models: {
          text: 'gpt-6-luna',
          memory: 'gpt-6-luna',
          voice: 'gpt-realtime-2.1-mini',
        },
      },
    },
    backup_ok: true,
    backup_age_hours: 7,
    disk_free_gib: { boot: 3.4, data: 7.6 },
  };
}

const reports = (
  sample: MonitorSnapshot,
  state: MonitorState = {},
  timestamp = now,
  events: Record<string, number> = {},
) => buildReports(sample, events, state, timestamp, 'America/New_York');
const offline = (): MonitorSnapshot => {
  const sample = snapshot();
  sample.health = {
    ready: false,
    criticalChecks: {
      discord: false,
      database: true,
      disk: true,
      maintenance: true,
    },
  };
  return sample;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('host-side Discord monitoring', () => {
  it('persists daily receipts and follows DST', () => {
    const sample = snapshot();
    expect(reports(sample, {}, now - 1).messages).toEqual([]);
    const { messages, receipt } = reports(sample);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain(
      '$1.0000 spent + $0.2000 reserved / $10.00',
    );
    expect(messages[0]?.allowed_mentions).toEqual({ parse: [] });
    expect(messages[0]?.embeds[0]?.color).toBe(0x57f287);
    expect(messages[0]?.embeds[0]?.timestamp).toBe('2026-10-04T13:00:00.000Z');
    expect(reports(sample, receipt, now + 60).messages).toEqual([]);
    const winter = Date.parse('2026-11-02T14:00:00Z') / 1000;
    expect(reports(sample, receipt, winter - 1).messages).toEqual([]);
    expect(reports(sample, receipt, winter).messages).toHaveLength(1);
  });

  it('deduplicates incidents and recoveries', () => {
    const sample = offline();
    sample.health.diagnostics = {
      context: { degraded: true, reason: 'provider', failedJobs: 6 },
      usage: { actualUsd: 10, ceilingUsd: 10 },
    };
    sample.backup_ok = false;
    sample.disk_free_gib.boot = 0.1;
    const { messages, receipt } = reports(
      sample,
      { discord_unready_since: now - 3660 },
      now - 3600,
    );
    for (const expected of [
      'Not ready: discord',
      'provider; 6 failed jobs',
      'Backup failed',
      'budget ceiling',
      '0.5 GiB',
    ])
      expect(JSON.stringify(messages)).toContain(expected);
    expect(reports(sample, receipt, now - 3500).messages).toEqual([]);
    const recovered = reports(snapshot(), receipt, now - 3400);
    expect(JSON.stringify(recovered.messages)).toContain('Context');
    expect(recovered.messages[0]?.embeds[0]?.color).toBe(0x57f287);
    expect(reports(snapshot(), recovered.receipt, now - 3300).messages).toEqual(
      [],
    );
  });

  it('allowlists logs and throttles repeat errors', () => {
    const logs = [
      JSON.stringify({
        msg: 'discord_message_failed',
        prompt: 'PRIVATE',
        token: 'SECRET',
      }),
      JSON.stringify({ msg: 'PRIVATE' }),
      'invalid SECRET',
      'null',
    ].join('\n');
    const events = parseErrors(logs, '', now, {});
    expect(events).toEqual({ discord_message_failed: 1 });
    const sample = snapshot();
    sample.health.diagnostics = {
      context: { degraded: true, reason: 'PRIVATE' },
      models: { text: 'SECRET @everyone' },
    };
    const first = reports(sample, {}, now, events);
    expect(JSON.stringify(first.messages)).not.toMatch(/PRIVATE|SECRET/u);
    expect(reports(sample, first.receipt, now + 60, events).messages).toEqual(
      [],
    );
    expect(
      JSON.stringify(
        reports(sample, first.receipt, now + 3600, events).messages,
      ),
    ).toContain('discord_message_failed');
    expect(
      parseErrors(
        [
          'discord_shard_reconnecting',
          'discord_shard_resumed',
          'discord_gateway_error',
          'discord_shard_error',
        ]
          .map((msg) => JSON.stringify({ msg }))
          .join('\n'),
        '',
        now,
        {},
      ),
    ).toEqual({ discord_gateway_error: 1, discord_shard_error: 1 });
  });

  it('requires one minute of Discord outage and resets on recovery', () => {
    const sample = offline();
    const start = now - 3600;
    const first = reports(sample, {}, start);
    expect(first.messages).toEqual([]);
    const resumed = reports(snapshot(), first.receipt, start + 2);
    expect(resumed.messages).toEqual([]);
    expect(resumed.receipt.discord_unready_since).toBeNull();
    expect(reports(sample, first.receipt, start + 59).messages).toEqual([]);
    const sustained = reports(sample, first.receipt, start + 60);
    expect(JSON.stringify(sustained.messages)).toContain('Not ready: discord');
    expect(
      JSON.stringify(
        reports(snapshot(), sustained.receipt, start + 61).messages,
      ),
    ).toContain('Health');
    sample.health.criticalChecks = { database: false, discord: false };
    expect(
      JSON.stringify(reports(sample, resumed.receipt, start + 62).messages),
    ).toContain('Not ready: database');
  });

  it('suppresses deployment outages and defers daily reports across sampling races', () => {
    const sample = snapshot();
    sample.health = {};
    sample.deployment = { started: now - 30, status: 'active' };
    const first = reports(sample);
    expect(first.messages).toEqual([]);
    expect(first.receipt.problems).toEqual({});
    expect(first.receipt.report_date).toBeNull();
    sample.deployment = {
      ...sample.deployment,
      ended: now + 30,
      status: 'completed',
    };
    expect(reports(sample, first.receipt, now + 60).messages).toEqual([]);
    sample.sampled_at = now + 60;
    sample.health = snapshot().health;
    expect(
      reports(sample, first.receipt, now + 60).messages[0]?.embeds[0]?.title,
    ).toBe('Chief · Daily report');
  });

  it('preserves existing incidents and reports independent disk failures during deploy', () => {
    const sample = snapshot();
    sample.health = {};
    sample.deployment = { started: now - 30, status: 'active' };
    sample.disk_free_gib.boot = 0.1;
    const result = reports(sample, {
      problems: {
        health: 'Not ready: database',
        context: 'Context degraded: provider; 6 failed jobs',
      },
    });
    expect(result.receipt.problems?.health).toBe('Not ready: database');
    expect(result.receipt.problems?.context).toContain('provider');
    expect(JSON.stringify(result.messages)).not.toContain('✅ Recovered');
    expect(JSON.stringify(result.messages)).toContain('0.5 GiB');
  });

  it('reports failed or abandoned deployments', () => {
    for (const deployment of [
      { started: now - 30, ended: now, status: 'failed' },
      { started: now - 900, status: 'active' },
    ]) {
      const sample = snapshot();
      sample.health = {};
      sample.deployment = deployment;
      const result = reports(sample);
      expect(result.receipt.problems?.deployment).toBeDefined();
      expect(JSON.stringify(result.messages)).toContain(
        'Health/readiness unavailable',
      );
    }
  });

  it('filters only health errors within the deployment window', () => {
    const deployment = { started: now - 30, ended: now, status: 'completed' };
    const logs = [
      ['chief_health_failed', now - 31],
      ['chief_health_failed', now - 10],
      ['chief_health_failed', now + 1],
      ['discord_gateway_error', now - 10],
    ]
      .map(([msg, timestamp]) =>
        JSON.stringify({ msg, time: Number(timestamp) * 1000 }),
      )
      .join('\n');
    const journal = JSON.stringify({
      __REALTIME_TIMESTAMP: String((now - 10) * 1e6),
      MESSAGE: JSON.stringify({ msg: 'chief_health_failed' }),
    });
    expect(parseErrors(logs, journal, now + 2, deployment)).toEqual({
      chief_health_failed: 2,
      discord_gateway_error: 1,
    });
  });

  it('does not claim missing diagnostics recovered during an outage', () => {
    const sample = snapshot();
    sample.health = {};
    const result = reports(sample, {
      problems: { context: 'Context degraded: provider; 6 failed jobs' },
    });
    expect(result.receipt.problems?.context).toContain('provider');
    expect(JSON.stringify(result.messages)).not.toContain('✅ Recovered');
    expect(JSON.stringify(result.messages)).toContain(
      'Health/readiness unavailable',
    );
  });

  it('retains 503 critical checks and never acknowledges failed Discord delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-monitor-test-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const [name, output] of [
      [
        'systemctl',
        'Result=success\nExecMainExitTimestamp=Sun 2026-10-04 06:06:10 UTC\n',
      ],
      ['gcloud', 'SECRET'],
      ['docker', ''],
      ['journalctl', ''],
    ]) {
      writeFileSync(
        join(bin, name ?? ''),
        `#!/bin/sh\ncat <<'EOF'\n${output ?? ''}\nEOF\n`,
        { mode: 0o755 },
      );
    }

    const config = join(root, 'monitoring.env');
    writeFileSync(
      config,
      'GCP_PROJECT_ID=chief-project\nDISCORD_GUILD_ID=123\nDISCORD_MONITORING_CHANNEL_ID=456\nCHIEF_CONTEXT_TIME_ZONE=America/New_York\n',
    );
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('CHIEF_DATA_DIR', root);
    vi.stubEnv('CHIEF_MONITORING_CONFIG_FILE', config);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ready: false, criticalChecks: { discord: false } }),
          { status: 503 },
        ),
      );
    const sample = await collectSnapshot(now);
    expect(sample.health.criticalChecks).toEqual({ discord: false });
    expect(sample.backup_ok).toBe(true);
    writeFileSync(
      join(root, 'monitoring.json'),
      JSON.stringify({ cursor: now - 60 }),
    );
    const original = readFileSync(join(root, 'monitoring.json'), 'utf8');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now * 1000);
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot().health)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ guild_id: '123', type: 0 })),
      )
      .mockResolvedValueOnce(new Response('SECRET', { status: 500 }));
    await expect(monitor()).rejects.toThrow('monitoring delivery failed');
    expect(readFileSync(join(root, 'monitoring.json'), 'utf8')).toBe(original);
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot().health)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ guild_id: 'WRONG', type: 0 })),
      );
    await expect(monitor()).rejects.toThrow('outside configured guild');
    expect(readFileSync(join(root, 'monitoring.json'), 'utf8')).toBe(original);
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot().health)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ guild_id: '123', type: 0 })),
      )
      .mockResolvedValueOnce(new Response('{}'));
    await monitor();
    expect(
      JSON.parse(readFileSync(join(root, 'monitoring.json'), 'utf8')),
    ).toMatchObject({ report_date: '2026-10-04', cursor: now });
  });
});
