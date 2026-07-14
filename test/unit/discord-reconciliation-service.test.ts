import { describe, expect, it, vi } from 'vitest';

import {
  buildDiscordHistoryPage,
  discordHistoryFetchRequest,
  DiscordReconciliationService,
  rateLimitedDiscordHistoryPage,
} from '../../src/discord/discord-reconciliation-service.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const deletedId = '52345678901234567';
const editedId = '52345678901234568';
const createdId = '52345678901234569';

function normalized(
  messageId: string,
  content: string,
  editedAt: number | null,
) {
  return {
    attachmentMetadataJson: '[]',
    authorKind: 'human' as const,
    canModerateContext: false,
    content,
    editedAt,
    messageId,
    occurredAt: 1_000,
    replyToMessageId: null,
    requesterId: '42345678901234567',
    revisionChecksum: `${messageId}:${content}`,
    speakerName: 'President Test',
  };
}

function seedAvailable(
  database: ReturnType<typeof openChiefDatabase>,
  messageId: string,
  content: string,
) {
  database
    .prepare(
      `insert into conversation_events
         (platform_event_id, discord_message_id, guild_id, channel_id,
          request_id, logical_response_id, role, speaker_id, speaker_name,
          medium, reply_to_message_id, content, attachment_metadata_json,
          occurred_at, edited_at, recent_until, retention_deadline,
          content_state, content_state_reason, revision_checksum)
       values (?, ?, ?, ?, ?, null, 'human', ?, 'President Test', 'text',
               null, ?, '[]', 1000, null, 999999999, 999999999,
               'available', 'retained', ?)`,
    )
    .run(
      messageId,
      messageId,
      guildId,
      channelId,
      messageId,
      '42345678901234567',
      content,
      `${messageId}:${content}`,
    );
}

describe('Discord history pagination', () => {
  it('uses an after anchor once and a before cursor for continuation', () => {
    expect(
      discordHistoryFetchRequest({
        afterMessageId: '100',
        cursor: null,
        mode: 'incremental',
        retentionCutoff: 0,
      }),
    ).toEqual({ after: '100', limit: 100 });
    expect(
      discordHistoryFetchRequest({
        afterMessageId: '100',
        cursor: '200',
        mode: 'incremental',
        retentionCutoff: 0,
      }),
    ).toEqual({ before: '200', limit: 100 });
  });

  it('proves nonterminal coverage and advances from the oldest identity', () => {
    const input = {
      afterMessageId: null,
      cursor: null,
      mode: 'full' as const,
      retentionCutoff: 500,
    };
    const fetched = Array.from({ length: 100 }, (_, index) => ({
      item: {
        messageId: String(1_000 + index),
        occurredAt: 1_000,
        revisionChecksum: `revision-${String(index)}`,
      },
      messageId: String(1_000 + index),
      occurredAt: 1_000,
    }));

    expect(buildDiscordHistoryPage(input, fetched)).toMatchObject({
      complete: true,
      coverage: { newestMessageId: '1099', oldestMessageId: '1000' },
      nextCursor: '1000',
      rateLimited: false,
    });
  });

  it('terminates at incremental and retention boundaries', () => {
    const incremental = buildDiscordHistoryPage(
      {
        afterMessageId: '1000',
        cursor: '1100',
        mode: 'incremental',
        retentionCutoff: 500,
      },
      Array.from({ length: 100 }, (_, index) => {
        const messageId = String(1_099 - index);
        return {
          item: {
            messageId,
            occurredAt: 1_000,
            revisionChecksum: messageId,
          },
          messageId,
          occurredAt: 1_000,
        };
      }),
    );
    expect(incremental.nextCursor).toBeNull();
    expect(incremental.items.every(({ messageId }) => messageId > '1000')).toBe(
      true,
    );

    const retained = buildDiscordHistoryPage(
      {
        afterMessageId: null,
        cursor: '1100',
        mode: 'retained',
        retentionCutoff: 900,
      },
      Array.from({ length: 100 }, (_, index) => {
        const messageId = String(1_099 - index);
        const occurredAt = index === 99 ? 899 : 1_000;
        return {
          item: { messageId, occurredAt, revisionChecksum: messageId },
          messageId,
          occurredAt,
        };
      }),
    );
    expect(retained.nextCursor).toBeNull();
    expect(retained.items).toHaveLength(99);
    expect(retained.coverage?.oldestMessageId).toBe('0');
  });

  it('returns an incomplete rate-limited proof at the durable cursor', () => {
    expect(
      rateLimitedDiscordHistoryPage({
        afterMessageId: '100',
        cursor: '200',
        mode: 'incremental',
        retentionCutoff: 0,
      }),
    ).toEqual({
      complete: false,
      coverage: null,
      items: [],
      nextCursor: '200',
      rateLimited: true,
    });
  });
});

