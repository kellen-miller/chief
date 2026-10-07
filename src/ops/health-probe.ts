export interface HealthProbe {
  health: Record<string, unknown>;
  reason: 'connection' | 'http' | 'response' | 'timeout' | null;
  status: number | null;
}

const criticalChecks = ['database', 'discord', 'disk', 'maintenance'] as const;
export const deploymentGraceSeconds = 15 * 60;

export function deploymentMaintenance(
  deployment: Record<string, unknown>,
  sampledAt: number,
  now: number,
): boolean {
  const started =
    typeof deployment.started === 'number' ? deployment.started : 0;
  const ended = typeof deployment.ended === 'number' ? deployment.ended : 0;
  return (
    started > 0 &&
    now >= started &&
    ((deployment.status === 'active' &&
      now - started < deploymentGraceSeconds) ||
      (deployment.status === 'completed' &&
        sampledAt >= started &&
        sampledAt <= ended))
  );
}

export async function probeHealth(): Promise<HealthProbe> {
  const signal = AbortSignal.timeout(5000);
  let status: number | null = null;
  try {
    const response = await fetch('http://127.0.0.1:8080/healthz', { signal });
    status = response.status;
    const reason = status === 200 ? 'response' : 'http';
    if (status !== 200 && status !== 503) return { health: {}, reason, status };

    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { health: {}, reason, status };

    const health = value as Record<string, unknown>;
    const checks = health.criticalChecks;
    if (
      typeof health.ready !== 'boolean' ||
      typeof checks !== 'object' ||
      checks === null ||
      Array.isArray(checks)
    )
      return { health: {}, reason, status };

    const values = checks as Record<string, unknown>;
    if (
      !criticalChecks.every((name) => typeof values[name] === 'boolean') ||
      health.ready !== criticalChecks.every((name) => values[name] === true) ||
      health.ready !== (status === 200)
    )
      return { health: {}, reason, status };

    return { health, reason: response.ok ? null : 'http', status };
  } catch {
    return {
      health: {},
      reason: signal.aborted
        ? 'timeout'
        : status === null
          ? 'connection'
          : 'response',
      status,
    };
  }
}

// Explicit local faults alert immediately. Unknown/Discord outages must persist.
export function healthReadiness(
  health: Record<string, unknown>,
  previousSince: number | null | undefined,
  now: number,
  deploying: boolean,
): { unreadySince: number | null; problem: string | null } {
  if (health.ready === true) return { unreadySince: null, problem: null };

  const unreadySince = previousSince ?? now;
  const checks = health.criticalChecks as Record<string, unknown> | undefined;
  const sustained = now - unreadySince >= 60;
  const failed = criticalChecks.filter(
    (name) =>
      checks?.[name] === false &&
      (name !== 'discord' || (sustained && !deploying)),
  );
  if (deploying && failed.length === 0)
    return { unreadySince: null, problem: null };

  return {
    unreadySince,
    problem: failed.length
      ? `Not ready: ${failed.join(', ')}`
      : sustained
        ? 'Health/readiness unavailable'
        : null,
  };
}
