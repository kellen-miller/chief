import { readFileSync } from 'node:fs';

import { atomicWrite, execCommand } from './host-state.ts';

// Upgrade existing units without touching disk/bootstrap configuration or state.
export function installServices(): void {
  for (const [unit, command] of [
    ['chief', 'run-container'],
    ['chief-health', 'health-watchdog'],
    ['chief-backup', 'backup'],
    ['chief-recovery-prune', 'prune-recovery'],
  ] as const) {
    const path = `/etc/systemd/system/${unit}.service`;
    const source = readFileSync(path, 'utf8');
    if (!/^ExecStart=.+$/mu.test(source))
      throw new Error('service entrypoint missing');
    atomicWrite(
      path,
      source.replace(
        /^ExecStart=.+$/mu,
        `ExecStart=/opt/chief/node/bin/node /opt/chief/ops/cli.ts ${command}`,
      ),
      0o644,
    );
  }

  execCommand('systemctl', ['daemon-reload']);
}
