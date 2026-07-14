import { describe, expect, it, vi } from 'vitest';

import {
  executeContextBackfillCommand,
  type ContextBackfillCommandService,
} from '../../src/context/context-backfill-command.js';
import type { ContextBackfillStatus } from '../../src/context/context-backfill.js';

const ready: ContextBackfillStatus = {
  actualUsageUsd: 0,
  alreadyIngestedCount: 2,
  eligibleBytes: 400,
  eligibleCount: 10,
  eligibleTokens: 100,
  estimatedUsageUsd: 0.25,
  maximumUsageUsd: null,
  newestOccurredAt: 2_000,
  oldestOccurredAt: 1_000,
  pageCount: 3,
  pauseReason: null,
  runId: 7,
  runKey: 'secret-internal-run-key',
  status: 'ready',
};

describe('executeContextBackfillCommand', () => {
  it('prints only redacted dry-run aggregates', async () => {
    const dryRun = vi.fn(() => Promise.resolve(ready));
    const service = fakeService({ dryRun });

    const output = await executeContextBackfillCommand(['--dry-run'], service);

    expect(dryRun).toHaveBeenCalledWith({ replace: false });
    expect(JSON.parse(output)).toMatchObject({
      eligibleCount: 10,
      estimatedUsageUsd: 0.25,
      runId: 7,
      status: 'ready',
    });
    expect(output).not.toContain('secret-internal-run-key');
  });

  it('activates without invoking runtime paid work', async () => {
    const activate = vi.fn(() => ({
      ...ready,
      maximumUsageUsd: 0.5,
      status: 'active' as const,
    }));
    const service = fakeService({ activate });

    const output = await executeContextBackfillCommand(
      [
        '--activate',
        '--confirm-guild',
        '12345678901234567',
        '--max-usd',
        '0.50',
      ],
      service,
    );

    expect(activate).toHaveBeenCalledWith({
      confirmGuildId: '12345678901234567',
      maximumUsageUsd: 0.5,
    });
    expect(JSON.parse(output)).toMatchObject({
      maximumUsageUsd: 0.5,
      status: 'active',
    });
  });

  it('prints an exact safe resume command for paused and dry-run work', async () => {
    const status = vi.fn(() => ({
      ...ready,
      maximumUsageUsd: 0.5,
      pauseReason: 'run-budget',
      status: 'paused' as const,
    }));
    const service = fakeService({ status });

    const output = await executeContextBackfillCommand(['--status'], service);

    expect(JSON.parse(output)).toMatchObject({
      pauseReason: 'run-budget',
      resumeCommand: 'pnpm chief -- context-backfill --resume 7',
    });
  });

  it('validates the action and positive numeric run identifiers', async () => {
    const service = fakeService();

    await expect(
      executeContextBackfillCommand(['--resume', 'nope'], service),
    ).rejects.toThrow(/positive integer/u);
    await expect(
      executeContextBackfillCommand(['--status', '--dry-run'], service),
    ).rejects.toThrow(/exactly one action/u);
    await expect(
      executeContextBackfillCommand(['--activate'], service),
    ).rejects.toThrow(/missing --confirm-guild/u);
  });

  it('resumes or selects a specific status run', async () => {
    const resume = vi.fn(() => Promise.resolve(ready));
    const status = vi.fn(() => ready);
    const service = fakeService({ resume, status });

    await executeContextBackfillCommand(['--resume', '7'], service);
    await executeContextBackfillCommand(['--status', '--run-id', '7'], service);

    expect(resume).toHaveBeenCalledWith(7);
    expect(status).toHaveBeenCalledWith(7);
  });

  it('reports missing runs and forwards explicit dry-run replacement', async () => {
    const dryRun = vi.fn(() => Promise.resolve(ready));
    const service = fakeService({ dryRun, status: () => null });

    await executeContextBackfillCommand(['--dry-run', '--replace'], service);
    await expect(
      executeContextBackfillCommand(['--status'], service),
    ).rejects.toThrow(/no context backfill/u);

    expect(dryRun).toHaveBeenCalledWith({ replace: true });
  });
});

function fakeService(
  overrides: Partial<ContextBackfillCommandService> = {},
): ContextBackfillCommandService {
  return {
    activate: overrides.activate ?? vi.fn(() => ready),
    dryRun: overrides.dryRun ?? vi.fn(() => Promise.resolve(ready)),
    resume: overrides.resume ?? vi.fn(() => Promise.resolve(ready)),
    status: overrides.status ?? vi.fn(() => ready),
  };
}
