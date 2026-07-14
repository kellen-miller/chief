import { spawn } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const recovery = `registry/chief@sha256:${'b'.repeat(64)}`;
const target = `registry/chief@sha256:${'a'.repeat(64)}`;
const restoreScript = resolve('scripts/restore.sh');

describe('restore transaction', () => {
  it('restores the target image with the retained recovery digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chief-restore-test-'));
    const bin = join(root, 'bin');
    const data = join(root, 'data');
    const backup = join(data, 'backup.db');
    const database = join(data, 'chief.db');
    const log = join(root, 'commands.log');
    await mkdir(bin);
    await mkdir(data);
    await writeFile(database, 'failed candidate');
    await writeFile(backup, 'compatible backup');
    await writeFile(
      join(data, 'deploy.env'),
      `IMAGE=${recovery}\nRECOVERY_IMAGE=${recovery}\n`,
    );
    await executable(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
if [[ "$1 $2" == 'image inspect' ]]; then
  printf '0003_channel_context\n'
elif [[ " $* " == *' database-capability '* ]]; then
  printf '0003_channel_context\n'
fi
`,
    );
    await executable(
      join(bin, 'systemctl'),
      '#!/usr/bin/env bash\nprintf \'systemctl %s\\n\' "$*" >>"$COMMAND_LOG"\n',
    );

    const result = await run(restoreScript, [target, backup, database], {
      ...process.env,
      CHIEF_DATA_GID:
        typeof process.getgid === 'function'
          ? process.getgid().toString()
          : '1000',
      CHIEF_DATA_UID:
        typeof process.getuid === 'function'
          ? process.getuid().toString()
          : '1000',
      COMMAND_LOG: log,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });

    expect(result).toBe(0);
    expect(await readFile(database, 'utf8')).toBe('compatible backup');
    expect(await readFile(join(data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${target}\nRECOVERY_IMAGE=${recovery}\n`,
    );
    const failed = (await import('node:fs/promises'))
      .readdir(data)
      .then((names) =>
        names.find((name) => name.startsWith('chief.db.failed.')),
      );
    const failedName = await failed;
    expect(failedName).toBeDefined();
    expect((await stat(join(data, failedName ?? 'missing'))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readFile(log, 'utf8')).toContain(
      `${recovery} verify-restore --backup ${backup}`,
    );
  });

  it('refuses a context database for an incompatible target image', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'chief-restore-capability-test-'),
    );
    const bin = join(root, 'bin');
    const data = join(root, 'data');
    const backup = join(data, 'backup.db');
    const database = join(data, 'chief.db');
    const log = join(root, 'commands.log');
    await mkdir(bin);
    await mkdir(data);
    await writeFile(database, 'active database');
    await writeFile(backup, 'context backup');
    await writeFile(
      join(data, 'deploy.env'),
      `IMAGE=${recovery}\nRECOVERY_IMAGE=${recovery}\n`,
    );
    await executable(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
if [[ "$1 $2" == 'image inspect' ]]; then
  printf '0002_conversation_events\n'
elif [[ " $* " == *' database-capability '* ]]; then
  printf '0003_channel_context\n'
fi
`,
    );
    await executable(
      join(bin, 'systemctl'),
      '#!/usr/bin/env bash\nprintf \'systemctl %s\\n\' "$*" >>"$COMMAND_LOG"\n',
    );

    const result = await run(restoreScript, [target, backup, database], {
      ...process.env,
      CHIEF_DATA_GID:
        typeof process.getgid === 'function'
          ? process.getgid().toString()
          : '1000',
      CHIEF_DATA_UID:
        typeof process.getuid === 'function'
          ? process.getuid().toString()
          : '1000',
      COMMAND_LOG: log,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });

    expect(result).not.toBe(0);
    expect(await readFile(database, 'utf8')).toBe('active database');
    expect(await readFile(log, 'utf8')).not.toContain('systemctl stop');
  });
});

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function run(
  script: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [script, ...arguments_], {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
}
