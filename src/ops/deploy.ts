import {
  existsSync,
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  atomicWrite,
  execCommand,
  hostPaths,
  installDatabase,
  privateDirectory,
  pruneRecoveryArtifacts,
  readEnvironment,
  requireImage,
} from './host-state.ts';

export function deploy(arguments_: readonly string[]): void {
  const flags: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !key ||
      !value ||
      !['--image', '--backup-bucket'].includes(key) ||
      flags[key]
    )
      throw new Error('invalid deployment arguments');
    flags[key] = value;
  }

  const image = requireImage(flags['--image']);
  const bucket = flags['--backup-bucket'];
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u.test(bucket))
    throw new Error('valid backup bucket required');
  const paths = hostPaths();
  const statePath = join(paths.data, 'deploy.env');
  const database = join(paths.data, 'chief.db');
  const monitoring = join(paths.data, 'deployment-monitoring.json');
  const previous = existsSync(statePath)
    ? readEnvironment(statePath).IMAGE
    : undefined;
  if (previous) requireImage(previous);
  const config = readEnvironment(paths.config);
  config.CHIEF_BACKUP_BUCKET = bucket;
  atomicWrite(
    paths.config,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    0o640,
  );
  const registry = image.split('/')[0];
  if (!registry) throw new Error('image registry required');
  execCommand('docker', ['logout', registry], { allowFailure: true });
  privateDirectory(paths.runtime);
  // systemd owns /run/chief and removes it on stop. Auth must survive that stop.
  const dockerConfig = mkdtempSync(join(paths.data, '.docker-config.'));
  process.env.DOCKER_CONFIG = dockerConfig;
  let started: number | undefined;
  let completed = false;
  let backup: string | undefined;
  let migrated = false;
  const container = [
    'run',
    '--rm',
    '--user',
    `${String(paths.uid)}:${String(paths.gid)}`,
    '--volume',
    `${paths.data}:${paths.data}`,
    image,
  ];
  try {
    const token = execCommand('gcloud', ['auth', 'print-access-token']).trim();
    execCommand(
      'docker',
      [
        'login',
        '--username',
        'oauth2accesstoken',
        '--password-stdin',
        registry,
      ],
      { input: token },
    );
    execCommand('docker', ['pull', image], { timeout: 300_000 });
    started = Math.floor(Date.now() / 1000);
    atomicWrite(monitoring, JSON.stringify({ started, status: 'active' }));
    try {
      execCommand('systemctl', ['stop', 'chief.service'], {
        allowFailure: true,
        timeout: 120_000,
      });
      execCommand('docker', ['stop', '--time', '20', 'chief'], {
        allowFailure: true,
      });
      if (existsSync(database)) {
        backup = execCommand(
          'docker',
          [
            ...container,
            'backup',
            '--database',
            database,
            '--destination',
            join(paths.data, 'pre-deploy'),
          ],
          { timeout: 120_000 },
        ).trim();
        if (!backup) throw new Error('backup path missing');
        execCommand(
          'docker',
          [...container, 'verify-restore', '--backup', backup],
          { timeout: 120_000 },
        );
      }

      migrated = true;
      execCommand('docker', [...container, 'migrate', '--database', database], {
        timeout: 120_000,
      });
      execCommand(
        'docker',
        [
          ...container,
          'verify-restore',
          '--backup',
          database,
          '--require-migration',
          'chief-v1',
        ],
        { timeout: 120_000 },
      );
      atomicWrite(statePath, `IMAGE=${image}\nRECOVERY_IMAGE=${image}\n`);
      execCommand('systemctl', ['start', 'chief.service'], {
        timeout: 120_000,
      });
      let healthy = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          execCommand('curl', [
            '--fail',
            '--silent',
            '--max-time',
            '3',
            'http://127.0.0.1:8080/healthz',
          ]);
          healthy = true;
          break;
        } catch {
          execCommand('sleep', ['2']);
        }
      }

      if (!healthy) throw new Error('candidate failed readiness');
    } catch (error) {
      execCommand('systemctl', ['stop', 'chief.service'], {
        allowFailure: true,
        timeout: 120_000,
      });
      execCommand('docker', ['stop', '--time', '5', 'chief'], {
        allowFailure: true,
      });
      if (migrated) {
        if (existsSync(database)) {
          const failed = `${database}.failed.${String(Date.now())}`;
          renameSync(database, failed);
          chmodSync(failed, 0o600);
        }

        rmSync(`${database}-wal`, { force: true });
        rmSync(`${database}-shm`, { force: true });
        if (backup) installDatabase(backup, database, paths.uid, paths.gid);
      }

      if (previous) {
        atomicWrite(statePath, `IMAGE=${previous}\nRECOVERY_IMAGE=${image}\n`);
        pruneRecoveryArtifacts(paths.data);
        execCommand('systemctl', ['start', 'chief.service'], {
          timeout: 120_000,
        });
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            execCommand('curl', [
              '--fail',
              '--silent',
              '--max-time',
              '3',
              'http://127.0.0.1:8080/healthz',
            ]);
            break;
          } catch {
            execCommand('sleep', ['2']);
          }
        }
      }

      throw error;
    }

    let cleanupReady = true;
    if (previous && previous !== image) {
      try {
        execCommand('docker', ['image', 'tag', previous, 'chief:rollback']);
      } catch {
        process.stderr.write(
          '{"msg":"chief_image_cleanup_failed","stage":"rollback_tag"}\n',
        );
        cleanupReady = false;
      }
    }

    if (cleanupReady) {
      try {
        execCommand('docker', ['image', 'prune', '--force']);
      } catch {
        process.stderr.write(
          '{"msg":"chief_image_cleanup_failed","stage":"prune"}\n',
        );
      }
    }

    pruneRecoveryArtifacts(paths.data);
    completed = true;
    process.stdout.write(
      `${JSON.stringify({ msg: 'chief_deploy_succeeded', image })}\n`,
    );
  } finally {
    if (started !== undefined)
      atomicWrite(
        monitoring,
        JSON.stringify({
          started,
          ended: Math.floor(Date.now() / 1000),
          status: completed ? 'completed' : 'failed',
        }),
      );
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}
