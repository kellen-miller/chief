import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
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

  it('loads sqlite-vec and migrates idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-database-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));

    migrateChiefDatabase(database);
    migrateChiefDatabase(database);

    const version = database
      .prepare('select vec_version() as version')
      .get() as {
      version: string;
    };
    expect(version.version).toBe('v0.1.9');
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    database.close();
  });

  it('adds conversation history without changing deployed 0001 data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-upgrade-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));
    migrateChiefDatabase(database);
    database
      .prepare(
        `insert into source_events
           (id, platform_source_id, speaker_id, medium, content, occurred_at,
            retention_deadline)
         values (1, 'existing-source', 'president', 'text', 'existing', 1, 100)`,
      )
      .run();
    database
      .prepare(
        `insert into memory_jobs
           (id, source_event_id, not_before, status)
         values (1, 1, 1, 'pending')`,
      )
      .run();
    database
      .prepare(
        `insert into usage_ledger
           (id, operation, reservation_usd, occurred_at)
         values ('usage-1', 'text-response', 0.25, 1)`,
      )
      .run();
    database.exec('drop table conversation_events');
    database
      .prepare(
        "delete from schema_migrations where id = '0002_conversation_events'",
      )
      .run();

    migrateChiefDatabase(database);

    expect(
      database.prepare('select count(*) from source_events').pluck().get(),
    ).toBe(1);
    expect(
      database.prepare('select count(*) from memory_jobs').pluck().get(),
    ).toBe(1);
    expect(
      database.prepare('select count(*) from usage_ledger').pluck().get(),
    ).toBe(1);
    expect(
      database
        .prepare(
          "select count(*) from schema_migrations where id = '0002_conversation_events'",
        )
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });

  it('retains copied memory provenance after raw source deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-retention-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));
    migrateChiefDatabase(database);

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
