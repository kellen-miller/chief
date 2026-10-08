import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
  verifyContextDatabaseSchema,
} from '../../src/memory/database.js';
import { backupChiefDatabase } from '../../src/memory/backup.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Chief database', () => {
  it('creates the baseline and uses only Knex history', async () => {
    const database = openChiefDatabase(':memory:');
    try {
      await migrateChiefDatabase(database);
      await migrateChiefDatabase(database);
      expect(
        database
          .prepare('select name from knex_migrations order by id')
          .pluck()
          .all(),
      ).toEqual([
        '0001_memory.sql',
        '0002_conversation.sql',
        '0003_context.sql',
        '0004_usage.sql',
        '0005_monitoring.sql',
      ]);
      expect(
        database
          .prepare(
            "select name from sqlite_master where name = 'schema_migrations'",
          )
          .get(),
      ).toBeUndefined();
      expect(database.prepare('select vec_version()').pluck().get()).toBe(
        'v0.1.9',
      );
      expect(verifyContextDatabaseSchema(database)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('rolls back a failed migration and releases the Knex lock', async () => {
    const database = openChiefDatabase(':memory:');
    try {
      await migrateChiefDatabase(database, '0004_usage');
      database.exec('create view monitoring_alerts as select 1 as id');
      await expect(migrateChiefDatabase(database)).rejects.toThrow();
      expect(
        database
          .prepare(
            "select name from knex_migrations where name = '0005_monitoring.sql'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare('select is_locked from knex_migrations_lock')
          .pluck()
          .get(),
      ).toBe(0);
      expect(database.inTransaction).toBe(false);
      database.exec('drop view monitoring_alerts');
      await migrateChiefDatabase(database);
      expect(verifyContextDatabaseSchema(database)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('rejects an unknown migration and incomplete restore schema', async () => {
    const database = openChiefDatabase(':memory:');
    try {
      await expect(migrateChiefDatabase(database, 'unknown')).rejects.toThrow(
        'unknown migration target',
      );
      await migrateChiefDatabase(database, '0002_conversation');
      expect(verifyContextDatabaseSchema(database)).toBe(false);
      await migrateChiefDatabase(database);
      database
        .prepare(
          "update knex_migrations set name = 'unknown.sql' where name = '0005_monitoring.sql'",
        )
        .run();
      expect(verifyContextDatabaseSchema(database)).toBe(false);
      await expect(migrateChiefDatabase(database)).rejects.toThrow(
        'migration directory is corrupt',
      );
    } finally {
      database.close();
    }
  });
  it('takes a pre-migration backup without changing the source schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-pre-migration-'));
    directories.push(directory);
    const source = join(directory, 'chief.db');
    const database = openChiefDatabase(source);
    database.exec('create table legacy_marker (value text not null)');
    database.prepare('insert into legacy_marker values (?)').run('original');
    database.close();

    const backup = await backupChiefDatabase(
      source,
      join(directory, 'backups'),
    );
    const reopenedSource = openChiefDatabase(source);
    const copied = openChiefDatabase(backup);

    expect(
      reopenedSource
        .prepare(
          "select count(*) from sqlite_master where name = 'schema_migrations'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      copied.prepare('select value from legacy_marker').pluck().get(),
    ).toBe('original');
    reopenedSource.close();
    copied.close();
  });

  it('supports contentless FTS delete semantics at startup', async () => {
    const database = openChiefDatabase(':memory:');
    await migrateChiefDatabase(database);

    for (const table of ['conversation_event_fts', 'context_document_fts']) {
      database
        .prepare(`insert into ${table} (rowid, content) values (1, 'visible')`)
        .run();
      database.prepare(`delete from ${table} where rowid = 1`).run();
      expect(
        database.prepare(`select count(*) from ${table}`).pluck().get(),
      ).toBe(0);
    }
    database.close();
  });

  it('retains copied memory provenance after raw source deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-retention-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));
    await migrateChiefDatabase(database);

    database
      .prepare(
        `insert into source_events
           (id, platform_source_id, speaker_id, medium, content, occurred_at, retention_deadline)
         values (1, 'message-1', 'president-1', 'text', 'Meet at noon', 1, 2)`,
      )
      .run();
    database
      .prepare(
        `insert into memories
           (id, source_event_id, canonical_text, kind, confidence, provenance_json, state, created_at, updated_at)
         values (1, 1, 'The group meets at noon', 'plan', 0.9,
                 '{"platformSourceId":"message-1"}', 'active', 1, 1)`,
      )
      .run();

    database.prepare('delete from source_events where id = 1').run();

    expect(
      database
        .prepare(
          'select source_event_id, provenance_json from memories where id = 1',
        )
        .get(),
    ).toEqual({
      provenance_json: '{"platformSourceId":"message-1"}',
      source_event_id: null,
    });
    database.close();
  });
});
