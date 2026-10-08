import { readFileSync } from 'node:fs';

const statements = new Map<string, string>();

// FTS5, sqlite-vec, temporary recovery tables, and dynamic identifiers cannot be
// analyzed by sqlc. Keep those statements in SQL files with explicit fragments.
export function readSqliteStatement(
  name: string,
  substitutions: readonly string[] = [],
): string {
  let sql = statements.get(name);
  if (sql === undefined) {
    sql = readFileSync(
      new URL(`../../sql/queries/sqlite/${name}.sql`, import.meta.url),
      'utf8',
    );
    statements.set(name, sql);
  }

  return sql.replace(/\{\{(\d+)\}\}/gu, (_match: string, index: string) => {
    const value = substitutions[Number(index)];
    if (value === undefined)
      throw new Error(`missing SQL fragment ${name}:${index}`);
    return value;
  });
}
