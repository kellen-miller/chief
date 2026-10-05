import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { deploy } from '../../src/ops/deploy.ts';

const candidate = `registry/chief@sha256:${'b'.repeat(64)}`;
const previous = `registry/chief@sha256:${'a'.repeat(64)}`;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('deploy transaction', { timeout: 20_000 }, () => {
  it('syncs the backup bucket before starting the service', async () => {
    const fixture = await createFixture();
    const result = await runDeploy(fixture);

    expect(result.code).toBe(0);
    expect(await readFile(fixture.config, 'utf8')).toBe(
      'EXISTING_SETTING=preserved\nCHIEF_BACKUP_BUCKET=chief-backups\n',
    );
  });

  it('accepts a healthy immutable candidate', async () => {
    const fixture = await createFixture();
    const result = await runDeploy(fixture);

    expect(result.code).toBe(0);
    expect(await readFile(join(fixture.data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${candidate}\nRECOVERY_IMAGE=${candidate}\n`,
    );
    expect(await readFile(join(fixture.data, 'chief.db'), 'utf8')).toBe(
      'migrated',
    );
    const maintenance = JSON.parse(
      await readFile(join(fixture.data, 'deployment-monitoring.json'), 'utf8'),
    ) as { started: number; ended: number; status: string };
    expect(maintenance.status).toBe(result.code === 0 ? 'completed' : 'failed');
    expect(maintenance.ended).toBeGreaterThanOrEqual(maintenance.started);
    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).toContain('maintenance-active-after-runtime-removal');
    expect(commands.indexOf('docker logout')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('docker logout')).toBeLessThan(
      commands.indexOf('docker login'),
    );
    expect(commands.indexOf('docker login')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('docker login')).toBeLessThan(
      commands.indexOf('docker pull'),
    );
    expect(commands).toContain(
      'verify-restore --backup ' +
        join(fixture.data, 'chief.db') +
        ' --require-migration 0003_channel_context',
    );
    const login = commands
      .split('\n')
      .find((command) => command.startsWith('docker login'));
    const dockerConfig = / config=(.+)$/u.exec(login ?? '')?.[1] ?? '';
    expect(dockerConfig.startsWith(`${fixture.data}/.docker-config.`)).toBe(
      true,
    );
    expect(dockerConfig).not.toBe('');
    await expect(access(dockerConfig)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const rollbackTag = `docker image tag ${previous} chief:rollback`;
    const prune = 'docker image prune --force';
    expect(commands).toContain(rollbackTag);
    expect(commands.indexOf(rollbackTag)).toBeLessThan(commands.indexOf(prune));
  });

  it('restores the old digest and database when candidate health fails', async () => {
    const fixture = await createFixture({ failCandidate: true });
    const result = await runDeploy(fixture);

    expect(result.code).not.toBe(0);
    expect(await readFile(join(fixture.data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${previous}\nRECOVERY_IMAGE=${candidate}\n`,
    );
    expect(await readFile(join(fixture.data, 'chief.db'), 'utf8')).toBe(
      'original',
    );
    const maintenance = JSON.parse(
      await readFile(join(fixture.data, 'deployment-monitoring.json'), 'utf8'),
    ) as { started: number; ended: number; status: string };
    expect(maintenance.status).toBe(result.code === 0 ? 'completed' : 'failed');
    expect(maintenance.ended).toBeGreaterThanOrEqual(maintenance.started);
    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).not.toContain('docker image tag');
    expect(commands).not.toContain('docker image prune');
  });

  it('keeps a healthy deploy when rollback tagging fails', async () => {
    const fixture = await createFixture({ failTag: true });
    const result = await runDeploy(fixture);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('chief_image_cleanup_failed');
    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).toContain(`docker image tag ${previous} chief:rollback`);
    expect(commands).not.toContain('docker image prune');
  });

  it('keeps the rollback tag when image pruning fails', async () => {
    const fixture = await createFixture({ failPrune: true });
    const result = await runDeploy(fixture);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      '{"msg":"chief_image_cleanup_failed","stage":"prune"}',
    );
    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).toContain(`docker image tag ${previous} chief:rollback`);
    expect(commands).toContain('docker image prune --force');
  });

  it('never starts the old image against a new database without a backup', async () => {
    const fixture = await createFixture({ failCandidate: true });
    await (
      await import('node:fs/promises')
    ).unlink(join(fixture.data, 'chief.db'));

    const result = await runDeploy(fixture);

    expect(result.code).not.toBe(0);
    await expect(access(join(fixture.data, 'chief.db'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await (await import('node:fs/promises')).readdir(fixture.data)).some(
        (name) => name.startsWith('chief.db.failed.'),
      ),
    ).toBe(true);
  });

  it('restarts the prior service when pre-migration backup fails', async () => {
    const fixture = await createFixture({ failBackup: true });
    const result = await runDeploy(fixture);
    expect(result.code).not.toBe(0);
    expect(await readFile(join(fixture.data, 'chief.db'), 'utf8')).toBe(
      'original',
    );
    expect(await readFile(join(fixture.data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${previous}\nRECOVERY_IMAGE=${candidate}\n`,
    );
    expect(
      JSON.parse(
        await readFile(
          join(fixture.data, 'deployment-monitoring.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'failed' });
    expect(await readFile(fixture.commandLog, 'utf8')).not.toContain(
      'migrate --database',
    );
  });

  it('rejects mutable images and malformed flags before host changes', () => {
    for (const args of [
      ['--image', 'chief:latest'],
      ['--unknown', candidate],
      ['--image'],
    ])
      expect(() => {
        deploy(args);
      }).toThrow();
    expect(() => {
      deploy(['--image', candidate, '--backup-bucket', 'BAD/BUCKET']);
    }).toThrow('backup bucket');
  });

  it('restores the old database when migration fails after a partial commit', async () => {
    const fixture = await createFixture({ failMigration: true });

    const result = await runDeploy(fixture);

    expect(result.code).not.toBe(0);
    expect(await readFile(join(fixture.data, 'chief.db'), 'utf8')).toBe(
      'original',
    );
    expect(await readFile(join(fixture.data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${previous}\nRECOVERY_IMAGE=${candidate}\n`,
    );
  });
});

interface FixtureOptions {
  readonly failBackup?: boolean;
  readonly failCandidate?: boolean;
  readonly failMigration?: boolean;
  readonly failPrune?: boolean;
  readonly failTag?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
  readonly bin: string;
  readonly commandLog: string;
  readonly config: string;
  readonly data: string;
  readonly failBackup: boolean;
  readonly failCandidate: boolean;
  readonly failMigration: boolean;
  readonly failPrune: boolean;
  readonly failTag: boolean;
  readonly runtime: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'chief-deploy-test-'));
  const bin = join(root, 'bin');
  const commandLog = join(root, 'commands.log');
  const config = join(root, 'chief.env');
  const data = join(root, 'data');
  const runtime = join(root, 'run');
  await mkdir(bin);
  await mkdir(data);
  await mkdir(runtime);
  await writeFile(join(data, 'chief.db'), 'original');
  await writeFile(join(data, 'deploy.env'), `IMAGE=${previous}\n`);
  await writeFile(config, 'EXISTING_SETTING=preserved\n');
  await executable(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
command_name="\${1:-}"
shift || true
printf 'docker %s %s config=%s\n' "$command_name" "$*" "\${DOCKER_CONFIG:-}" >>"$COMMAND_LOG"
case "$command_name" in
  login) cat >/dev/null; exit 0 ;;
  pull|stop) exit 0 ;;
  image)
    if [[ "\${1:-}" == tag && "\${FAIL_TAG:-0}" == 1 ]]; then exit 1; fi
    if [[ "\${1:-}" == prune && "\${FAIL_PRUNE:-0}" == 1 ]]; then exit 1; fi
    exit 0
    ;;
  run)
    args=" $* "
    database=""
    destination=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == --database ]]; then database="$argument"; fi
      if [[ "$previous" == --destination ]]; then destination="$argument"; fi
      previous="$argument"
    done
    if [[ "$args" == *" backup "* ]]; then
      if [[ "\${FAIL_BACKUP:-0}" == 1 ]]; then exit 1; fi
      mkdir -p "$destination"
      cp "$database" "$destination/backup.db"
      printf '%s\\n' "$destination/backup.db"
    elif [[ "$args" == *" migrate "* ]]; then
      if [[ "\${FAIL_MIGRATION:-0}" == 1 ]]; then
        printf '%s' partially-migrated >"$database"
        exit 1
      fi
      printf '%s' migrated >"$database"
    fi
    ;;
