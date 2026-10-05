import { readFileSync } from 'node:fs';

import { atomicWrite, execCommand } from './host-state.ts';

// Upgrade existing units without touching disk/bootstrap configuration or state.
export function installServices(): void {
  for (const [unit, command] of [
    ['chief', 'run-container'],
    ['chief-health', 'health-watchdog'],
    ['chief-backup', 'backup'],
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

  // These units were absent on older VMs. Own their definitions here so both
  // new-host bootstrap and existing-host deployment install the same timer.
  atomicWrite(
    '/etc/systemd/system/chief-recovery-prune.service',
    `[Unit]
Description=Prune expired Chief recovery artifacts

[Service]
Type=oneshot
ExecStart=/opt/chief/node/bin/node /opt/chief/ops/cli.ts prune-recovery
`,
    0o644,
  );
  atomicWrite(
    '/etc/systemd/system/chief-recovery-prune.timer',
    `[Unit]
Description=Prune Chief recovery artifacts hourly

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true
Unit=chief-recovery-prune.service

[Install]
WantedBy=timers.target
`,
    0o644,
  );
  execCommand('systemctl', ['daemon-reload']);
  execCommand('systemctl', ['enable', '--now', 'chief-recovery-prune.timer']);
}
