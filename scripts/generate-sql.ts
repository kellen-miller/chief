import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import prettier from 'prettier';

const column = z.object({
  name: z.string(),
  is_named_param: z.boolean(),
  not_null: z.boolean(),
  type: z.object({ name: z.string() }),
});
const request = z.object({
  sqlc_version: z.literal('v1.31.1'),
  queries: z.array(
    z.object({
      name: z.string(),
      text: z.string(),
      columns: z.array(column),
      params: z.array(z.object({ number: z.number(), column })),
    }),
  ),
});
const parameterTypes = z
  .record(
    z.string(),
    z.record(z.string(), z.enum(['string | null', 'number | null'])),
  )
  .parse(JSON.parse(readFileSync('sql/parameter-types.json', 'utf8')));
const metadata = request.parse(
  JSON.parse(readFileSync('.sqlc/codegen_request.json', 'utf8')),
);
function sqliteType(value: z.infer<typeof column>): string {
  const name = value.type.name.toLowerCase();
  const type =
    /^(?:int|integer|tinyint|smallint|mediumint|bigint|int2|int8|real|double|float|numeric|decimal|boolean|bool)$/u.test(
      name,
    )
      ? 'number'
      : /^(?:text|varchar|char|clob)$/u.test(name)
        ? 'string'
        : name === 'blob'
          ? 'Buffer'
          : 'unknown';
  return value.not_null || type === 'unknown' ? type : `${type} | null`;
}

let output = `// Generated from sql/*.sql by sqlc and scripts/generate-sql.ts. DO NOT EDIT.\nimport type Database from 'better-sqlite3';\n\n// better-sqlite3 types retain the row type after pluck(); expose its scalar result.\ntype PreparedStatement<P extends unknown[], R, S> = Omit<Database.Statement<P, R>, 'pluck'> & { pluck(): Database.Statement<P, S> };\n\n`;
for (const query of metadata.queries) {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/u.test(query.name))
    throw new Error('invalid query name');
  // sqlc normalizes SQLite aliases to lowercase; SQLite preserves their spelling.
  const aliases = new Map(
    [...query.text.matchAll(/\bas\s+([a-zA-Z][a-zA-Z0-9]*)/gu)].map((match) => [
      match[1]?.toLowerCase(),
      match[1],
    ]),
  );
  for (const value of query.columns)
    value.name = aliases.get(value.name) ?? value.name;
  const row = `${query.name.charAt(0).toUpperCase()}${query.name.slice(1)}Row`;
  if (query.columns.length)
    output += `export interface ${row} {\n${query.columns.map((value) => `${JSON.stringify(value.name)}: ${sqliteType(value)};`).join('\n')}\n}\n\n`;
  const orderedParameters = [...query.params].sort(
    (a, b) => a.number - b.number,
  );
  const parameters = orderedParameters.map(
    (value) =>
      parameterTypes[query.name]?.[value.number.toString()] ??
      sqliteType(value.column),
  );
  const named =
    query.params.length > 0 &&
    query.params.every((parameter) => parameter.column.is_named_param);
  if (
    !named &&
    query.params.some((parameter) => parameter.column.is_named_param)
  )
    throw new Error('mixed named/positional parameters unsupported');
  let bindings = `[${parameters.join(', ')}]`;
  let text = query.text;
  if (named) {
    const args = `${query.name.charAt(0).toUpperCase()}${query.name.slice(1)}Args`;
    output += `export interface ${args} {\n${orderedParameters.map((parameter, index) => `${JSON.stringify(parameter.column.name)}: ${parameters[index] ?? 'unknown'};`).join('\n')}\n}\n\n`;
    text = query.text.replace(/\?(\d+)/gu, (_, index: string) => {
      const parameter = query.params.find(
        (value) => value.number.toString() === index,
      );
      if (!parameter) throw new Error('unknown named parameter');
      return `@${parameter.column.name}`;
    });
    bindings = `[${args}]`;
  }

  const scalar = query.columns[0] ? sqliteType(query.columns[0]) : 'unknown';
  const resultType = query.columns.length ? `, ${row}` : '';
  const cast =
    query.columns.length && scalar !== 'unknown'
      ? ` as unknown as PreparedStatement<${bindings}, ${row}, ${scalar}>`
      : '';
  output += `export function ${query.name}(database: Database.Database): PreparedStatement<${bindings}, ${query.columns.length ? row : 'unknown'}, ${scalar}> {\nreturn database.prepare<${bindings}${resultType}>(${JSON.stringify(text)})${cast};\n}\n\n`;
}

mkdirSync('src/database', { recursive: true });
const path = 'src/database/queries.ts';
const formatted = await prettier.format(output, {
  filepath: path,
  ...(await prettier.resolveConfig(path)),
});
writeFileSync(path, formatted);
