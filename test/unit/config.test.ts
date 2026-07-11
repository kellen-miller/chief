import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/config.js';

const validEnvironment = {
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_GUILD_ID: '223456789012345678',
  DISCORD_MAIN_TEXT_CHANNEL_ID: '323456789012345678',
  DISCORD_MAIN_VOICE_CHANNEL_ID: '423456789012345678',
  DISCORD_TOKEN: 'discord-secret',
  OPENAI_API_KEY: 'openai-secret',
} as const;

describe('loadConfig', () => {
  it('loads allowlist and pinned model defaults', () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      discord: {
        applicationId: validEnvironment.DISCORD_APPLICATION_ID,
        guildId: validEnvironment.DISCORD_GUILD_ID,
        textChannelId: validEnvironment.DISCORD_MAIN_TEXT_CHANNEL_ID,
        voiceChannelId: validEnvironment.DISCORD_MAIN_VOICE_CHANNEL_ID,
      },
      models: {
        embedding: 'text-embedding-3-small',
        memory: 'gpt-5.4-nano',
        text: 'gpt-5.4-mini',
        transcription: 'gpt-4o-mini-transcribe-2025-12-15',
        voice: 'gpt-realtime-2.1-mini',
      },
      usage: { ceilingUsd: 10, warningUsd: 5 },
    });
  });

  it('fails closed when an allowlisted channel is missing', () => {
    const environment = { ...validEnvironment } as Record<string, string>;
    delete environment.DISCORD_MAIN_TEXT_CHANNEL_ID;

    expect(() => loadConfig(environment)).toThrow(
      /DISCORD_MAIN_TEXT_CHANNEL_ID/u,
    );
  });

  it('never includes secret values in a validation error', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, DISCORD_GUILD_ID: 'invalid' }),
    ).toThrow(expect.not.stringContaining('discord-secret'));
  });
});
