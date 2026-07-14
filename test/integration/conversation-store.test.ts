import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('ConversationStore', () => {
  it('persists chronological conversation across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chief-conversation-'));
    directories.push(directory);
    const path = join(directory, 'chief.db');
    const database = openChiefDatabase(path);
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);

    store.record({
      content: 'Pick one from that list.',
      medium: 'text',
      occurredAt: 20,
      platformEventId: 'discord:text:2',
      requestId: 'request-2',
      retentionDeadline: 20 + 7 * 24 * 60 * 60 * 1_000,
      role: 'human',
      speakerId: 'president-2',
      speakerName: 'Abe',
    });
    store.record({
      content: 'New Mexico is the best fit.',
      medium: 'text',
      occurredAt: 30,
      platformEventId: 'chief:request-2',
      requestId: 'request-2',
      retentionDeadline: 30 + 7 * 24 * 60 * 60 * 1_000,
      role: 'chief',
      speakerId: null,
      speakerName: 'Chief',
    });
    database.close();

    const reopened = openChiefDatabase(path);
    migrateChiefDatabase(reopened);
    const recent = new ConversationStore(reopened).recent({ now: 40 });

    expect(
      recent.events.map(({ content, role }) => ({ content, role })),
    ).toEqual([
      { content: 'Pick one from that list.', role: 'human' },
      { content: 'New Mexico is the best fit.', role: 'chief' },
    ]);
    expect(
      reopened
        .prepare('select id from schema_migrations order by id')
        .pluck()
        .all(),
    ).toEqual([
      '0001_initial',
      '0002_conversation_events',
      '0003_channel_context',
      '0004_discord_source_lifecycle',
      '0005_context_forgetting',
      '0006_context_backfill',
      '0007_context_backfill_accounting',
      '0008_context_backfill_lifecycle',
      '0009_context_backfill_targeting',
    ]);
    reopened.close();
  });

  it('bounds context by as-of event and newest thirty messages', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    const ids = Array.from({ length: 32 }, (_, index) =>
      store.record({
        content: `message ${String(index + 1)}`,
        medium: 'text',
        occurredAt: index + 1,
        platformEventId: `discord:text:${String(index + 1)}`,
        requestId: null,
        retentionDeadline: 1_000,
        role: 'human',
        speakerId: 'president',
        speakerName: 'President',
      }),
    );

    const boundary = ids.at(-1);
    if (boundary === undefined) throw new Error('expected a boundary event');
    const recent = store.recent({ beforeEventId: boundary, now: 100 });

    expect(recent.events).toHaveLength(30);
    expect(recent.events[0]?.content).toBe('message 2');
    expect(recent.events.at(-1)?.content).toBe('message 31');
    database.close();
  });

  it('includes a prior turn reply written after the current human boundary', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    store.record({
      content: 'First question',
      medium: 'text',
      occurredAt: 1,
      platformEventId: 'discord:text:first',
      requestId: 'first',
      retentionDeadline: 1_000,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    const currentId = store.record({
      content: 'Follow-up question',
      medium: 'text',
      occurredAt: 2,
      platformEventId: 'discord:text:second',
      requestId: 'second',
      retentionDeadline: 1_000,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    store.record({
      content: 'First answer',
      medium: 'text',
      occurredAt: 3,
      platformEventId: 'chief:first',
      requestId: 'first',
      retentionDeadline: 1_000,
      role: 'chief',
      speakerId: null,
      speakerName: 'Chief',
    });
    store.record({
      content: 'Later human',
      medium: 'text',
      occurredAt: 4,
      platformEventId: 'discord:text:later',
      requestId: 'later',
      retentionDeadline: 1_000,
      role: 'human',
      speakerId: 'other-president',
      speakerName: 'Other President',
    });

    const recent = store.recent({ beforeEventId: currentId, now: 10 });

    expect(recent.events.map(({ content }) => content)).toEqual([
      'First question',
      'First answer',
    ]);
    database.close();
  });

  it('stores reply chunks independently and assembles one Chief response', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    store.record({
      content: 'Give me the briefing.',
      medium: 'text',
      occurredAt: 1,
      platformEventId: '2001',
      requestId: 'briefing',
      retentionDeadline: 100,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    for (const [index, content] of [
      'First section. ',
      'Second section.',
    ].entries()) {
      store.record({
        content,
        discordMessageId: String(2002 + index),
        logicalResponseId: 'briefing-response',
        medium: 'text',
        occurredAt: 2 + index,
        platformEventId: String(2002 + index),
        replyToMessageId: '2001',
        requestId: 'briefing',
        retentionDeadline: 100,
        role: 'chief',
        speakerId: null,
        speakerName: 'Chief',
      });
    }

    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(3);
    expect(
      store.recent({ now: 10 }).events.map(({ content, role }) => ({
        content,
        role,
      })),
    ).toEqual([
      { content: 'Give me the briefing.', role: 'human' },
      { content: 'First section. Second section.', role: 'chief' },
    ]);
    database.close();
  });

  it('truncates a newest oversize event within the token budget', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    store.record({
      content: 'x'.repeat(100),
      medium: 'text',
      occurredAt: 1,
      platformEventId: 'discord:text:oversize',
      requestId: null,
      retentionDeadline: 1_000,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });

    const recent = store.recent({ maxApproxTokens: 10, now: 100 });

    expect(recent.approximateTokens).toBe(10);
    expect(recent.events[0]?.content).toBe('x'.repeat(30));
    database.close();
  });

  it('truncates an older event to fill the remaining token budget', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    for (const [index, content] of [
      'o'.repeat(12_000),
      'n'.repeat(9_000),
    ].entries()) {
      store.record({
        content,
        medium: 'text',
        occurredAt: index + 1,
        platformEventId: `discord:text:budget-${String(index)}`,
        requestId: null,
        retentionDeadline: 1_000,
        role: 'human',
        speakerId: 'president',
        speakerName: 'President',
      });
    }

    const recent = store.recent({ maxApproxTokens: 6_000, now: 100 });

    expect(recent.events.map(({ content }) => content)).toEqual([
      'o'.repeat(9_000),
      'n'.repeat(9_000),
    ]);
    expect(recent.approximateTokens).toBeGreaterThanOrEqual(4_000);
    expect(recent.approximateTokens).toBe(6_000);
    database.close();
  });

  it('limits source search after grouping Chief response chunks', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    for (let index = 0; index < 25; index += 1) {
      const eventId = store.record({
        channelId: 'main',
        content: 'ChunkBeacon',
        discordMessageId: String(52345678901235000n + BigInt(index)),
        guildId: 'presidents',
        logicalResponseId: 'chunked-response',
        medium: 'text',
        occurredAt: 100 - index,
        platformEventId: `chief:chunk:${String(index)}`,
        requestId: 'chunked-request',
        responseChunkIndex: index,
        retentionDeadline: 1_000,
        role: 'chief',
        speakerId: null,
        speakerName: 'Chief',
      });
      database
        .prepare(
          'insert into conversation_event_fts (rowid, content) values (?, ?)',
        )
        .run(eventId, 'ChunkBeacon');
    }
    const independentId = store.record({
      channelId: 'main',
      content: 'ChunkBeacon independent source.',
      discordMessageId: '52345678901235025',
      guildId: 'presidents',
      medium: 'text',
      occurredAt: 1,
      platformEventId: 'independent-source',
      requestId: 'independent-source',
      retentionDeadline: 1_000,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    database
      .prepare(
        'insert into conversation_event_fts (rowid, content) values (?, ?)',
      )
      .run(independentId, 'ChunkBeacon independent source.');

    const groups = store.searchTextSourceGroups({
      channelId: 'main',
      guildId: 'presidents',
      lexicalQuery: '"chunkbeacon"',
      lexicalRelevanceTerms: ['chunkbeacon'],
      limit: 24,
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]?.logicalResponseId).toBe('chunked-response');
    expect(groups[0]?.ids).toHaveLength(25);
    expect(groups[1]).toEqual(
      expect.objectContaining({
        content: 'ChunkBeacon independent source.',
        logicalResponseId: null,
      }),
    );
    database.close();
  });

  it('caps raw source matches while grouping responses', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    for (let index = 0; index < 97; index += 1) {
      const eventId = store.record({
        channelId: 'main',
        content: 'ScanBeacon',
        discordMessageId: String(52345678901235100n + BigInt(index)),
        guildId: 'presidents',
        logicalResponseId: 'scan-ceiling-response',
        medium: 'text',
        occurredAt: 1_000 - index,
        platformEventId: `chief:scan:${String(index)}`,
        requestId: 'scan-ceiling-request',
        responseChunkIndex: index,
        retentionDeadline: 2_000,
        role: 'chief',
        speakerId: null,
        speakerName: 'Chief',
      });
      database
        .prepare(
          'insert into conversation_event_fts (rowid, content) values (?, ?)',
        )
        .run(eventId, 'ScanBeacon');
    }
    const searchWindows: { readonly limit: number; readonly offset: number }[] =
      [];
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation((source) => {
      const statement = prepare(source);
      if (!source.includes('from conversation_event_fts f')) return statement;
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
        const limit = parameters.at(-2);
        const offset = parameters.at(-1);
        if (typeof limit === 'number' && typeof offset === 'number') {
          searchWindows.push({ limit, offset });
        }
        return all(...parameters);
      });
      return statement;
    });

    const groups = store.searchTextSourceGroups({
      channelId: 'main',
      guildId: 'presidents',
      lexicalQuery: '"scanbeacon"',
      lexicalRelevanceTerms: ['scanbeacon'],
      limit: 24,
    });

    expect(groups).toHaveLength(1);
    expect(searchWindows).not.toEqual([]);
    expect(
      searchWindows.every(({ limit, offset }) => limit + offset <= 96),
    ).toBe(true);
    vi.restoreAllMocks();
    database.close();
  });

  it('expires each reply row from recent context independently', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    store.record({
      content: 'Question near the boundary',
      medium: 'text',
      occurredAt: 1,
      platformEventId: 'discord:text:boundary',
      recentUntil: 10,
      requestId: 'boundary',
      retentionDeadline: 30,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    store.record({
      content: 'Answer just after it',
      medium: 'text',
      occurredAt: 2,
      platformEventId: 'chief:boundary',
      recentUntil: 12,
      requestId: 'boundary',
      retentionDeadline: 32,
      role: 'chief',
      speakerId: null,
      speakerName: 'Chief',
    });

    expect(
      store.recent({ now: 9 }).events.map(({ content }) => content),
    ).toEqual(['Question near the boundary', 'Answer just after it']);
    expect(
      store.recent({ now: 10 }).events.map(({ content }) => content),
    ).toEqual(['Answer just after it']);
    expect(store.maintain(10)).toEqual({ deletedEvents: 0 });
    expect(
      database
        .prepare('select content from conversation_events where id = 1')
        .pluck()
        .get(),
    ).toBe('Question near the boundary');
    expect(store.recent({ now: 12 }).events).toEqual([]);
    database.close();
  });

  it('scrubs expired text content and deletes expired voice rows', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    const textId = store.record({
      attachmentMetadataJson: '[{"name":"agenda.txt"}]',
      channelId: 'channel-1',
      content: 'Raw text',
      discordMessageId: '1001',
      guildId: 'guild-1',
      medium: 'text',
      occurredAt: 1,
      platformEventId: '1001',
      recentUntil: 10,
      requestId: null,
      retentionDeadline: 20,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    store.record({
      content: 'Raw voice',
      medium: 'voice',
      occurredAt: 1,
      platformEventId: 'voice-1',
      recentUntil: 10,
      requestId: null,
      retentionDeadline: 20,
      role: 'human',
      speakerId: 'president',
      speakerName: 'President',
    });
    database
      .prepare(
        'insert into conversation_event_fts (rowid, content) values (?, ?)',
      )
      .run(textId, 'Raw text');

    expect(store.maintain(20)).toEqual({ deletedEvents: 2 });
    expect(
      database
        .prepare(
          `select content, attachment_metadata_json as attachmentMetadataJson,
                  content_state as contentState,
                  content_state_reason as contentStateReason,
                  discord_message_id as discordMessageId
           from conversation_events where id = ?`,
        )
        .get(textId),
    ).toEqual({
      attachmentMetadataJson: '[]',
      content: '',
      contentState: 'scrubbed',
      contentStateReason: 'retention-expired',
      discordMessageId: '1001',
    });
    expect(
      database
        .prepare(
          "select count(*) from conversation_events where medium = 'voice'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from conversation_event_fts')
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('does not backfill raw memory sources into conversation', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    database
      .prepare(
        `insert into source_events
           (platform_source_id, speaker_id, medium, content, occurred_at,
            retention_deadline)
         values ('old-source', 'president', 'text', 'old raw event', 1, 1000)`,
      )
      .run();

    expect(new ConversationStore(database).recent({ now: 2 }).events).toEqual(
      [],
    );
    database.close();
  });

  it('returns no context when either caller bound is zero', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);

    expect(store.recent({ maxMessages: 0, now: 1 })).toEqual({
      approximateTokens: 0,
      events: [],
    });
    expect(store.recent({ maxApproxTokens: 0, now: 1 })).toEqual({
      approximateTokens: 0,
      events: [],
    });
    database.close();
  });
});
