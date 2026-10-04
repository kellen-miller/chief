import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, it } from 'vitest';

describe('host-side Discord monitoring', () => {
  it('reports outages safely and persists delivery receipts', async () => {
    await promisify(execFile)('python3', [
      '-B',
      '-m',
      'unittest',
      'discover',
      '-s',
      'test/monitoring',
    ]);
  });
});
