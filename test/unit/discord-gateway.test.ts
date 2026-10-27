import {
  ChannelType,
  Client,
  Collection,
  Events,
  type Guild,
} from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationOrchestrator } from '../../src/app/conversation-orchestrator.js';
import { DiscordGateway } from '../../src/discord/gateway.js';

function createGateway() {
  const client = new Client({ intents: [] });
  Object.defineProperty(client, 'user', { value: { id: 'chief' } });
  client.guilds.cache.set('guild', {
    channels: {
      cache: new Collection([
        ['text', { type: ChannelType.GuildText }],
        ['voice', { type: ChannelType.GuildVoice }],
      ]),
    },
  } as unknown as Guild);
  vi.spyOn(client, 'login').mockImplementation(() => {
    client.emit(Events.ShardReady, 0, undefined);
    client.emit(Events.ClientReady, client as Client<true>);
    return Promise.resolve('unused');
  });
  const logger = pino({ enabled: false });
  const info = vi.spyOn(logger, 'info');
  const warn = vi.spyOn(logger, 'warn');
  const reconcileAfterGap = vi.fn(() =>
    Promise.resolve({ status: 'completed' as const }),
  );
  const gateway = new DiscordGateway({
    channelId: 'text',
    client,
    guildId: 'guild',
    logger,
    orchestrator: {} as ConversationOrchestrator,
    reconciliation: () => ({ reconcileAfterGap }),
    token: 'unused',
    voice: { join: vi.fn(), leave: vi.fn() },
    voiceChannelId: 'voice',
  });
  return { client, gateway, info, reconcileAfterGap, warn };
}

describe('Discord gateway readiness', () => {
  it.each([Events.ShardReady, Events.ShardResume])(
    'keeps startup reconciliation gated during %s',
    async (event) => {
      const { client, gateway, reconcileAfterGap } = createGateway();
      let finish: (() => void) | undefined;
      reconcileAfterGap.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => {
              resolve({ status: 'completed' });
            };
          }),
      );
      const starting = gateway.start();
      await vi.waitFor(() => {
        expect(reconcileAfterGap).toHaveBeenCalledOnce();
      });
      if (event === Events.ShardResume) {
        client.emit(Events.ShardResume, 0, 3);
      } else {
        client.emit(Events.ShardReady, 0, undefined);
      }

      expect(gateway.ready).toBe(false);
      finish?.();
      await starting;
      expect(gateway.ready).toBe(true);
      expect(reconcileAfterGap).toHaveBeenCalledOnce();
    },
  );

  it.each([Events.ShardReady, Events.ShardResume])(
    'restores readiness and reconciles after %s',
    async (event) => {
      const { client, gateway, reconcileAfterGap } = createGateway();
      await gateway.start();
      client.emit(Events.ShardReconnecting, 0);
      expect(gateway.ready).toBe(false);

      if (event === Events.ShardResume) {
        client.emit(Events.ShardResume, 0, 3);
      } else {
        client.emit(Events.ShardReady, 0, undefined);
      }

      expect(gateway.ready).toBe(true);
      expect(reconcileAfterGap).toHaveBeenCalledTimes(2);
    },
  );

  it('logs fresh sessions and only the code of a terminal disconnect', async () => {
    const { client, gateway, info, warn } = createGateway();
    await gateway.start();
    client.emit(Events.ShardReady, 0, undefined);
    expect(info).toHaveBeenCalledWith({ shardId: 0 }, 'discord_shard_ready');

    const disconnect = {
      code: 4014,
      reason: 'private provider detail',
      wasClean: true,
    };
    client.emit(Events.ShardDisconnect, disconnect, 0);
    expect(gateway.ready).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { closeCode: 4014, shardId: 0 },
      'discord_shard_disconnected',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'private provider detail',
    );
  });
});
