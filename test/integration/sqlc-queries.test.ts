import { describe, expect, it } from 'vitest';

import * as queries from '../../src/database/queries.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';

// Validate sqlc's complete generated catalog against the actual migrated SQLite
// engine, rather than trusting the compiler's subset of SQLite syntax alone.
describe('generated SQLite statements', () => {
  it('prepares every statement against the real migration schema', async () => {
    const database = openChiefDatabase(':memory:');
    try {
      await migrateChiefDatabase(database);
      const statements = Object.entries(queries);
      expect(statements.length).toBeGreaterThan(100);
      for (const [name, prepare] of statements) {
        expect(() => prepare(database), name).not.toThrow();
      }
    } finally {
      database.close();
    }
  });
});