esac
`,
  );
  await executable(join(bin, 'gcloud'), '#!/usr/bin/env bash\nprintf token\n');
  await executable(
    join(bin, 'systemctl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == stop ]]; then
  rm -rf "$CHIEF_RUNTIME_DIR"
  mkdir -p "$CHIEF_RUNTIME_DIR"
  if grep -q '"status":"active"' "$CHIEF_DATA_DIR/deployment-monitoring.json"; then
    printf 'maintenance-active-after-runtime-removal\\n' >>"$COMMAND_LOG"
  fi
fi
exit 0
`,
  );
  await executable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAIL_CANDIDATE:-0}" == 1 ]] && grep -qF 'IMAGE=${candidate}' "\${CHIEF_DATA_DIR}/deploy.env"; then
  exit 1
fi
exit 0
`,
  );
  return {
    bin,
    commandLog,
    config,
    data,
    failBackup: options.failBackup ?? false,
    failCandidate: options.failCandidate ?? false,
    failMigration: options.failMigration ?? false,
    failPrune: options.failPrune ?? false,
    failTag: options.failTag ?? false,
    runtime,
  };
}

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function runDeploy(fixture: {
  readonly bin: string;
  readonly commandLog: string;
  readonly config: string;
  readonly data: string;
  readonly failBackup: boolean;
  readonly failCandidate: boolean;
  readonly failMigration: boolean;
  readonly failPrune: boolean;
  readonly failTag: boolean;
  readonly runtime: string;
}): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const environment = {
    CHIEF_CONFIG_FILE: fixture.config,
    CHIEF_DATA_GID: process.getgid?.().toString() ?? '1000',
    CHIEF_DATA_DIR: fixture.data,
    CHIEF_DATA_UID: process.getuid?.().toString() ?? '1000',
    CHIEF_RUNTIME_DIR: fixture.runtime,
    COMMAND_LOG: fixture.commandLog,
    DOCKER_CONFIG: '',
    FAIL_BACKUP: fixture.failBackup ? '1' : '0',
    FAIL_CANDIDATE: fixture.failCandidate ? '1' : '0',
    FAIL_MIGRATION: fixture.failMigration ? '1' : '0',
    FAIL_PRUNE: fixture.failPrune ? '1' : '0',
    FAIL_TAG: fixture.failTag ? '1' : '0',
    PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
  };
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    deploy(['--image', candidate, '--backup-bucket', 'chief-backups']);
    return Promise.resolve({ code: 0, stderr });
  } catch (error) {
    return Promise.resolve({
      code: 1,
      stderr: stderr + (error instanceof Error ? error.message : 'failed'),
    });
  }
}
