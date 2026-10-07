import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deploymentMaintenance,
  healthReadiness,
  probeHealth,
} from './health-probe.ts';
import { atomicWrite, execCommand, hostPaths } from './host-state.ts';

export async function healthWatchdog(): Promise<void> {
  const data = hostPaths().data;
  const statePath = join(data, 'health-watchdog.json');
  const state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as {
        unready_since?: number | null;
      })
    : {};
  const sampledAt = Date.now() / 1000;
  const probe = await probeHealth();
  const now = Math.floor(Date.now() / 1000);
  const deploymentPath = join(data, 'deployment-monitoring.json');
  const deployment = existsSync(deploymentPath)
    ? (JSON.parse(readFileSync(deploymentPath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  const deploying = deploymentMaintenance(deployment, sampledAt, now);
  const readiness = healthReadiness(
    probe.health,
    state.unready_since,
    now,
    deploying,
  );
  atomicWrite(
    statePath,
    JSON.stringify({ unready_since: readiness.unreadySince }),
  );
  if (readiness.unreadySince === null) return;

  execCommand('logger', [
    '-t',
    'chief',
    JSON.stringify({
      msg: 'chief_health_probe_failed',
      reason: probe.reason,
      status: probe.status,
      problem: readiness.problem,
    }),
  ]);
  if (readiness.problem !== null) throw new Error(readiness.problem);
}
