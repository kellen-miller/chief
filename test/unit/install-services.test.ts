import * as fs from 'node:fs';

import { afterEach, expect, it, vi } from 'vitest';

import * as hostState from '../../src/ops/host-state.ts';
import { installServices } from '../../src/ops/install-services.ts';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
vi.mock('../../src/ops/host-state.ts', () => ({
  atomicWrite: vi.fn(),
  execCommand: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it('upgrades older VMs without existing recovery-pruning units', () => {
  const units = new Map(
    ['chief', 'chief-health', 'chief-backup'].map((name) => [
      `/etc/systemd/system/${name}.service`,
      `[Service]\nExecStart=/opt/chief/${name}.sh\nRestart=on-failure\n`,
    ]),
  );
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
    const source = units.get(path.toString());
    if (source === undefined) throw new Error('unit missing');
    const encoding = typeof options === 'string' ? options : options?.encoding;

    return encoding === 'utf8' ? source : Buffer.from(source);
  });
  vi.spyOn(hostState, 'atomicWrite').mockImplementation((path, source) => {
    units.set(path, source);
  });
  const systemctl = vi.spyOn(hostState, 'execCommand').mockReturnValue('');

  installServices();

  expect(units.get('/etc/systemd/system/chief.service')).toContain(
    'cli.ts run-container\nRestart=on-failure',
  );
  expect(units.get('/etc/systemd/system/chief-health.service')).toContain(
    'cli.ts health-watchdog',
  );
  expect(units.get('/etc/systemd/system/chief-backup.service')).toContain(
    'cli.ts backup',
  );
  expect(
    units.get('/etc/systemd/system/chief-recovery-prune.service'),
  ).toContain('cli.ts prune-recovery');
  expect(units.get('/etc/systemd/system/chief-recovery-prune.timer')).toContain(
    'OnUnitActiveSec=1h',
  );
  expect(systemctl.mock.calls).toEqual([
    ['systemctl', ['daemon-reload']],
    ['systemctl', ['enable', '--now', 'chief-recovery-prune.timer']],
  ]);

  installServices();

  expect(units.get('/etc/systemd/system/chief.service')).toContain(
    'Restart=on-failure',
  );
});
