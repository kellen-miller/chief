import { describe, expect, it } from 'vitest';

import { qualifyTextMessage } from '../../src/discord/invocation-policy.js';

const allowed = {
  botUserId: 'chief',
  channelId: 'main-text',
  guildId: 'presidents',
} as const;

describe('qualifyTextMessage', () => {
  it('ignores an unmentioned message while retaining it as context', () => {
    expect(
      qualifyTextMessage(allowed, {
        authorIsBot: false,
        channelId: 'main-text',
        content: 'Lunch at noon',
        guildId: 'presidents',
        isThread: false,
        webhookId: null,
      }),
    ).toEqual({ content: 'Lunch at noon', kind: 'observe' });
  });

  it('returns a greeting for a bare Chief mention', () => {
    expect(
      qualifyTextMessage(allowed, {
        authorIsBot: false,
        channelId: 'main-text',
        content: '<@chief>',
        guildId: 'presidents',
        isThread: false,
        webhookId: null,
      }),
    ).toEqual({ content: 'Chief', kind: 'greeting' });
  });

  it('extracts the request from a Chief mention', () => {
    expect(
      qualifyTextMessage(allowed, {
        authorIsBot: false,
        channelId: 'main-text',
        content: '<@chief> brief us',
        guildId: 'presidents',
        isThread: false,
        webhookId: null,
      }),
    ).toEqual({
      content: 'Chief, brief us',
      kind: 'request',
      prompt: 'brief us',
    });
  });

  it('preserves middle, trailing, and repeated mentions as Chief', () => {
    const candidate = (content: string) => ({
      authorIsBot: false,
      channelId: 'main-text',
      content,
      guildId: 'presidents',
      isThread: false,
      webhookId: null,
    });

    expect(
      qualifyTextMessage(
        allowed,
        candidate('This list <@chief> remember no military academy'),
      ),
    ).toEqual({
      content: 'This list Chief remember no military academy',
      kind: 'request',
      prompt: 'This list Chief remember no military academy',
    });
    expect(
      qualifyTextMessage(allowed, candidate('What do you think <@chief>?')),
    ).toEqual({
      content: 'What do you think Chief?',
      kind: 'request',
      prompt: 'What do you think Chief?',
    });
    expect(
      qualifyTextMessage(
        allowed,
        candidate('<@chief>, tell <@!chief> what Chief thinks'),
      ),
    ).toEqual({
      content: 'Chief, tell Chief what Chief thinks',
      kind: 'request',
      prompt: 'tell Chief what Chief thinks',
    });
  });

  it('ignores disallowed surfaces before reading content', () => {
    expect(
      qualifyTextMessage(allowed, {
        authorIsBot: false,
        channelId: 'other',
        content: '<@chief> secret',
        guildId: 'presidents',
        isThread: false,
        webhookId: null,
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it.each([
    { authorIsBot: true },
    { guildId: 'other-guild' },
    { isThread: true },
    { webhookId: 'webhook' },
  ])('ignores another disallowed message shape', (override) => {
    expect(
      qualifyTextMessage(allowed, {
        authorIsBot: false,
        channelId: 'main-text',
        content: '<@chief> secret',
        guildId: 'presidents',
        isThread: false,
        webhookId: null,
        ...override,
      }),
    ).toEqual({ kind: 'ignore' });
  });
});
