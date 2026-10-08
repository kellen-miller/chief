import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

it('stops writers before archiving the old database and deployment state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chief-cutover-'));
  try {
    const bin = join(root, 'bin');
    const data = join(root, 'data');
    await mkdir(bin);
    await mkdir(data);
    for (const name of [
      'chief.db',
      'chief.db-wal',
      'chief.db-shm',
      'deploy.env',
    ]) {
      await writeFile(join(data, name), `original:${name}`);
    }

    await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    const args = [resolve('scripts/cutover-database.ts'), data];
    const options = {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8' as const,
      stdio: 'pipe' as const,
    };
    expect(() => execFileSync(process.execPath, args, options)).toThrow();
    expect(await readFile(join(data, 'chief.db'), 'utf8')).toBe(
      'original:chief.db',
    );
    expect(
      (await readdir(data)).filter((name) => name.startsWith('pre-cutover-')),
    ).toEqual([]);

    const log = join(root, 'commands');
    await writeFile(
      join(bin, 'systemctl'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CUTOVER_LOG"\n',
      { mode: 0o755 },
    );
    execFileSync(process.execPath, args, {
      ...options,
      env: { ...options.env, CUTOVER_LOG: log },
    });
    const archives = await readdir(data);
    expect(archives).toHaveLength(1);
    const archive = archives[0];
    if (archive === undefined) throw new Error('archive missing');
    for (const name of [
      'chief.db',
      'chief.db-wal',
      'chief.db-shm',
      'deploy.env',
    ]) {
      expect(await readFile(join(data, archive, name), 'utf8')).toBe(
        `original:${name}`,
      );
    }

    expect(await readFile(log, 'utf8')).toBe(
      'stop chief-health.timer chief-backup.timer chief-monitoring.timer\nstop chief-health.service chief-backup.service chief-monitoring.service chief.service\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
