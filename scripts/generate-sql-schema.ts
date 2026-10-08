import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../src/memory/database.js';

// Derive sqlc's ordinary-table catalog from the real migration executor.
// Extension tables and their shadow tables stay at the handwritten boundary.
const directory = mkdtempSync(join(tmpdir(), 'chief-sqlc-schema-'));
try {
  const database = openChiefDatabase(join(directory, 'schema.db'));
  try {
    await migrateChiefDatabase(database);
    const rows = database
      .prepare<[], { sql: string }>(
        `select sql from sqlite_master
      where sql is not null and name not like 'sqlite_%'
        and name not like '%_fts%' and name not like '%_vectors%'
      order by type desc, name`,
      )
      .all();
    writeFileSync(
      'sql/schema.sql',
      `-- Generated from src/memory/database.ts. DO NOT EDIT.\n${rows.map((row) => `${row.sql};`).join('\n\n')}\n`,
    );
  } finally {
    database.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
