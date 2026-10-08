import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

import { atomicWrite, execCommand } from './host-state.ts';

export function installMonitoring(arguments_: readonly string[]): void {
  const [channel, guild, project] = arguments_;
  if (
    arguments_.length !== 3 ||
    !channel ||
    !guild ||
    !project ||
    !/^[0-9]{17,20}$/u.test(channel) ||
    !/^[0-9]{17,20}$/u.test(guild) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)
  )
    throw new Error('invalid monitoring configuration');
  mkdirSync('/etc/chief', { recursive: true, mode: 0o750 });
  atomicWrite(
    '/etc/chief/monitoring.env',
    `DISCORD_MONITORING_CHANNEL_ID=${channel}\nDISCORD_GUILD_ID=${guild}\nGCP_PROJECT_ID=${project}\nCHIEF_CONTEXT_TIME_ZONE=America/New_York\n`,
  );
  writeFileSync(
    '/etc/systemd/system/chief-monitoring.service',
    `[Unit]
Description=Report Chief health and errors to Discord
After=network-online.target var-lib-chief.mount
Wants=network-online.target
RequiresMountsFor=/var/lib/chief

[Service]
Type=oneshot
ExecStart=/opt/chief/node/bin/node /opt/chief/src/ops/cli.ts monitor
TimeoutStartSec=120
`,
  );
  writeFileSync(
    '/etc/systemd/system/chief-monitoring.timer',
    `[Unit]
Description=Check Chief monitoring every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
Unit=chief-monitoring.service

[Install]
WantedBy=timers.target
`,
  );
  chmodSync('/etc/systemd/system/chief-monitoring.service', 0o644);
  chmodSync('/etc/systemd/system/chief-monitoring.timer', 0o644);
  execCommand('systemctl', ['daemon-reload']);
  execCommand('systemctl', ['enable', '--now', 'chief-monitoring.timer']);
}
