import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const candidate = `registry/chief@sha256:${'b'.repeat(64)}`;
const previous = `registry/chief@sha256:${'a'.repeat(64)}`;
const deployScript = resolve('scripts/deploy.sh');

describe('deploy transaction', () => {
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
    const commands = await readFile(fixture.commandLog, 'utf8');
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
    expect(dockerConfig.startsWith(`${fixture.runtime}/docker-config.`)).toBe(
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
  readonly failCandidate?: boolean;
  readonly failMigration?: boolean;
  readonly failPrune?: boolean;
  readonly failTag?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
  readonly bin: string;
  readonly commandLog: string;
  readonly data: string;
  readonly failCandidate: boolean;
  readonly failMigration: boolean;
  readonly failPrune: boolean;
  readonly failTag: boolean;
  readonly runtime: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'chief-deploy-test-'));
  const bin = join(root, 'bin');
  const commandLog = join(root, 'commands.log');
  const data = join(root, 'data');
  const runtime = join(root, 'run');
  await mkdir(bin);
  await mkdir(data);
  await mkdir(runtime);
  await writeFile(join(data, 'chief.db'), 'original');
  await writeFile(join(data, 'deploy.env'), `IMAGE=${previous}\n`);
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
  await executable(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n');
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
    data,
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

async function runDeploy(fixture: {
  readonly bin: string;
  readonly commandLog: string;
  readonly data: string;
  readonly failCandidate: boolean;
  readonly failMigration: boolean;
  readonly failPrune: boolean;
  readonly failTag: boolean;
  readonly runtime: string;
}): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [deployScript, '--image', candidate], {
      env: {
        ...process.env,
        CHIEF_DATA_GID:
          typeof process.getgid === 'function'
            ? process.getgid().toString()
            : '1000',
        CHIEF_DATA_DIR: fixture.data,
        CHIEF_DATA_UID:
          typeof process.getuid === 'function'
            ? process.getuid().toString()
            : '1000',
        CHIEF_RUNTIME_DIR: fixture.runtime,
        COMMAND_LOG: fixture.commandLog,
        DOCKER_CONFIG: '',
        FAIL_CANDIDATE: fixture.failCandidate ? '1' : '0',
        FAIL_MIGRATION: fixture.failMigration ? '1' : '0',
        FAIL_PRUNE: fixture.failPrune ? '1' : '0',
        FAIL_TAG: fixture.failTag ? '1' : '0',
        PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolvePromise({ code, stderr });
    });
  });
}
