import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  migrateChiefDatabase,
  openChiefDatabase,
  verifyContextDatabaseSchema,
} from '../../src/memory/database.js';
import { backupChiefDatabase } from '../../src/memory/backup.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';

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
    expect(
      database
        .prepare('select id from schema_migrations order by id')
        .pluck()
        .all(),
    ).toEqual([
      '0001_initial',
      '0002_conversation_events',
      '0003_channel_context',
      '0004_discord_source_lifecycle',
      '0005_context_forgetting',
    ]);
    expect(verifyContextDatabaseSchema(database)).toBe(true);
    database.close();
  });

  it('supports contentless FTS delete semantics at startup', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);

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

  it('migrates production-shaped data without loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-upgrade-'));
    directories.push(directory);
    const database = openChiefDatabase(join(directory, 'chief.db'));
    database.exec(
      await readFile(
        new URL('../fixtures/production-0002.sql', import.meta.url),
        'utf8',
      ),
    );
    database
      .prepare(
        'insert into memory_vectors (memory_id, embedding) values (?, ?)',
      )
      .run(1n, JSON.stringify(Array.from(embedding(0.25))));

    expect(
      new SqliteMemoryStore(database).retrieve({
        embedding: embedding(0.25),
        limit: 5,
        now: 200,
        text: 'Project Marigold',
      })[0]?.canonicalText,
    ).toBe('Project Marigold launches Friday');

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
          `select work_category as workCategory, priority
           from usage_ledger where id = 'usage-pending'`,
        )
        .get(),
    ).toEqual({ priority: 'background', workCategory: 'memory' });
    expect(
      database
        .prepare(
          `select recent_until as recentUntil, guild_id as guildId,
                  channel_id as channelId,
                  discord_message_id as discordMessageId,
                  attachment_metadata_json as attachmentMetadataJson,
                  content_state as contentState,
                  content_state_reason as contentStateReason,
                  response_chunk_index as responseChunkIndex
           from conversation_events where id = 1`,
        )
        .get(),
    ).toEqual({
      attachmentMetadataJson: '[]',
      channelId: '',
      contentState: 'available',
      contentStateReason: 'retained',
      discordMessageId: 'discord:text:1280000000000000001',
      guildId: '',
      recentUntil: 700,
      responseChunkIndex: null,
    });
    expect(
      new SqliteMemoryStore(database).retrieve({
        embedding: embedding(0.25),
        limit: 5,
        now: 200,
        text: 'Project Marigold',
      })[0]?.canonicalText,
    ).toBe('Project Marigold launches Friday');
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database.prepare('select count(*) from memory_vectors').pluck().get(),
    ).toBe(1);
    for (const table of [
      'conversation_event_fts',
      'context_document_fts',
      'context_document_vectors',
    ]) {
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

function embedding(value: number): Float32Array {
  const result = new Float32Array(1536);
  result[0] = value;
  return result;
}
