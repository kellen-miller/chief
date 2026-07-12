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
    ).toEqual({ kind: 'observe' });
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
    ).toEqual({ kind: 'greeting' });
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
    ).toEqual({ kind: 'request', prompt: 'brief us' });
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
});
