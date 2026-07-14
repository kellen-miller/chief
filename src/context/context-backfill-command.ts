import type { ContextBackfillStatus } from './context-backfill.js';

export interface ContextBackfillCommandService {
  activate(input: {
    readonly confirmGuildId: string;
    readonly maximumUsageUsd: number;
  }): ContextBackfillStatus;
  dryRun(input: { readonly replace: boolean }): Promise<ContextBackfillStatus>;
  resume(runId: number): Promise<ContextBackfillStatus>;
  status(runId?: number): ContextBackfillStatus | null;
}

export async function executeContextBackfillCommand(
  arguments_: readonly string[],
  service: ContextBackfillCommandService,
): Promise<string> {
  const actions = ['--activate', '--dry-run', '--resume', '--status'].filter(
    (action) => arguments_.includes(action),
  );
  if (actions.length !== 1) {
    throw new Error('context-backfill requires exactly one action');
  }
  const action = actions[0];
  let status: ContextBackfillStatus | null;
  switch (action) {
    case '--dry-run':
      status = await service.dryRun({
        replace: arguments_.includes('--replace'),
      });
      break;
    case '--activate':
      status = service.activate({
        confirmGuildId: requireFlag(arguments_, '--confirm-guild'),
        maximumUsageUsd: positiveNumber(
          requireFlag(arguments_, '--max-usd'),
          'maximum usage',
        ),
      });
      break;
    case '--resume':
      status = await service.resume(
        positiveInteger(requireFlag(arguments_, '--resume'), 'run ID'),
      );
      break;
    case '--status': {
      const runId = optionalFlag(arguments_, '--run-id');
      status = service.status(
        runId === undefined ? undefined : positiveInteger(runId, 'run ID'),
      );
      break;
    }
    default:
      throw new Error('unknown context-backfill action');
  }
  if (status === null) throw new Error('no context backfill run exists');
  return JSON.stringify(redactedStatus(status));
}

function redactedStatus(status: ContextBackfillStatus): {
  readonly actualUsageUsd: number;
  readonly alreadyIngestedCount: number;
  readonly eligibleBytes: number;
  readonly eligibleCount: number;
  readonly eligibleTokens: number;
  readonly estimatedUsageUsd: number;
  readonly maximumUsageUsd: number | null;
  readonly newestOccurredAt: number | null;
  readonly oldestOccurredAt: number | null;
  readonly pageCount: number;
  readonly pauseReason: string | null;
  readonly resumeCommand: string | null;
  readonly runId: number;
  readonly status: ContextBackfillStatus['status'];
} {
  return {
    actualUsageUsd: status.actualUsageUsd,
    alreadyIngestedCount: status.alreadyIngestedCount,
    eligibleBytes: status.eligibleBytes,
    eligibleCount: status.eligibleCount,
    eligibleTokens: status.eligibleTokens,
    estimatedUsageUsd: status.estimatedUsageUsd,
    maximumUsageUsd: status.maximumUsageUsd,
    newestOccurredAt: status.newestOccurredAt,
    oldestOccurredAt: status.oldestOccurredAt,
    pageCount: status.pageCount,
    pauseReason: status.pauseReason,
    resumeCommand:
      status.status === 'paused' || status.status === 'dry-run'
        ? `pnpm chief -- context-backfill --resume ${status.runId.toString()}`
        : null,
    runId: status.runId,
    status: status.status,
  };
}

function requireFlag(arguments_: readonly string[], name: string): string {
  const value = optionalFlag(arguments_, name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function optionalFlag(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return parsed;
}
