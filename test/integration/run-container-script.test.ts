import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const recovery = `registry/chief@sha256:${'b'.repeat(64)}`;
const target = `registry/chief@sha256:${'a'.repeat(64)}`;
const runContainerScript = resolve('scripts/run-container.sh');

describe('container startup recovery preflight', () => {
  it('replays before secrets and skips an unchanged receipt', async () => {
    const fixture = await createFixture();
    const preDeploy = join(fixture.data, 'pre-deploy');
    const expiredBackup = join(preDeploy, 'expired.db');
    const freshBackup = join(preDeploy, 'fresh.db');
    const expiredFailed = join(fixture.data, 'chief.db.failed.expired');
    await mkdir(preDeploy);
    await writeFile(expiredBackup, 'expired');
    await writeFile(freshBackup, 'fresh');
    await writeFile(expiredFailed, 'expired');
    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(expiredBackup, expiredAt, expiredAt);
    await utimes(expiredFailed, expiredAt, expiredAt);

    const first = await runContainer(fixture);
    expect(first.stderr).toBe('');
    expect(first.code, first.stderr).toBe(0);
    expect((await runContainer(fixture)).code).toBe(0);

    const commands = await readFile(fixture.commandLog, 'utf8');
    const firstReplay = commands.indexOf(
      `docker run --rm --user ${fixture.uid}:${fixture.gid}`,
    );
    expect(firstReplay).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf(recovery, firstReplay)).toBeGreaterThan(
      firstReplay,
    );
    expect(
      commands.indexOf('recover-forget-journals', firstReplay),
    ).toBeGreaterThan(firstReplay);
    expect(commands.indexOf('gcloud secrets', firstReplay)).toBeGreaterThan(
      commands.indexOf('recover-forget-journals', firstReplay),
    );
    expect(
      commands.indexOf(target, commands.indexOf('gcloud secrets')),
    ).toBeGreaterThan(commands.indexOf('gcloud secrets'));
    expect(commands.match(/recover-forget-journals/gu)).toHaveLength(1);
    expect(
      (await stat(join(fixture.data, '.forget-journal-replay.receipt'))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(fixture.runtime, 'forget-journal'))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await stat(join(fixture.runtime, 'forget-journal', 'entry.json'))).mode &
        0o777,
    ).toBe(0o600);
    await expect(access(expiredBackup)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(expiredFailed)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(freshBackup)).resolves.toBeUndefined();
  });

  it('fails closed before secrets when listing or replay fails', async () => {
    for (const failure of ['list', 'replay'] as const) {
      const fixture = await createFixture();
      const result = await runContainer(fixture, failure);
      expect(result.code).not.toBe(0);
      const commands = await readFile(fixture.commandLog, 'utf8');
      expect(commands).not.toContain('gcloud secrets');
      expect(commands).not.toContain(`docker run --name chief`);
      expect(commands).toContain('logger -t chief');
    }
  });
});

async function createFixture(): Promise<{
  readonly bin: string;
  readonly commandLog: string;
  readonly config: string;
  readonly data: string;
  readonly deployState: string;
  readonly gid: string;
  readonly journal: string;
  readonly runtime: string;
  readonly uid: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'chief-container-test-'));
  const bin = join(root, 'bin');
  const commandLog = join(root, 'commands.log');
  const config = join(root, 'chief.env');
  const data = join(root, 'data');
  const deployState = join(data, 'deploy.env');
  const journal = join(root, 'entry.json');
  const runtime = join(root, 'run');
  const uid =
    typeof process.getuid === 'function' ? process.getuid().toString() : '1000';
  const gid =
    typeof process.getgid === 'function' ? process.getgid().toString() : '1000';
  await mkdir(bin);
  await mkdir(data);
  await writeFile(commandLog, '');
  await writeFile(join(data, 'chief.db'), 'database');
  await writeFile(journal, '{"schemaVersion":1}\n');
  await writeFile(
    config,
    `CHIEF_BACKUP_BUCKET=chief-backups\nCHIEF_DATA_DIR=${data}\nGCP_PROJECT_ID=chief-project\n`,
  );
  await writeFile(deployState, `IMAGE=${target}\nRECOVERY_IMAGE=${recovery}\n`);
  await executable(
    join(bin, 'gcloud'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s\n' "$*" >>"$COMMAND_LOG"
if [[ "$1 $2" == 'storage ls' ]]; then
  [[ "\${FAIL_LIST:-0}" == 1 ]] && exit 1
  printf 'gs://chief-backups/forget-journal/entry.json\n'
elif [[ "$1 $2" == 'storage cp' ]]; then
  cp "$JOURNAL_SOURCE" "\${@: -1}"
elif [[ "$1" == secrets ]]; then
  printf secret
fi
`,
  );
  await executable(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
if [[ " $* " == *' recover-forget-journals '* ]] && [[ "\${FAIL_REPLAY:-0}" == 1 ]]; then
  exit 1
fi
exit 0
`,
  );
  await executable(
    join(bin, 'curl'),
    '#!/usr/bin/env bash\nprintf chief-project\n',
  );
  await executable(
    join(bin, 'logger'),
    '#!/usr/bin/env bash\nprintf \'logger %s\\n\' "$*" >>"$COMMAND_LOG"\n',
  );
  return {
    bin,
    commandLog,
    config,
    data,
    deployState,
    gid,
    journal,
    runtime,
    uid,
  };
}

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function runContainer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  failure?: 'list' | 'replay',
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [runContainerScript], {
      env: {
        ...process.env,
        CHIEF_CONFIG_FILE: fixture.config,
        CHIEF_DATA_GID: fixture.gid,
        CHIEF_DATA_UID: fixture.uid,
        CHIEF_DEPLOY_STATE_FILE: fixture.deployState,
        CHIEF_RUNTIME_DIR: fixture.runtime,
        COMMAND_LOG: fixture.commandLog,
        FAIL_LIST: failure === 'list' ? '1' : '0',
        FAIL_REPLAY: failure === 'replay' ? '1' : '0',
        JOURNAL_SOURCE: fixture.journal,
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
