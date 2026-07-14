import { describe, expect, it, vi } from 'vitest';

import { DiscordTextController } from '../../src/discord/text-controller.js';

const allowed = {
  botUserId: '12345678901234567',
  channelId: '22345678901234567',
  guildId: '32345678901234567',
};

function message(content: string) {
  return {
    authorDisplayName: 'President Test',
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
    const reply = vi.fn();
    const handleText = vi.fn(() => Promise.resolve(null));
    const controller = new DiscordTextController(allowed, {
      handleText,
      now: () => 1_000,
      recordDeliveredReply: vi.fn(),
    });

    await controller.handle(message('Dinner is at seven.'), {
      reply,
      typing: vi.fn(),
    });

    expect(handleText).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Dinner is at seven.',
        kind: 'observe',
        speakerName: 'President Test',
      }),
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it('answers a direct mention and only suffixes the final chunk', async () => {
    const deliveredIds = ['62345678901234567', '62345678901234568'];
    let replyIndex = 0;
    const reply = vi.fn<(content: string) => Promise<string>>(() =>
      Promise.resolve(deliveredIds[replyIndex++] ?? 'unexpected'),
    );
    const recordDeliveredReply = vi.fn();
    const controller = new DiscordTextController(allowed, {
      handleText: vi.fn(() =>
        Promise.resolve({
          citations: [],
          content: `${'brief '.repeat(450)}Mr. President`,
          status: 'completed' as const,
        }),
      ),
      now: () => 1_000,
      recordDeliveredReply,
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
    expect(recordDeliveredReply).toHaveBeenCalledTimes(reply.mock.calls.length);
    for (const [index, [content]] of reply.mock.calls.entries()) {
      expect(recordDeliveredReply).toHaveBeenNthCalledWith(index + 1, {
        chunks: [{ content, messageId: deliveredIds[index] }],
        logicalResponseId: message('').id,
        replyToMessageId: message('').id,
        requestId: message('').id,
      });
    }
  });

  it('records each successful chunk before a later send fails', async () => {
    const recordDeliveredReply = vi.fn();
    const reply = vi
      .fn<(content: string) => Promise<string>>()
      .mockResolvedValueOnce('62345678901234567')
      .mockRejectedValueOnce(new Error('Discord send failed'));
    const controller = new DiscordTextController(allowed, {
      handleText: vi.fn(() =>
        Promise.resolve({
          citations: [],
          content: `${'brief '.repeat(450)}Mr. President`,
          status: 'completed' as const,
        }),
      ),
      now: () => 1_000,
      recordDeliveredReply,
    });

    await expect(
      controller.handle(message(`<@${allowed.botUserId}> brief us`), {
        reply,
        typing: vi.fn(() => Promise.resolve()),
      }),
    ).rejects.toThrow('Discord send failed');
    expect(recordDeliveredReply).toHaveBeenCalledOnce();
    expect(recordDeliveredReply).toHaveBeenCalledWith({
      chunks: [
        {
          content: reply.mock.calls[0]?.[0],
          messageId: '62345678901234567',
        },
      ],
      logicalResponseId: message('').id,
      replyToMessageId: message('').id,
      requestId: message('').id,
    });
  });

  it('records nothing when the first chunk send fails', async () => {
    const recordDeliveredReply = vi.fn();
    const controller = new DiscordTextController(allowed, {
      handleText: vi.fn(() =>
        Promise.resolve({
          citations: [],
          content: 'Briefing failed Mr. President',
          status: 'completed' as const,
        }),
      ),
      now: () => 1_000,
      recordDeliveredReply,
    });

    await expect(
      controller.handle(message(`<@${allowed.botUserId}> brief us`), {
        reply: vi.fn(() => Promise.reject(new Error('Discord send failed'))),
        typing: vi.fn(() => Promise.resolve()),
      }),
    ).rejects.toThrow('Discord send failed');
    expect(recordDeliveredReply).not.toHaveBeenCalled();
  });

  it('normalizes mentions for memory and renders missing source links', async () => {
    const handleText = vi.fn(() =>
      Promise.resolve({
        citations: ['https://example.com/current'],
        content: 'Current answer Mr. President',
        status: 'completed' as const,
      }),
    );
    const reply = vi
      .fn<(content: string) => Promise<string>>()
      .mockResolvedValue('62345678901234567');
    const controller = new DiscordTextController(allowed, {
      handleText,
      now: () => 1_000,
      recordDeliveredReply: vi.fn(),
    });

    await controller.handle(
      message(`<@${allowed.botUserId}> remember dinner`),
      {
        reply,
        typing: vi.fn(() => Promise.resolve()),
      },
    );

    expect(handleText).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Chief, remember dinner',
        prompt: 'remember dinner',
      }),
    );
    expect(reply).toHaveBeenCalledWith(
      'Current answer Sources: https://example.com/current Mr. President',
    );
  });

  it('delivers the orchestrator reply for a bare mention', async () => {
    const reply = vi
      .fn<(content: string) => Promise<string>>()
      .mockResolvedValue('62345678901234567');
    const handleText = vi.fn(() =>
      Promise.resolve({
        citations: [],
        content: 'At your service, Mr. President',
        status: 'completed' as const,
      }),
    );
    const controller = new DiscordTextController(allowed, {
      handleText,
      now: () => 1_000,
      recordDeliveredReply: vi.fn(),
    });

    await controller.handle(message(`<@!${allowed.botUserId}>`), {
      reply,
      typing: vi.fn(),
    });

    expect(handleText).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Chief', kind: 'greeting' }),
    );
    expect(reply).toHaveBeenCalledWith('At your service, Mr. President');
  });
});
