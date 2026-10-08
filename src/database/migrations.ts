import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { readSqliteStatement } from './sqlite-statements.js';

import type Database from 'better-sqlite3';
import knex, { type Knex } from 'knex';

interface Migration {
  readonly checksum: string;
  readonly id: string;
  readonly sql: string;
}

// SQL filenames define migration order. Only pre-Knex migrations carry legacy
// checksum headers; new migrations use a checksum of their file contents.
const migrationsDirectory = new URL('../../sql/migrations/', import.meta.url);
const migrations: readonly Migration[] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name))
  .sort()
  .map((name) => {
    const sql = readFileSync(new URL(name, migrationsDirectory), 'utf8');
    return {
      id: name.slice(0, -4),
      checksum:
        /^-- chief-legacy-checksum: (\S+)$/mu.exec(sql)?.[1] ??
        createHash('sha256').update(sql).digest('hex'),
      sql,
    };
  });

export function verifyRecordedMigrationSet(
  database: Database.Database,
): boolean {
  try {
    const rows = database
      .prepare(readSqliteStatement('selectRecordedMigrations'))
      .all() as { readonly checksum: string; readonly id: string }[];
    if (rows.length === 0) return false;
    const recorded = new Map(rows.map((row) => [row.id, row.checksum]));
    const appliedIndexes = migrations.flatMap((migration, index) =>
      recorded.has(migration.id) ? [index] : [],
    );
    const lastIndex = Math.max(...appliedIndexes);
    if (recorded.size !== lastIndex + 1) return false;
    return migrations
      .slice(0, lastIndex + 1)
      .every((migration) => recorded.get(migration.id) === migration.checksum);
  } catch {
    return false;
  }
}

export async function migrateChiefDatabase(
  database: Database.Database,
  throughMigrationId?: string,
): Promise<void> {
  if (
    throughMigrationId !== undefined &&
    !migrations.some(({ id }) => id === throughMigrationId)
  ) {
    throw new Error(`unknown migration target: ${throughMigrationId}`);
  }
  database.exec(
    readSqliteStatement('migrationsMigrateChiefDatabaseCreateSchemaMigrations'),
  );

  const applied = new Map(
    (
      database
        .prepare(readSqliteStatement('selectRecordedMigrations'))
        .all() as {
        id: string;
        checksum: string;
      }[]
    ).map(({ id, checksum }) => [id, checksum]),
  );
  for (const { id, checksum } of migrations) {
    if (applied.has(id) && applied.get(id) !== checksum) {
      throw new Error(`migration checksum mismatch for ${id}`);
    }
  }

  if (applied.size && !verifyRecordedMigrationSet(database)) {
    throw new Error('invalid recorded migration history');
  }

  if (
    database
      .prepare(
        readSqliteStatement('migrationsMigrateChiefDatabaseSelectSqliteMaster'),
      )
      .get()
  ) {
    const completed = database
      .prepare(
        readSqliteStatement(
          'migrationsMigrateChiefDatabaseSelectKnexMigrations',
        ),
      )
      .pluck()
      .all() as string[];
    if (completed.some((id) => !applied.has(id))) {
      throw new Error(
        'Knex migration history disagrees with recorded checksums',
      );
    }
  }

  // Borrow the caller's connection, including its loaded extensions and any
  // in-memory database. Knex owns migration transactions; the caller owns close.
  const pool = new knex.KnexPool<Database.Database>({
    min: 0,
    max: 1,
    create: () => database,
    destroy: () => undefined,
  });
  const source: Knex.MigrationSource<Migration> = {
    getMigrations: () => Promise.resolve([...migrations]),
    getMigrationName: ({ id }) => id,
    getMigration: (migration) =>
      Promise.resolve({
        up: () => {
          // Adopt already-applied legacy migrations without replaying them.
          if (!applied.has(migration.id)) {
            database.exec(migration.sql);
            database
              .prepare(
                readSqliteStatement(
                  'migrationsMigrateChiefDatabaseInsertSchemaMigrations',
                ),
              )
              .run(migration.id, migration.checksum, Date.now());
          }

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
    migrations: { migrationSource: source, tableName: 'knex_migrations' },
  });
  try {
    if (throughMigrationId === undefined) {
      await migrator.migrate.latest();
    } else {
      await migrator.migrate.to({ name: throughMigrationId });
    }
  } finally {
    await migrator.destroy();
    await pool.destroy();
  }
}
