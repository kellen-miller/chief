import { describe, expect, it, vi } from 'vitest';

import {
  contextPermissionSnapshot,
  normalizeDiscordSourceMessage,
} from '../../src/discord/source-message.js';

const allowed = {
  botUserId: '12345678901234567',
  channelId: '22345678901234567',
  guildId: '32345678901234567',
} as const;

function candidate(
  overrides: Partial<Parameters<typeof normalizeDiscordSourceMessage>[1]> = {},
) {
  return {
    attachments: [
      {
        description: 'Public launch brief',
        id: 'sensitive-platform-id',
        name: 'brief.txt',
        url: 'https://cdn.discord.test/private-token',
      },
    ],
    authorDisplayName: 'President Test',
    authorId: '42345678901234567',
    authorIsBot: false,
    canModerateContext: false,
    channelId: allowed.channelId,
    content: 'Dinner is at seven.',
    editedAt: null,
    guildId: allowed.guildId,
    id: '52345678901234567',
    isThread: false,
    occurredAt: 1_000,
    replyToMessageId: '52345678901234566',
    webhookId: null,
    ...overrides,
  };
}

describe('normalizeDiscordSourceMessage', () => {
  it('normalizes a human source with safe attachment metadata', () => {
    const normalized = normalizeDiscordSourceMessage(allowed, candidate());

    expect(normalized).toEqual({
      attachmentMetadataJson:
        '[{"description":"Public launch brief","name":"brief.txt"}]',
      authorKind: 'human',
      canModerateContext: false,
      content: 'Dinner is at seven.',
      editedAt: null,
      messageId: '52345678901234567',
      occurredAt: 1_000,
      replyToMessageId: '52345678901234566',
      requesterId: '42345678901234567',
      speakerName: 'President Test',
    });
    expect(normalized?.attachmentMetadataJson).not.toContain('url');
    expect(normalized?.attachmentMetadataJson).not.toContain('id');
  });

  it('accepts Chief and rejects every other bot or surface', () => {
    expect(
      normalizeDiscordSourceMessage(
        allowed,
        candidate({
          authorDisplayName: 'Chief',
          authorId: allowed.botUserId,
          authorIsBot: true,
        }),
      ),
    ).toMatchObject({ authorKind: 'chief' });

    for (const override of [
      { authorId: 'other-bot', authorIsBot: true },
      { webhookId: 'webhook' },
      { isThread: true },
      { channelId: 'other-channel' },
      { guildId: 'other-guild' },
    ]) {
      expect(
        normalizeDiscordSourceMessage(allowed, candidate(override)),
      ).toBeNull();
    }
  });
});

describe('contextPermissionSnapshot', () => {
  it('reads current authority only for destructive requests', () => {
    const currentAuthority = vi.fn(() => true);

    expect(
      contextPermissionSnapshot('Chief, summarize dinner', currentAuthority),
    ).toBe(false);
    expect(currentAuthority).not.toHaveBeenCalled();

    expect(
      contextPermissionSnapshot(
        'We discussed who can delete old posts.',
        currentAuthority,
      ),
    ).toBe(false);
    expect(currentAuthority).not.toHaveBeenCalled();

    expect(
      contextPermissionSnapshot(
        'Chief, forget every message from Alex',
        currentAuthority,
      ),
    ).toBe(true);
    expect(currentAuthority).toHaveBeenCalledOnce();

    expect(
      contextPermissionSnapshot(
        'Chief, could you please delete the launch topic?',
        currentAuthority,
      ),
    ).toBe(true);
    expect(currentAuthority).toHaveBeenCalledTimes(2);
  });

  it('fails closed when current member authority is unavailable', () => {
    expect(
      contextPermissionSnapshot(
        'Chief, delete the launch topic',
        () => undefined,
      ),
    ).toBe(false);
  });
});
