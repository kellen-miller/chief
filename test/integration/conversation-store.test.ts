import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
    ).toEqual(['0001_initial', '0002_conversation_events']);
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

  it('stops before an older event that would exceed the remaining budget', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    for (const [index, content] of ['o'.repeat(30), 'n'.repeat(15)].entries()) {
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

    const recent = store.recent({ maxApproxTokens: 6, now: 100 });

    expect(recent.events.map(({ content }) => content)).toEqual([
      'n'.repeat(15),
    ]);
    expect(recent.approximateTokens).toBe(5);
    database.close();
  });

  it('records platform events idempotently and expires them explicitly', () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new ConversationStore(database);
    const event = {
      content: 'first version',
      medium: 'text' as const,
      occurredAt: 1,
      platformEventId: 'discord:text:idempotent',
      requestId: null,
      retentionDeadline: 10,
      role: 'human' as const,
      speakerId: 'president',
      speakerName: 'President',
    };
    const firstId = store.record(event);
    const secondId = store.record({ ...event, content: 'corrected version' });

    expect(secondId).toBe(firstId);
    expect(store.recent({ now: 9 }).events[0]?.content).toBe(
      'corrected version',
    );
    expect(store.maintain(10)).toEqual({ deletedEvents: 1 });
    expect(store.recent({ now: 10 }).events).toEqual([]);
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
