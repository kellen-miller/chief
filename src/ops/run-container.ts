import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  atomicWrite,
  databaseChecksum,
  execCommand,
  hostPaths,
  privateDirectory,
  pruneRecoveryArtifacts,
  readEnvironment,
  requireImage,
  verifyImageCapability,
} from './host-state.ts';

export function runContainer(): void {
  const initial = hostPaths();
  const config = readEnvironment(initial.config);
  const state = readEnvironment(
    process.env.CHIEF_DEPLOY_STATE_FILE ?? join(initial.data, 'deploy.env'),
  );
  const paths = { ...initial, data: config.CHIEF_DATA_DIR ?? initial.data };
  const image = requireImage(state.IMAGE);
  const recovery = requireImage(state.RECOVERY_IMAGE);
  const database = join(paths.data, 'chief.db');
  const receipt = join(paths.data, '.forget-journal-replay.receipt');
  const journalDirectory = join(paths.runtime, 'forget-journal');
  const manifestPath = join(paths.runtime, 'forget-journal.manifest');
  const bucket = config.CHIEF_BACKUP_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u.test(bucket))
    throw new Error('backup bucket required');
  pruneRecoveryArtifacts(paths.data);
  rmSync(journalDirectory, { recursive: true, force: true });
  privateDirectory(journalDirectory, paths.uid, paths.gid);
  const project =
    config.GCP_PROJECT_ID ??
    execCommand('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '2',
      '--max-time',
      '5',
      '--header',
      'Metadata-Flavor: Google',
      'http://metadata.google.internal/computeMetadata/v1/project/project-id',
    ]).trim();
  const objects = [
    ...new Set(
      execCommand('gcloud', [
        'storage',
        'ls',
        '--all-versions',
        '--recursive',
        `gs://${bucket}/`,
      ])
        .split('\n')
        .filter((object) =>
          object.startsWith(`gs://${bucket}/forget-journal/`),
        ),
    ),
  ].sort();
  let manifest = '';
  for (const object of objects) {
    const match =
      /^gs:\/\/[^/]+\/forget-journal\/([^/#]+)\.json#([0-9]+)$/u.exec(object);
    if (!match?.[1] || !match[2] || ['.', '..'].includes(match[1]))
      throw new Error('invalid journal manifest');
    const destination = join(
      journalDirectory,
      `${match[1]}.generation-${match[2]}.json`,
    );
    execCommand('gcloud', ['storage', 'cp', object, destination]);
    chownSync(destination, paths.uid, paths.gid);
    chmodSync(destination, 0o600);
    manifest += `journal=${object} sha256=${createHash('sha256').update(readFileSync(destination)).digest('hex')}\n`;
  }

  atomicWrite(manifestPath, manifest);
  const manifestChecksum = createHash('sha256').update(manifest).digest('hex');
  const expected = `database=${databaseChecksum(database)}\nmanifest=${manifestChecksum}\n${manifest}`;
  const container = [
    'run',
    '--rm',
    '--user',
    `${String(paths.uid)}:${String(paths.gid)}`,
    '--volume',
    `${paths.data}:${paths.data}`,
  ];
  if (
    !existsSync(receipt) ||
    readFileSync(receipt, 'utf8').trimEnd() !== expected.trimEnd()
  ) {
    execCommand(
      'docker',
      [
        ...container,
        '--volume',
        `${journalDirectory}:/run/chief/forget-journal:ro`,
        recovery,
        'recover-forget-journals',
        '--database',
        database,
        '--journal-directory',
        '/run/chief/forget-journal',
      ],
      { timeout: 120_000 },
    );
    atomicWrite(
      receipt,
      `database=${databaseChecksum(database)}\nmanifest=${manifestChecksum}\n${manifest}`,
    );
    chownSync(receipt, paths.uid, paths.gid);
  }

  const capability = execCommand(
    'docker',
    [...container, recovery, 'database-capability', '--database', database],
    { timeout: 120_000 },
  ).trim();
  verifyImageCapability(capability, image);
  // Recovery and image compatibility must succeed before retrieving credentials.
  const discordToken = execCommand('gcloud', [
    'secrets',
    'versions',
    'access',
    'latest',
    `--project=${project}`,
    '--secret=chief-discord-token',
  ]).trim();
  const openaiKey = execCommand('gcloud', [
    'secrets',
    'versions',
    'access',
    'latest',
    `--project=${project}`,
    '--secret=chief-openai-api-key',
  ]).trim();
  if (
    [discordToken, openaiKey].some((value) => !value || /[\r\n]/u.test(value))
  )
    throw new Error('invalid credential');
  const runtimeEnvironment = join(paths.runtime, 'runtime.env');
  atomicWrite(
    runtimeEnvironment,
    `${readFileSync(initial.config, 'utf8').trimEnd()}\nDISCORD_TOKEN=${discordToken}\nOPENAI_API_KEY=${openaiKey}\n`,
  );
  execCommand('docker', ['rm', '--force', 'chief'], { allowFailure: true });
  execCommand(
    'docker',
    [
      'run',
      '--name',
      'chief',
      '--env-file',
      runtimeEnvironment,
      '--publish',
      '127.0.0.1:8080:8080',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--volume',
      `${paths.data}:/var/lib/chief`,
      image,
    ],
    { inherit: true, timeout: 0 },
  );
}
