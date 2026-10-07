import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

import {
  deploymentGraceSeconds,
  deploymentMaintenance,
  healthReadiness,
  probeHealth,
} from './health-probe.ts';
import {
  atomicWrite,
  execCommand,
  hostPaths,
  readEnvironment,
} from './host-state.ts';

const errorEvents = new Set([
  'background_worker_failed',
  'memory_maintenance_failed',
  'context_forget_journal_upload_failed',
  'discord_command_failed',
  'discord_gateway_error',
  'discord_shard_error',
  'discord_message_failed',
  'discord_message_update_failed',
  'discord_message_delete_failed',
  'discord_partial_message_retryable',
  'discord_reconciliation_failed',
  'discord_reconciliation_incomplete',
  'discord_reconciliation_health_failed',
  'chief_voice_suffix_generation_failed',
  'chief_voice_suffix_fallback_missing',
  'chief_backup_failed',
  'chief_health_failed',
  'chief_recovery_failed',
  'chief_disk_low',
  'chief_voice_underrun',
  'chief_image_cleanup_failed',
]);
const contextReasons = new Set([
  'backlog',
  'indexing-budget',
  'overall-budget',
  'provider',
  'run-budget',
]);

export interface MonitorSnapshot {
  deployment: Record<string, unknown>;
  sampled_at: number;
  health: Record<string, unknown>;
  backup_ok: boolean;
  backup_age_hours: number | null;
  disk_free_gib: Record<string, number>;
}

export interface MonitorState {
  problems?: Record<string, string>;
  error_alerts?: Record<string, number>;
  error_counts?: Record<string, number>;
  report_date?: string | null;
  cursor?: number;
  discord_unready_since?: number | null;
  health_unready_since?: number | null;
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}
interface Report {
  embeds: {
    title: string;
    description?: string;
    color: number;
    fields: Field[];
    timestamp: string;
    footer: { text: string };
  }[];
  allowed_mentions: { parse: string[] };
}

