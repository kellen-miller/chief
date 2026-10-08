import { readdirSync, readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';
import knex, { type Knex } from 'knex';

import { readSqliteStatement } from './sqlite-statements.js';

const migrationsDirectory = new URL('../../sql/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name))
  .sort();

export function verifyDatabaseMigrations(database: Database.Database): boolean {
  try {
    const recorded = database
      .prepare(readSqliteStatement('migrations/listMigrations'))
      .pluck()
      .all();
    return (
      recorded.length === migrationFiles.length &&
      recorded.every((name, index) => name === migrationFiles[index])
    );
  } catch {
    return false;
  }
}

export async function migrateChiefDatabase(
  database: Database.Database,
  throughMigrationId?: string,
): Promise<void> {
  const target =
    throughMigrationId === undefined ? undefined : `${throughMigrationId}.sql`;
  if (target !== undefined && !migrationFiles.includes(target)) {
    throw new Error(`unknown migration target: ${target}`);
  }

  // Borrow the connection with its loaded extensions. Knex owns migration
  // ordering, transactions, locking and history; the caller owns close.
  const pool = new knex.KnexPool<Database.Database>({
    min: 0,
    max: 1,
    create: () => database,
    destroy: () => undefined,
  });
  const source: Knex.MigrationSource<string> = {
    getMigrations: () => Promise.resolve([...migrationFiles]),
    getMigrationName: (name) => name,
    getMigration: (name) =>
      Promise.resolve({
        up: () => {
          database.exec(
            readFileSync(new URL(name, migrationsDirectory), 'utf8'),
          );
          return Promise.resolve();
        },
        down: () =>
          Promise.reject(new Error('restore a backup to downgrade Chief')),
      }),
  };
  const migrator = knex({
    client: 'better-sqlite3',
    useNullAsDefault: true,
    connectionPool: pool,
    migrations: { migrationSource: source },
  });
  try {
    if (target === undefined) await migrator.migrate.latest();
    else await migrator.migrate.to({ name: target });
  } finally {
    await migrator.destroy();
    await pool.destroy();
  }
}
