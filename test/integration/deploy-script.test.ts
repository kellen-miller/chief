import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const candidate = `registry/chief@sha256:${'b'.repeat(64)}`;
const previous = `registry/chief@sha256:${'a'.repeat(64)}`;
const deployScript = resolve('scripts/deploy.sh');

describe('deploy transaction', () => {
  it('accepts a healthy immutable candidate', async () => {
    const fixture = await createFixture(false);
    const result = await runDeploy(fixture);

    expect(result.code).toBe(0);
    expect(await readFile(join(fixture.data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${candidate}\n`,
    );
    expect(await readFile(join(fixture.data, 'chief.db'), 'utf8')).toBe(
      'migrated',
    );
  });

  it('restores the old digest and database when candidate health fails', async () => {
    const fixture = await createFixture(true);
    const result = await runDeploy(fixture);

    expect(result.code).not.toBe(0);
    expect(await readFile(join(fixture.data, 'deploy.env'), 'utf8')).toBe(
      `IMAGE=${previous}\n`,
    );
    expect(await readFile(join(fixture.data, 'chief.db'), 'utf8')).toBe(
      'original',
    );
  });
});

async function createFixture(failCandidate: boolean): Promise<{
  readonly bin: string;
  readonly data: string;
  readonly failCandidate: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), 'chief-deploy-test-'));
  const bin = join(root, 'bin');
  const data = join(root, 'data');
  await mkdir(bin);
  await mkdir(data);
  await writeFile(join(data, 'chief.db'), 'original');
  await writeFile(join(data, 'deploy.env'), `IMAGE=${previous}\n`);
  await executable(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
command_name="\${1:-}"
shift || true
case "$command_name" in
  pull|stop) exit 0 ;;
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
      printf '%s' migrated >"$database"
    fi
    ;;
esac
`,
  );
  await executable(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAIL_CANDIDATE:-0}" == 1 ]] && grep -qF '${candidate}' "\${CHIEF_DATA_DIR}/deploy.env"; then
  exit 1
fi
exit 0
`,
  );
  return { bin, data, failCandidate };
}

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function runDeploy(fixture: {
  readonly bin: string;
  readonly data: string;
  readonly failCandidate: boolean;
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
        FAIL_CANDIDATE: fixture.failCandidate ? '1' : '0',
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