// Provider/host JSON is untrusted. Read only allowlisted, typed diagnostics.
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readJson(path: string): Record<string, unknown> {
  try {
    return record(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

export function parseErrors(
  logs: string,
  journal: string,
  now: number,
  deployment: Record<string, unknown>,
): Record<string, number> {
  const events: Record<string, number> = {};
  for (const [stream, isJournal] of [
    [logs, false],
    [journal, true],
  ] as const) {
    for (const line of stream.split('\n')) {
      try {
        let event = record(JSON.parse(line));
        let observed = number(event.time) / 1000;
        if (isJournal) {
          observed = number(Number(event.__REALTIME_TIMESTAMP)) / 1_000_000;
          event = record(
            JSON.parse(typeof event.MESSAGE === 'string' ? event.MESSAGE : ''),
          );
        }

        const started = number(deployment.started);
        const ended =
          number(deployment.ended) ||
          Math.min(now, started + deploymentGraceSeconds);
        if (
          event.msg === 'chief_health_failed' &&
          started &&
          started <= observed &&
          observed <= ended
        )
          continue;
        if (typeof event.msg === 'string' && errorEvents.has(event.msg))
          events[event.msg] = (events[event.msg] ?? 0) + 1;
      } catch {
        continue;
      }
    }
  }

  return events;
}

export async function collectSnapshot(now: number): Promise<MonitorSnapshot> {
  const sampledAt = Date.now() / 1000;
  const { health } = await probeHealth();

  const backup = Object.fromEntries(
    execCommand('systemctl', [
      'show',
      'chief-backup.service',
      '-p',
      'Result',
      '-p',
      'ExecMainExitTimestamp',
    ])
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );
  const timestamp = backup.ExecMainExitTimestamp?.split(' ')
    .slice(1, 3)
    .join(' ');
  const backupAt = timestamp
    ? number(Date.parse(`${timestamp} UTC`) / 1000)
    : 0;
  const data = hostPaths().data;
  const disk: Record<string, number> = {};
  for (const [name, path] of [
    ['boot', '/'],
    ['data', data],
  ]) {
    if (!name || !path) continue;
    const stat = statfsSync(path);
    disk[name] = (stat.bavail * stat.bsize) / 1024 ** 3;
  }

  return {
    sampled_at: sampledAt,
    health,
    deployment: readJson(join(data, 'deployment-monitoring.json')),
    backup_ok:
      backup.Result === 'success' &&
      backupAt > 0 &&
      now - backupAt <= 36 * 3600,
    backup_age_hours: backupAt ? (now - backupAt) / 3600 : null,
    disk_free_gib: disk,
  };
}

export function buildReports(
  snapshot: MonitorSnapshot,
  events: Record<string, number>,
  state: MonitorState,
  now: number,
  timezone: string,
): { messages: Report[]; receipt: MonitorState } {
  const local = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now * 1000))
      .map((part) => [part.type, part.value]),
  );
  const date = `${String(local.year)}-${String(local.month)}-${String(local.day)}`;
  const health = snapshot.health;
  const diagnostics = record(health.diagnostics);
  const context = record(diagnostics.context);
  const usage = record(diagnostics.usage);
  const memory = record(diagnostics.memoryJobs);
  const deployment = snapshot.deployment;
  const deploying = deploymentMaintenance(deployment, snapshot.sampled_at, now);
  const problems: Record<string, string> = {};
  if (deployment.status === 'failed')
    problems.deployment =
      'Deployment failed; check deployment logs and rollback';
  else if (deployment.status === 'active' && !deploying)
    problems.deployment =
      'Deployment exceeded the 15-minute maintenance window';
  const readiness = healthReadiness(
    health,
    state.health_unready_since ?? state.discord_unready_since,
    now,
    deploying,
  );
  if (readiness.unreadySince !== null) {
    const problem = readiness.problem ?? state.problems?.health;
    if (problem) problems.health = problem;
  }

  if (context.degraded === true) {
    const reason =
      typeof context.reason === 'string' && contextReasons.has(context.reason)
        ? context.reason
        : 'backlog';
    problems.context = `Context degraded: ${reason}; ${String(Math.trunc(number(context.failedJobs)))} failed jobs`;
  }

  if (!snapshot.backup_ok)
    problems.backup = 'Backup failed, missing, or older than 36 hours';
  if (number(memory.failed))
    problems.memory = `Memory extraction: ${String(Math.trunc(number(memory.failed)))} failed jobs`;
  if (number(record(context.backfillCounts).failed))
    problems.backfill = 'Historical context backfill has failed runs';
  if (number(context.reconciliationAgeSeconds) > 24 * 3600)
    problems.reconciliation =
      'Discord history reconciliation is over 24 hours behind';
  for (const [name, free] of Object.entries(snapshot.disk_free_gib)) {
    if (free < 0.5)
      problems[`disk-${name}`] =
        `${capitalize(name)} disk has less than 0.5 GiB free`;
  }

  const charged = number(usage.actualUsd) + number(usage.reservedUsd);
  const ceiling = number(usage.ceilingUsd);
  const warning = number(usage.warningUsd);
  if (ceiling && charged >= ceiling)
    problems.budget = 'Monthly AI budget ceiling reached';
  else if (warning && charged >= warning)
    problems.budget = 'Monthly AI budget warning reached';
  const previous = state.problems ?? {};
  if (deploying && previous.health && !problems.health)
    problems.health = previous.health;
  for (const [key, diagnostic] of [
    ['context', 'context'],
    ['memory', 'memoryJobs'],
    ['backfill', 'context'],
    ['reconciliation', 'context'],
    ['budget', 'usage'],
  ] as const) {
    if (!(diagnostic in diagnostics) && previous[key])
      problems[key] = previous[key];
  }

  const alerts = Object.entries(problems)
    .filter(([key, text]) => previous[key] !== text)
    .map(([, text]) => text);
  const recovered = Object.keys(previous)
    .filter((key) => !(key in problems))
    .map((key) => capitalize(key.replaceAll('-', ' ')));
  const errors: string[] = [];
  const errorAlerts = { ...state.error_alerts };
  let counts = { ...state.error_counts };
  for (const [event, count] of Object.entries(events).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!errorEvents.has(event)) continue;
    counts[event] = (counts[event] ?? 0) + count;
    // Health notifications come only from the readiness gate. Keep raw counts
    // for daily reports without a duplicate or delayed outage alert.
    if (event === 'chief_health_failed') continue;

    if (now - (errorAlerts[event] ?? 0) >= 3600) {
      errors.push(`\`${event}\` · ${String(count)} observed`);
      errorAlerts[event] = now;
    }
  }

  const messages: Report[] = [];
  const timestamp = new Date(now * 1000).toISOString();
  const sections: Field[] = [];
  for (const [title, lines] of [
    ['⚠️ Needs attention', alerts],
    ['✅ Recovered', recovered],
    ['🔎 Errors observed', errors],
  ] as const) {
    let value = '';
    for (const line of lines) {
      if (value.length + line.length + 1 > 1024) {
        sections.push({ name: title, value });
        value = '';
      }

      value += (value ? '\n' : '') + line;
    }

    if (value) sections.push({ name: title, value });
  }

  if (sections.length)
    messages.push({
      embeds: [
        {
          title:
            alerts.length || errors.length
              ? 'Chief · Needs attention'
              : 'Chief · Recovered',
          color: alerts.length ? 0xed4245 : errors.length ? 0xfee75c : 0x57f287,
          fields: sections,
          timestamp,
          footer: {
            text: 'Chief monitoring · Repeat errors limited to once per hour',
          },
        },
      ],
      allowed_mentions: { parse: [] },
    });
  let reportDate = state.report_date ?? null;
  if (!deploying && Number(local.hour) >= 9 && reportDate !== date) {
    const models = record(diagnostics.models);
    const names = ['text', 'memory', 'voice'].map((name) => {
      const model = models[name];
      return `${name}: ${typeof model === 'string' && /^[a-z0-9.-]{1,80}$/u.test(model) ? model : 'unknown'}`;
    });
    const lag = record(context.ageSecondsByTier);
    const fields: Field[] = [
      {
        name: 'Health',
        value: health.ready === true ? 'Ready' : 'Not ready',
        inline: true,
      },
      {
        name: 'Context jobs',
        value: Object.keys(context).length
          ? `${String(Math.trunc(number(context.pendingJobs)))} pending · ${String(Math.trunc(number(context.failedJobs)))} failed`
          : 'Unavailable',
        inline: true,
      },
      {
        name: 'Memory jobs',
        value: Object.keys(memory).length
          ? `${String(Math.trunc(number(memory.pending)))} pending · ${String(Math.trunc(number(memory.failed)))} failed`
          : 'Unavailable',
        inline: true,
      },
      {
        name: 'AI usage (UTC month)',
        value: Object.keys(usage).length
          ? `$${number(usage.actualUsd).toFixed(4)} spent + $${number(usage.reservedUsd).toFixed(4)} reserved / $${ceiling.toFixed(2)}`
          : 'unavailable',
        inline: true,
      },
      {
        name: 'Latest backup',
        value: `${snapshot.backup_ok ? '✅ OK' : '⚠️ Check backup'} · ${snapshot.backup_age_hours === null ? 'unknown' : `${snapshot.backup_age_hours.toFixed(1)}h`} ago`,
        inline: true,
      },
      {
        name: 'Disk free',
        value: Object.entries(snapshot.disk_free_gib)
          .map(([name, free]) => `${capitalize(name)}: ${free.toFixed(1)} GiB`)
          .join('\n'),
        inline: true,
      },
      {
        name: 'Context lag',
        value: Object.keys(lag).length
          ? ['hourly', 'daily', 'weekly', 'long-term']
              .map(
                (tier) => `${tier} ${(number(lag[tier]) / 3600).toFixed(1)}h`,
              )
              .join(' · ')
          : 'Unavailable',
      },
      { name: 'Models', value: names.join('\n') },
      {
        name: 'Errors since previous report',
        value: Object.values(counts)
          .reduce((sum, value) => sum + value, 0)
          .toString(),
      },
    ];
    messages.push({
      embeds: [
        {
          title: 'Chief · Daily report',
          description: Object.keys(problems).length
            ? `⚠️ ${Object.values(problems).join('\n⚠️ ')}`
            : '✅ All systems healthy',
          color: Object.keys(problems).length ? 0xed4245 : 0x57f287,
          fields,
          timestamp,
          footer: { text: `Chief monitoring · Daily at 9 AM · ${timezone}` },
        },
      ],
      allowed_mentions: { parse: [] },
    });
    reportDate = date;
    counts = {};
  }

  return {
    messages,
    receipt: {
      problems,
      error_alerts: errorAlerts,
      error_counts: counts,
      report_date: reportDate,
      cursor: now,
      health_unready_since: readiness.unreadySince,
    },
  };
}

