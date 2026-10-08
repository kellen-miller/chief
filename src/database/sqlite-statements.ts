import { readFileSync } from 'node:fs';

const statements = new Map<string, string>();

// FTS5, sqlite-vec, temporary recovery tables, and dynamic identifiers cannot be
// analyzed by sqlc. Group named statements by domain in SQL files; callers use
// domain/query keys and supply only internal SQL fragments, never user values.
export function readSqliteStatement(
  name: string,
  substitutions: readonly string[] = [],
): string {
  let sql = statements.get(name);
  if (sql === undefined) {
    const domain = name.slice(0, name.indexOf('/'));
    const sections = readFileSync(
      new URL(`../../sql/queries/sqlite/${domain}.sql`, import.meta.url),
      'utf8',
    ).split(/^-- name: (\w+)\r?$/mu);
    for (let index = 1; index < sections.length; index += 2) {
      const query = sections[index];
      const statement = sections[index + 1];
      if (query === undefined || statement === undefined) {
        throw new Error(`invalid SQL query file: ${domain}`);
      }

      statements.set(`${domain}/${query}`, statement);
    }

    sql = statements.get(name);
    if (sql === undefined) throw new Error(`unknown SQL statement: ${name}`);
  }

  return sql.replace(/\{\{(\d+)\}\}/gu, (_match: string, index: string) => {
    const value = substitutions[Number(index)];
    if (value === undefined)
      throw new Error(`missing SQL fragment ${name}:${index}`);
    return value;
  });
}
