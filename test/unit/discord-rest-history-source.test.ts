import { REST } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordRestHistorySource } from '../../src/discord/rest-history-source.js';

const guildId = '12345678901234567';
const channelId = '22345678901234567';
const botUserId = '32345678901234567';

describe('DiscordRestHistorySource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes the approved source surface through Discord REST pagination', async () => {
    const get = vi.fn(() =>
      Promise.resolve([
        rawMessage('62345678901234567', 'Human words', 'human-user'),
        rawMessage('52345678901234567', 'Chief words', botUserId, true),
        rawMessage('42345678901234567', 'Other bot words', 'other-bot', true),
        {
          ...rawMessage('32345678901234568', 'Webhook words', 'hook'),
          webhook_id: 'webhook',
        },
      ]),
    );
    const source = new DiscordRestHistorySource({
      botUserId,
      channelId,
      dependencies: { get },
      guildId,
      token: 'not-used-by-the-fake',
    });

    const result = await source.fetchPage({
      afterMessageId: null,
      cursor: '72345678901234567',
      mode: 'backfill',
      retentionCutoff: 0,
      scanUpperBoundMessageId: null,
    });

    expect(get).toHaveBeenCalledWith(`/channels/${channelId}/messages`, {
      before: '72345678901234567',
      limit: 100,
    });
    expect(result.items.map(({ source: item }) => item?.authorKind)).toEqual([
      'human',
      'chief',
    ]);
    expect(result.items.map(({ source: item }) => item?.content)).toEqual([
      'Human words',
      'Chief words',
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a durable rate-limit boundary without sleeping', async () => {
    const get = vi.fn(() =>
      Promise.reject(Object.assign(new Error('rate limited'), { status: 429 })),
    );
    const source = new DiscordRestHistorySource({
      botUserId,
      channelId,
      dependencies: { get },
      guildId,
      token: 'not-used-by-the-fake',
    });
    const input = {
      afterMessageId: null,
      cursor: '72345678901234567',
      mode: 'backfill' as const,
      retentionCutoff: 0,
      scanUpperBoundMessageId: null,
    };

    await expect(source.fetchPage(input)).resolves.toEqual({
      complete: false,
      coverage: null,
      items: [],
      nextCursor: input.cursor,
      rateLimited: true,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('uses the discord.js REST manager in production', async () => {
    const get = vi
      .spyOn(REST.prototype, 'get')
      .mockResolvedValue([rawMessage('62345678901234567', 'Managed', 'human')]);
    const source = new DiscordRestHistorySource({
      botUserId,
      channelId,
      guildId,
      token: 'fake-token',
    });

    const result = await source.fetchPage({
      afterMessageId: null,
      cursor: null,
      mode: 'backfill',
      retentionCutoff: 0,
      scanUpperBoundMessageId: null,
    });

    expect(result.items).toHaveLength(1);
    const request = get.mock.calls[0]?.[1];
    const query = request?.query;
    if (query === undefined) {
      throw new Error('expected REST query parameters');
    }
    expect(query).toBeInstanceOf(URLSearchParams);
    expect(query.get('limit')).toBe('100');
  });

  it('supports content-free full scans with optional Discord fields', async () => {
    const message = rawMessage(
      '62345678901234567',
      'Manifest-only words',
      'human',
    );
    const source = new DiscordRestHistorySource({
      botUserId,
      channelId,
      dependencies: {
        get: () =>
          Promise.resolve([
            {
              ...message,
              attachments: undefined,
              edited_timestamp: new Date(2_000).toISOString(),
            },
          ]),
      },
      guildId,
      token: 'fake-token',
    });

    const result = await source.fetchPage({
      afterMessageId: null,
      cursor: null,
      mode: 'full',
      retentionCutoff: 0,
      scanUpperBoundMessageId: message.id,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        messageId: message.id,
      }),
    ]);
    expect(result.items[0]?.source).toBeUndefined();
  });

  it('rejects malformed arrays and timestamps without content logging', async () => {
    const malformed = new DiscordRestHistorySource({
      botUserId,
      channelId,
      dependencies: { get: () => Promise.resolve({ messages: [] }) },
      guildId,
      token: 'fake-token',
    });
    const invalidTimestamp = new DiscordRestHistorySource({
      botUserId,
      channelId,
      dependencies: {
        get: () =>
          Promise.resolve([
            {
              ...rawMessage(
                '62345678901234567',
                'Private malformed content',
                'human',
              ),
              timestamp: 'not-a-timestamp',
            },
          ]),
      },
      guildId,
      token: 'fake-token',
    });
    const input = {
      afterMessageId: null,
      cursor: null,
      mode: 'backfill' as const,
      retentionCutoff: 0,
      scanUpperBoundMessageId: null,
    };

    await expect(malformed.fetchPage(input)).rejects.toThrow(/message array/u);
    await expect(invalidTimestamp.fetchPage(input)).rejects.toThrow(
      /invalid timestamp/u,
    );
  });
});

function rawMessage(
  id: string,
  content: string,
  authorId: string,
  bot = false,
) {
  return {
    attachments: [],
    author: {
      bot,
      global_name: null,
      id: authorId,
      username: `user-${authorId}`,
    },
    channel_id: channelId,
    content,
    edited_timestamp: null,
    id,
    member: null,
    message_reference: null,
    timestamp: new Date(1_000 + Number(BigInt(id) % 1_000n)).toISOString(),
    webhook_id: null,
  };
}