export async function monitor(): Promise<void> {
  const config = readEnvironment(
    process.env.CHIEF_MONITORING_CONFIG_FILE ?? '/etc/chief/monitoring.env',
  );
  const statePath = join(hostPaths().data, 'monitoring.json');
  // Receipts are host-owned. Malformed state fails closed rather than claiming delivery.
  const state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as MonitorState)
    : {};
  const snapshot = await collectSnapshot(Math.floor(Date.now() / 1000));
  const now = Math.floor(Date.now() / 1000);
  const since = state.cursor ?? now - 60;
  const logs = execCommand(
    'docker',
    [
      'logs',
      '--since',
      since.toString(),
      '--until',
      now.toString(),
      '--tail',
      '2000',
      'chief',
    ],
    { allowFailure: true },
  );
  const journal = execCommand('journalctl', [
    '-t',
    'chief',
    '--since',
    `@${String(since)}`,
    '--until',
    `@${String(now)}`,
    '--output=json',
    '--no-pager',
    '--lines=2000',
  ]);
  const { messages, receipt } = buildReports(
    snapshot,
    parseErrors(logs, journal, now, snapshot.deployment),
    state,
    now,
    config.CHIEF_CONTEXT_TIME_ZONE ?? 'America/New_York',
  );
  if (messages.length) {
    const token = execCommand('gcloud', [
      'secrets',
      'versions',
      'access',
      'latest',
      `--project=${config.GCP_PROJECT_ID ?? ''}`,
      '--secret=chief-discord-token',
    ]).trim();
    const channelUrl = `https://discord.com/api/v10/channels/${config.DISCORD_MONITORING_CHANNEL_ID ?? ''}`;
    const headers = {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Chief monitoring/1.0',
    };
    const response = await fetch(channelUrl, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('monitoring channel unavailable');
    const channel = record(await response.json());
    if (channel.guild_id !== config.DISCORD_GUILD_ID || channel.type !== 0)
      throw new Error('monitoring channel outside configured guild');
    for (const message of messages) {
      const sent = await fetch(`${channelUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
      if (!sent.ok) throw new Error('monitoring delivery failed');
    }
  }

  atomicWrite(statePath, JSON.stringify(receipt));
}
