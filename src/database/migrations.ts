import { readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';
import knex, { type Knex } from 'knex';

import {
  assertContentlessDeleteSupport,
  backfillContextForgetJournals,
  guardLegacyBackfillAccounting,
  targetLegacyBackfillAccounting,
  repairBackfillOwnership,
  repairReservationOriginOwnership,
} from './migration-data.js';

const MIGRATION_ID = '0001_initial';

const MIGRATION_CHECKSUM = 'chief-0001-v3';

export const CHANNEL_CONTEXT_MIGRATION_ID = '0003_channel_context';

export const CHANNEL_CONTEXT_MIGRATION_CHECKSUM = 'chief-0003-v2';

export const DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID =
  '0004_discord_source_lifecycle';

export const DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM = 'chief-0004-v7';

export const CONTEXT_FORGETTING_MIGRATION_ID = '0005_context_forgetting';

export const CONTEXT_FORGETTING_MIGRATION_CHECKSUM = 'chief-0005-v4';

export const CONTEXT_BACKFILL_MIGRATION_ID = '0006_context_backfill';

export const CONTEXT_BACKFILL_MIGRATION_CHECKSUM = 'chief-0006-v2';

export const CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID =
  '0007_context_backfill_accounting';

export const CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM = 'chief-0007-v1';

export const CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID =
  '0008_context_backfill_lifecycle';

export const CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM = 'chief-0008-v1';

export const CONTEXT_BACKFILL_TARGETING_MIGRATION_ID =
  '0009_context_backfill_targeting';

export const CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM = 'chief-0009-v1';

export const CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID =
  '0010_context_backfill_ownership';

export const CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM = 'chief-0010-v1';

export const USAGE_RESERVATION_ORIGIN_MIGRATION_ID =
  '0011_usage_reservation_origin';

export const USAGE_RESERVATION_ORIGIN_MIGRATION_CHECKSUM = 'chief-0011-v1';

export const CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_ID =
  '0012_context_accounting_origin';

export const CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_CHECKSUM = 'chief-0012-v1';

export const LEGACY_SOURCE_SCOPE_MIGRATION_ID = '0013_legacy_source_scope';

export const LEGACY_SOURCE_SCOPE_MIGRATION_CHECKSUM = 'chief-0013-v1';

interface Migration {
  readonly checksum: string;
  readonly id: string;
  readonly migrate?: (database: Database.Database) => void;
  readonly validate?: (database: Database.Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    checksum: MIGRATION_CHECKSUM,
    id: MIGRATION_ID,
  },
  {
    checksum: 'chief-0002-v1',
    id: '0002_conversation_events',
  },
  {
    checksum: CHANNEL_CONTEXT_MIGRATION_CHECKSUM,
    id: CHANNEL_CONTEXT_MIGRATION_ID,
    validate: assertContentlessDeleteSupport,
  },
  {
    checksum: DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM,
    id: DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID,
  },
  {
    checksum: CONTEXT_FORGETTING_MIGRATION_CHECKSUM,
    id: CONTEXT_FORGETTING_MIGRATION_ID,
    migrate: backfillContextForgetJournals,
  },
  {
    checksum: CONTEXT_BACKFILL_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_MIGRATION_ID,
  },
  {
    checksum: CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID,
  },
  {
    checksum: CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID,
    migrate: guardLegacyBackfillAccounting,
  },
  {
    checksum: CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_TARGETING_MIGRATION_ID,
    migrate: targetLegacyBackfillAccounting,
  },
  {
    checksum: CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM,
    id: CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID,
    migrate: repairBackfillOwnership,
  },
  {
    checksum: USAGE_RESERVATION_ORIGIN_MIGRATION_CHECKSUM,
    id: USAGE_RESERVATION_ORIGIN_MIGRATION_ID,
  },
  {
    checksum: CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_CHECKSUM,
    id: CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_ID,
    migrate: repairReservationOriginOwnership,
  },
  {
    checksum: LEGACY_SOURCE_SCOPE_MIGRATION_CHECKSUM,
    id: LEGACY_SOURCE_SCOPE_MIGRATION_ID,
  },
  {
    checksum: 'chief-0014-v1',
    id: '0014_monitoring_alerts',
  },
];

export function verifyRecordedMigrationSet(
  database: Database.Database,
): boolean {
  try {
    const rows = database
      .prepare('select id, checksum from schema_migrations')
      .all() as { readonly checksum: string; readonly id: string }[];
    if (rows.length === 0) return false;
    const recorded = new Map(rows.map((row) => [row.id, row.checksum]));
    const appliedIndexes = MIGRATIONS.flatMap((migration, index) =>
      recorded.has(migration.id) ? [index] : [],
    );
    const lastIndex = Math.max(...appliedIndexes);
    if (recorded.size !== lastIndex + 1) return false;
    return MIGRATIONS.slice(0, lastIndex + 1).every(
      (migration) => recorded.get(migration.id) === migration.checksum,
    );
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
    !MIGRATIONS.some(({ id }) => id === throughMigrationId)
  ) {
    throw new Error(`unknown migration target: ${throughMigrationId}`);
  }
  database.exec(
    'create table if not exists schema_migrations (id text primary key, checksum text not null, applied_at integer not null)',
  );

  const applied = new Map(
    (
      database.prepare('select id, checksum from schema_migrations').all() as {
        id: string;
        checksum: string;
      }[]
    ).map(({ id, checksum }) => [id, checksum]),
  );
  for (const { id, checksum } of MIGRATIONS) {
    if (applied.has(id) && applied.get(id) !== checksum) {
      throw new Error(`migration checksum mismatch for ${id}`);
    }
  }

  if (applied.size && !verifyRecordedMigrationSet(database)) {
    throw new Error('invalid recorded migration history');
  }

  if (
    database
      .prepare("select 1 from sqlite_master where name = 'knex_migrations'")
      .get()
  ) {
    const completed = database
      .prepare('select name from knex_migrations')
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
    getMigrations: () => Promise.resolve([...MIGRATIONS]),
    getMigrationName: ({ id }) => id,
    getMigration: (migration) =>
      Promise.resolve({
        up: () => {
          // Knex records already-applied legacy migrations without replaying them.
          if (!applied.has(migration.id)) {
            database.exec(
              readFileSync(
                new URL(
                  `../../migrations/${migration.id}.sql`,
                  import.meta.url,
                ),
                'utf8',
              ),
            );
            migration.migrate?.(database);
            migration.validate?.(database);
            database
              .prepare(
                'insert into schema_migrations (id, checksum, applied_at) values (?, ?, ?)',
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
