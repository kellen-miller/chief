import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { backup } from '../../src/ops/backup.ts';

// Run the actual compiled container CLI behind a local Docker/storage boundary.
// This catches mismatches between host commands and the shipped build artifacts.
afterEach(() => vi.unstubAllEnvs());

describe('online host backup', () => {
  it('backs up, verifies and uploads a real migrated database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-online-backup-'));
    const runtime = join(root, 'runtime');
    const data = join(root, 'data');
    const bin = join(root, 'bin');
    const uploaded = join(root, 'uploaded');
    const config = join(root, 'chief.env');
    for (const directory of [runtime, data, bin, uploaded])
      mkdirSync(directory);
    try {
      execFileSync(
        resolve('node_modules/.bin/tsc'),
        [
          '--project',
          'tsconfig.build.json',
          '--outDir',
          join(runtime, 'dist'),
          '--declaration',
          'false',
          '--declarationMap',
          'false',
          '--sourceMap',
          'false',
        ],
        { timeout: 20_000 },
      );
      writeFileSync(join(runtime, 'package.json'), '{"type":"module"}');
      symlinkSync(resolve('node_modules'), join(runtime, 'node_modules'));
      const database = openChiefDatabase(join(data, 'chief.db'));
      try {
        await migrateChiefDatabase(database);
        database
          .prepare(
            `insert into usage_ledger
             (id, operation, work_category, priority, reservation_usd, occurred_at)
             values ('backup-test', 'text', 'interaction', 'interactive', 0.1, 1)`,
          )
          .run();
      } finally {
        database.close();
      }

      writeFileSync(config, 'CHIEF_BACKUP_BUCKET=chief-backups\n');
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const [operation, container, executable, ...args] = process.argv.slice(2);
if (operation === 'inspect') process.exit(0);
if (operation !== 'exec' || container !== 'chief' || executable !== 'node') process.exit(1);
const result = spawnSync(process.execPath, args.map(value =>
  value.replace('/var/lib/chief', process.env.TEST_DATA)
), { cwd: process.env.TEST_RUNTIME, stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      );
      writeFileSync(
        join(bin, 'gcloud'),
        `#!/usr/bin/env node
const { copyFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const [group, operation, source, destination] = process.argv.slice(2);
if (group !== 'storage' || operation !== 'cp' || destination !== 'gs://chief-backups/backups/') process.exit(1);
copyFileSync(source, join(process.env.TEST_UPLOADED, basename(source)));
`,
      );
      for (const command of ['docker', 'gcloud'])
        chmodSync(join(bin, command), 0o755);
      vi.stubEnv('CHIEF_CONFIG_FILE', config);
      vi.stubEnv('CHIEF_DATA_DIR', data);
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      vi.stubEnv('TEST_DATA', data);
      vi.stubEnv('TEST_RUNTIME', runtime);
      vi.stubEnv('TEST_UPLOADED', uploaded);

      backup([]);

      const receiptPath = join(data, 'backup-monitoring.json');
      const receipt = readFileSync(receiptPath, 'utf8');
      expect(receipt).toMatch(/^\{"completed_at":\d+\}$/u);
      writeFileSync(join(bin, 'gcloud'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755,
      });
      expect(() => {
        backup([]);
      }).toThrow('gcloud failed');
      expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);

      const files = readdirSync(uploaded);
      expect(files).toHaveLength(1);
      const restored = openChiefDatabase(join(uploaded, files[0] ?? 'missing'));
      try {
        expect(
          restored
            .prepare('select reservation_usd from usage_ledger where id = ?')
            .pluck()
            .get('backup-test'),
        ).toBe(0.1);
        expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        restored.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
