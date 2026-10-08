import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Run once over SSH before deploying the new baseline. Keep Chief stopped until
// deployment creates the fresh database; the archive is for manual rollback only.
const data = resolve(process.argv[2] ?? '/var/lib/chief');
if (!existsSync(join(data, 'chief.db')))
  throw new Error('Chief database missing');
execFileSync(
  'systemctl',
  [
    'stop',
    'chief-health.timer',
    'chief-backup.timer',
    'chief-monitoring.timer',
  ],
  { stdio: 'inherit' },
);
execFileSync(
  'systemctl',
  [
    'stop',
    'chief-health.service',
    'chief-backup.service',
    'chief-monitoring.service',
    'chief.service',
  ],
  { stdio: 'inherit' },
);
const archive = join(
  data,
  `pre-cutover-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
);
mkdirSync(archive, { mode: 0o700 });
for (const name of [
  'chief.db',
  'chief.db-wal',
  'chief.db-shm',
  'deploy.env',
  '.forget-journal-replay.receipt',
  'monitoring.json',
  'deployment-monitoring.json',
]) {
  const source = join(data, name);
  if (existsSync(source)) renameSync(source, join(archive, name));
}

process.stdout.write(
  `Archived previous database and deployment state: ${archive}\nDeploy the new image, then restart chief-health.timer, chief-backup.timer and chief-monitoring.timer.\n`,
);
