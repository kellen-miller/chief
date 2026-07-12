import { describe, expect, it, vi } from 'vitest';

import { DiscordTextController } from '../../src/discord/text-controller.js';

const allowed = {
  botUserId: '12345678901234567',
  channelId: '22345678901234567',
  guildId: '32345678901234567',
};

function message(content: string) {
  return {
    authorId: '42345678901234567',
    authorIsBot: false,
    channelId: allowed.channelId,
    content,
    guildId: allowed.guildId,
    id: '52345678901234567',
    isThread: false,
    webhookId: null,
  };
}

describe('DiscordTextController', () => {
  it('observes an allowed unmentioned message without replying', async () => {
    const observe = vi.fn();
    const reply = vi.fn();
    const handleText = vi.fn();
    const controller = new DiscordTextController(allowed, {
      handleText,
      now: () => 1_000,
      observe,
    });

    await controller.handle(message('Dinner is at seven.'), {
      reply,
      typing: vi.fn(),
    });

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Dinner is at seven.',
        retentionDeadline: 1_000 + 30 * 24 * 60 * 60 * 1_000,
      }),
    );
    expect(handleText).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('answers a direct mention and only suffixes the final chunk', async () => {
    const reply = vi
      .fn<(content: string) => Promise<void>>()
      .mockResolvedValue();
    const controller = new DiscordTextController(allowed, {
      handleText: vi.fn(() =>
        Promise.resolve({
          citations: [],
          content: `${'brief '.repeat(450)}Mr. President`,
          status: 'completed' as const,
        }),
      ),
      now: () => 1_000,
      observe: vi.fn(),
    });

    await controller.handle(message(`<@${allowed.botUserId}> brief us`), {
      reply,
      typing: vi.fn(() => Promise.resolve()),
    });

    expect(reply.mock.calls.length).toBeGreaterThan(1);
    expect(reply.mock.calls.at(-1)?.[0]).toMatch(/Mr\. President$/u);
    expect(
      reply.mock.calls
        .slice(0, -1)
        .every(([chunk]) => !chunk.endsWith('Mr. President')),
    ).toBe(true);
  });

  it('normalizes mentions for memory and renders missing source links', async () => {
    const observe = vi.fn();
    const reply = vi
      .fn<(content: string) => Promise<void>>()
      .mockResolvedValue();
    const controller = new DiscordTextController(allowed, {
      handleText: () =>
        Promise.resolve({
          citations: ['https://example.com/current'],
          content: 'Current answer Mr. President',
          status: 'completed',
        }),
      now: () => 1_000,
      observe,
    });

    await controller.handle(
      message(`<@${allowed.botUserId}> remember dinner`),
      {
        reply,
        typing: vi.fn(() => Promise.resolve()),
      },
    );

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Chief, remember dinner' }),
    );
    expect(reply).toHaveBeenCalledWith(
      'Current answer Sources: https://example.com/current Mr. President',
    );
  });

  it('answers a bare mention locally without paid generation', async () => {
    const reply = vi
      .fn<(content: string) => Promise<void>>()
      .mockResolvedValue();
    const handleText = vi.fn();
    const controller = new DiscordTextController(allowed, {
      handleText,
      now: () => 1_000,
      observe: vi.fn(),
    });

    await controller.handle(message(`<@!${allowed.botUserId}>`), {
      reply,
      typing: vi.fn(),
    });

    expect(handleText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('At your service, Mr. President');
  });
});
