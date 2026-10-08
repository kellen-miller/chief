import type Database from 'better-sqlite3';

import { readSqliteStatement } from '../database/sqlite-statements.js';

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;

export function discordSourceSnowflake(scopeId: string): string | null {
  if (DISCORD_SNOWFLAKE.test(scopeId)) return scopeId;
  const parts = scopeId.split('/');
  if (
    parts.length !== 3 ||
    parts.some((part) => part === '') ||
    !DISCORD_SNOWFLAKE.test(parts[2] ?? '')
  ) {
    return null;
  }
  return parts[2] ?? null;
}

export function hasSourceTombstone(
  database: Database.Database,
  scopeId: string,
): boolean {
  const snowflake = discordSourceSnowflake(scopeId);
  const aliases =
    snowflake === null || snowflake === scopeId
      ? [scopeId]
      : [scopeId, snowflake];
  return (
    database
      .prepare(
        readSqliteStatement(
          'context/sourceScopeHasSourceTombstoneSelectContextTombstones',
          [aliases.map(() => '?').join(', ')],
        ),
      )
      .pluck()
      .get(...aliases) === 1
  );
}
