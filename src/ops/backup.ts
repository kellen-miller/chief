import {
  chmodSync,
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  atomicWrite,
  execCommand,
  hostPaths,
  installDatabase,
  privateDirectory,
  pruneRecoveryArtifacts,
  readEnvironment,
  requireImage,
  verifyImageCapability,
} from './host-state.ts';

export function backup(arguments_: readonly string[]): void {
  if (arguments_.length) {
    const [image, database, destination] = arguments_;
    if (!database || !destination || arguments_.length !== 3)
      throw new Error('backup requires IMAGE DATABASE DESTINATION');
    execCommand(
      'docker',
      [
        'run',
        '--rm',
        '--volume',
        `${dirname(database)}:${dirname(database)}`,
        requireImage(image),
        'backup',
        '--database',
        database,
        '--destination',
        destination,
      ],
      { inherit: true },
    );
    return;
  }

  const paths = hostPaths();
  const config = readEnvironment(paths.config);
  const bucket = config.CHIEF_BACKUP_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u.test(bucket))
    throw new Error('backup bucket required');
  execCommand('docker', ['inspect', 'chief']);
  const backupPath = execCommand('docker', [
    'exec',
    'chief',
    'node',
    'dist/cli.js',
    'backup',
    '--database',
    '/var/lib/chief/chief.db',
    '--destination',
    '/var/lib/chief/backups',
  ]).trim();
  if (!backupPath) throw new Error('backup path missing');
  execCommand('docker', [
    'exec',
    'chief',
    'node',
    'dist/cli.js',
    'verify-restore',
    '--backup',
    backupPath,
    '--require-migration',
    '0003_channel_context',
  ]);
  execCommand('gcloud', [
    'storage',
    'cp',
    backupPath,
    `gs://${bucket}/backups/`,
  ]);
}

export function restore(arguments_: readonly string[]): void {
  const [target, backupPath, database] = arguments_;
  if (!backupPath || !database || arguments_.length !== 3)
    throw new Error('restore requires IMAGE BACKUP DATABASE');
  const image = requireImage(target);
  const data = dirname(database);
  const statePath = join(data, 'deploy.env');
  const recovery = requireImage(readEnvironment(statePath).RECOVERY_IMAGE);
  const { uid, gid } = hostPaths();
  const container = [
    'run',
    '--rm',
    '--user',
    `${String(uid)}:${String(gid)}`,
    '--volume',
    `${data}:${data}`,
    recovery,
  ];
  execCommand('docker', [
    ...container,
    'verify-restore',
    '--backup',
    backupPath,
  ]);
  const capability = execCommand('docker', [
    ...container,
    'database-capability',
    '--database',
    backupPath,
  ]).trim();
  verifyImageCapability(capability, image);
  execCommand('systemctl', ['stop', 'chief.service'], { timeout: 120_000 });
  if (existsSync(database)) {
    const failed = `${database}.failed.${String(Date.now())}`;
    renameSync(database, failed);
    chmodSync(failed, 0o600);
  }

  installDatabase(backupPath, database, uid, gid);
  rmSync(`${database}-wal`, { force: true });
  rmSync(`${database}-shm`, { force: true });
  atomicWrite(statePath, `IMAGE=${image}\nRECOVERY_IMAGE=${recovery}\n`);
  pruneRecoveryArtifacts(data);
  execCommand('systemctl', ['start', 'chief.service'], { timeout: 120_000 });
}

export function restoreDrill(arguments_: readonly string[]): void {
  const [target, backupPath, directory] = arguments_;
  if (!backupPath || !directory || arguments_.length !== 3)
    throw new Error('restore-drill requires IMAGE BACKUP WORKDIR');
  const image = requireImage(target);
  privateDirectory(directory);
  const database = join(directory, 'drill.db');
  copyFileSync(backupPath, database);
  chmodSync(database, 0o600);
  execCommand('docker', [
    'run',
    '--rm',
    '--user',
    `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
    '--volume',
    `${directory}:${directory}`,
    image,
    'verify-restore',
    '--backup',
    database,
    '--require-migration',
    '0003_channel_context',
  ]);
  process.stdout.write('restore drill passed\n');
}