describe('DiscordReconciliationService', () => {
  it('applies an offline create and edit then infers a covered deletion', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    seedAvailable(database, deletedId, 'Deleted while offline.');
    seedAvailable(database, editedId, 'Old wording.');
    const applyTextSource = vi.fn();
    const deleteTextSource = vi.fn();
    const fetchPage = vi.fn(({ mode }: { mode: string }) =>
      Promise.resolve(
        mode === 'incremental'
          ? {
              complete: true,
              coverage: {
                newestMessageId: createdId,
                oldestMessageId: editedId,
              },
              items: [
                {
                  messageId: createdId,
                  occurredAt: 1_100,
                  revisionChecksum: 'created',
                  source: normalized(createdId, 'Created while offline.', null),
                },
              ],
              nextCursor: null,
              rateLimited: false,
            }
          : {
              complete: true,
              coverage: {
                newestMessageId: createdId,
                oldestMessageId: deletedId,
              },
              items: [
                {
                  messageId: editedId,
                  occurredAt: 1_000,
                  revisionChecksum: 'edited',
                  source: normalized(editedId, 'Edited while offline.', 1_200),
                },
                {
                  messageId: createdId,
                  occurredAt: 1_100,
                  revisionChecksum: 'created',
                },
              ],
              nextCursor: null,
              rateLimited: false,
            },
      ),
    );
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: { fetchPage },
      lifecycle: { applyTextSource, deleteTextSource },
      now: () => 2_000,
    });

    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'completed',
    });

    expect(applyTextSource).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Created while offline.' }),
    );
    expect(applyTextSource).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Edited while offline.' }),
    );
    expect(deleteTextSource).toHaveBeenCalledWith({
      deletedAt: 2_000,
      messageId: deletedId,
    });
    expect(fetchPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: 'incremental' }),
    );
    expect(fetchPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: 'retained' }),
    );
    database.close();
  });

  it.each([
    { complete: false, rateLimited: false, status: 'incomplete' },
    { complete: false, rateLimited: true, status: 'rate-limited' },
  ])('never infers deletion from a $status pass', async (page) => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    seedAvailable(database, deletedId, 'Must remain available.');
    const deleteTextSource = vi.fn();
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: {
        fetchPage: () =>
          Promise.resolve({
            complete: page.complete,
            coverage: {
              newestMessageId: createdId,
              oldestMessageId: deletedId,
            },
            items: [],
            nextCursor: 'content-free-cursor',
            rateLimited: page.rateLimited,
          }),
      },
      lifecycle: { applyTextSource: vi.fn(), deleteTextSource },
      now: () => 2_000,
    });

    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: page.status,
    });
    expect(deleteTextSource).not.toHaveBeenCalled();
    expect(
      database
        .prepare(`select cursor_message_id from discord_reconciliation_state`)
        .pluck()
        .get(),
    ).toBe('content-free-cursor');
    database.close();
  });

  it('resumes a content-free cursor and accumulates page coverage', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const fetchPage = vi.fn(
      ({ cursor, mode }: { cursor: string | null; mode: string }) => {
        if (mode === 'retained') {
          return Promise.resolve({
            complete: true,
            coverage: null,
            items: [],
            nextCursor: null,
            rateLimited: false,
          });
        }
        if (cursor === null) {
          return Promise.resolve({
            complete: false,
            coverage: {
              newestMessageId: createdId,
              oldestMessageId: editedId,
            },
            items: [],
            nextCursor: editedId,
            rateLimited: false,
          });
        }
        return Promise.resolve({
          complete: true,
          coverage: {
            newestMessageId: editedId,
            oldestMessageId: deletedId,
          },
          items: [],
          nextCursor: null,
          rateLimited: false,
        });
      },
    );
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: { fetchPage },
      lifecycle: { applyTextSource: vi.fn(), deleteTextSource: vi.fn() },
      now: () => 2_000,
    });

    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'incomplete',
    });
    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'completed',
    });

    expect(fetchPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: editedId, mode: 'incremental' }),
    );
    expect(service.diagnostics()).toEqual({
      highWaterMessageId: createdId,
      lagMs: 0,
      lastCompleteAt: 2_000,
    });
    database.close();
  });

  it('resumes an interrupted retained pass before restarting incremental', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    let retainedAttempts = 0;
    const fetchPage = vi.fn(
      ({ mode }: { cursor: string | null; mode: string }) => {
        if (mode === 'incremental') {
          return Promise.resolve({
            complete: true,
            coverage: null,
            items: [],
            nextCursor: null,
            rateLimited: false,
          });
        }
        retainedAttempts += 1;
        return Promise.resolve({
          complete: retainedAttempts > 1,
          coverage: {
            newestMessageId: createdId,
            oldestMessageId: editedId,
          },
          items: [],
          nextCursor: retainedAttempts === 1 ? editedId : null,
          rateLimited: retainedAttempts === 1,
        });
      },
    );
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: { fetchPage },
      lifecycle: { applyTextSource: vi.fn(), deleteTextSource: vi.fn() },
      now: () => 2_000,
    });

    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'rate-limited',
    });
    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'completed',
    });

    expect(fetchPage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ cursor: editedId, mode: 'retained' }),
    );
    expect(
      fetchPage.mock.calls.filter(([input]) => input.mode === 'incremental'),
    ).toHaveLength(1);
    database.close();
  });

  it('runs identity-only full scans weekly and skips a fresh repeat', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    seedAvailable(database, deletedId, 'Deleted before weekly scan.');
    const applyTextSource = vi.fn();
    const deleteTextSource = vi.fn();
    let now = 2_000;
    const fetchPage = vi.fn(() =>
      Promise.resolve({
        complete: true,
        coverage: {
          newestMessageId: createdId,
          oldestMessageId: deletedId,
        },
        items: [
          {
            messageId: createdId,
            occurredAt: 1_500,
            revisionChecksum: 'weekly-created',
            source: normalized(createdId, 'Must not be applied.', null),
          },
        ],
        nextCursor: null,
        rateLimited: false,
      }),
    );
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: { fetchPage },
      lifecycle: { applyTextSource, deleteTextSource },
      now: () => now,
    });

    expect(service.diagnostics()).toEqual({
      highWaterMessageId: null,
      lagMs: null,
      lastCompleteAt: null,
    });
    await expect(service.reconcileWeeklyIdentity()).resolves.toEqual({
      status: 'completed',
    });
    expect(applyTextSource).not.toHaveBeenCalled();
    expect(deleteTextSource).toHaveBeenCalledWith({
      deletedAt: 2_000,
      messageId: deletedId,
    });

    now += 24 * 60 * 60 * 1_000;
    await expect(service.reconcileWeeklyIdentity()).resolves.toEqual({
      status: 'completed',
    });
    expect(fetchPage).toHaveBeenCalledOnce();
    database.close();
  });

  it('preserves a full-scan cursor while gap reconciliation runs', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    let fullAttempts = 0;
    const fetchPage = vi.fn(
      ({ mode }: { cursor: string | null; mode: string }) => {
        if (mode === 'full') {
          fullAttempts += 1;
          return Promise.resolve({
            complete: fullAttempts > 1,
            coverage: {
              newestMessageId: createdId,
              oldestMessageId: editedId,
            },
            items: [],
            nextCursor: fullAttempts === 1 ? editedId : null,
            rateLimited: fullAttempts === 1,
          });
        }
        return Promise.resolve({
          complete: true,
          coverage: null,
          items: [],
          nextCursor: null,
          rateLimited: false,
        });
      },
    );
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: { fetchPage },
      lifecycle: { applyTextSource: vi.fn(), deleteTextSource: vi.fn() },
      now: () => 2_000,
    });

    await expect(service.reconcileWeeklyIdentity()).resolves.toEqual({
      status: 'rate-limited',
    });
    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'completed',
    });
    await expect(service.reconcileWeeklyIdentity()).resolves.toEqual({
      status: 'completed',
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: editedId, mode: 'full' }),
    );
    database.close();
  });

  it('returns failed for a history fetch error without deletion', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    seedAvailable(database, deletedId, 'Must survive a failed pass.');
    const deleteTextSource = vi.fn();
    const service = new DiscordReconciliationService({
      channelId,
      database,
      guildId,
      history: {
        fetchPage: () => Promise.reject(new Error('Discord unavailable')),
      },
      lifecycle: { applyTextSource: vi.fn(), deleteTextSource },
      now: () => 2_000,
    });

    await expect(service.reconcileAfterGap()).resolves.toEqual({
      status: 'failed',
    });
    expect(deleteTextSource).not.toHaveBeenCalled();
    database.close();
  });
});
