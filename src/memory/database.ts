import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { readSqliteStatement } from '../database/sqlite-statements.js';
import * as queries from '../../gen/sql/application.js';

import { verifyDatabaseMigrations } from '../database/migrations.js';

export {
  migrateChiefDatabase,
  verifyDatabaseMigrations,
} from '../database/migrations.js';

export function openChiefDatabase(path: string): Database.Database {
  const database = new Database(path);
  sqliteVec.load(database);
  const vectorVersion = queries
    .databaseOpenChiefDatabaseSelectStatement(database)
    .pluck()
    .get();
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
    if (!verifyDatabaseMigrations(database)) return false;
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
      database
        .prepare(readSqliteStatement('migrations/verifyTable', [table]))
        .pluck()
        .get();
    }
    return true;
  } catch {
    return false;
  }
}
