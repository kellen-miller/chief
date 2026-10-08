import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import {
  CHANNEL_CONTEXT_MIGRATION_ID,
  CHANNEL_CONTEXT_MIGRATION_CHECKSUM,
  DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID,
  DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM,
  CONTEXT_FORGETTING_MIGRATION_ID,
  CONTEXT_FORGETTING_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_MIGRATION_ID,
  CONTEXT_BACKFILL_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID,
  CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID,
  CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_TARGETING_MIGRATION_ID,
  CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID,
  CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM,
  USAGE_RESERVATION_ORIGIN_MIGRATION_ID,
  USAGE_RESERVATION_ORIGIN_MIGRATION_CHECKSUM,
  CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_ID,
  CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_CHECKSUM,
  LEGACY_SOURCE_SCOPE_MIGRATION_ID,
  LEGACY_SOURCE_SCOPE_MIGRATION_CHECKSUM,
} from '../database/migrations.js';

export {
  CHANNEL_CONTEXT_MIGRATION_ID,
  CHANNEL_CONTEXT_MIGRATION_CHECKSUM,
  DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID,
  DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM,
  CONTEXT_FORGETTING_MIGRATION_ID,
  CONTEXT_FORGETTING_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_MIGRATION_ID,
  CONTEXT_BACKFILL_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID,
  CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID,
  CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_TARGETING_MIGRATION_ID,
  CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM,
  CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID,
  CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM,
  USAGE_RESERVATION_ORIGIN_MIGRATION_ID,
  USAGE_RESERVATION_ORIGIN_MIGRATION_CHECKSUM,
  CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_ID,
  CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_CHECKSUM,
  LEGACY_SOURCE_SCOPE_MIGRATION_ID,
  LEGACY_SOURCE_SCOPE_MIGRATION_CHECKSUM,
  migrateChiefDatabase,
  verifyRecordedMigrationSet,
} from '../database/migrations.js';

export function openChiefDatabase(path: string): Database.Database {
  const database = new Database(path);
  sqliteVec.load(database);
  const vectorVersion = database.prepare('select vec_version()').pluck().get();
  if (vectorVersion !== 'v0.1.9') {
    database.close();
    throw new Error(`unsupported sqlite-vec version: ${String(vectorVersion)}`);
  }
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  database.pragma('temp_store = MEMORY');
  return database;
}

export function verifyContextDatabaseSchema(
  database: Database.Database,
): boolean {
  try {
    const checksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CHANNEL_CONTEXT_MIGRATION_ID);
    if (checksum !== CHANNEL_CONTEXT_MIGRATION_CHECKSUM) return false;
    const lifecycleChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(DISCORD_SOURCE_LIFECYCLE_MIGRATION_ID);
    if (lifecycleChecksum !== DISCORD_SOURCE_LIFECYCLE_MIGRATION_CHECKSUM) {
      return false;
    }
    const forgettingChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_FORGETTING_MIGRATION_ID);
    if (forgettingChecksum !== CONTEXT_FORGETTING_MIGRATION_CHECKSUM) {
      return false;
    }
    const backfillChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_MIGRATION_ID);
    if (backfillChecksum !== CONTEXT_BACKFILL_MIGRATION_CHECKSUM) return false;
    const accountingChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_ID);
    if (accountingChecksum !== CONTEXT_BACKFILL_ACCOUNTING_MIGRATION_CHECKSUM) {
      return false;
    }
    const backfillLifecycleChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_ID);
    if (
      backfillLifecycleChecksum !==
      CONTEXT_BACKFILL_LIFECYCLE_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const backfillTargetingChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_TARGETING_MIGRATION_ID);
    if (
      backfillTargetingChecksum !==
      CONTEXT_BACKFILL_TARGETING_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const backfillOwnershipChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_ID);
    if (
      backfillOwnershipChecksum !==
      CONTEXT_BACKFILL_OWNERSHIP_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const reservationOriginChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(USAGE_RESERVATION_ORIGIN_MIGRATION_ID);
    if (
      reservationOriginChecksum !== USAGE_RESERVATION_ORIGIN_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const accountingOriginChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_ID);
    if (
      accountingOriginChecksum !== CONTEXT_ACCOUNTING_ORIGIN_MIGRATION_CHECKSUM
    ) {
      return false;
    }
    const legacySourceScopeChecksum = database
      .prepare('select checksum from schema_migrations where id = ?')
      .pluck()
      .get(LEGACY_SOURCE_SCOPE_MIGRATION_ID);
    if (legacySourceScopeChecksum !== LEGACY_SOURCE_SCOPE_MIGRATION_CHECKSUM) {
      return false;
    }
    for (const table of [
      'conversation_event_fts',
      'context_document_fts',
      'context_document_vectors',
      'context_backfill_pages',
      'context_backfill_segments',
      'context_backfill_source_identities',
      'context_accounting_holds',
      'discord_reconciliation_state',
      'discord_reconciliation_seen',
    ]) {
      database.prepare(`select count(*) from ${table} where 0`).pluck().get();
    }
    return true;
  } catch {
    return false;
  }
}
