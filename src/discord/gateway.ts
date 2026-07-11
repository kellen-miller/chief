import { once } from 'node:events';

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from 'discord.js';
import type { Logger } from 'pino';

import type { ConversationOrchestrator } from '../app/conversation-orchestrator.js';
import { roll } from '../commands/roll.js';
import type { SqliteMemoryStore } from '../memory/memory-store.js';
import { DiscordTextController } from './text-controller.js';

export interface GatewayVoiceController {
  join(guild: Guild): Promise<{ readonly aiPaused: boolean }>;
  leave(): Promise<void>;
}

export interface DiscordGatewayOptions {
  readonly channelId: string;
  readonly client?: Client;
  readonly guildId: string;
  readonly logger: Logger;
  readonly memory: SqliteMemoryStore;
  readonly orchestrator: ConversationOrchestrator;
  readonly token: string;
  readonly voice: GatewayVoiceController;
  readonly voiceChannelId: string;
}

export class DiscordGateway {
  readonly #client: Client;
  readonly #options: DiscordGatewayOptions;
  #ready = false;
  #text: DiscordTextController | undefined;

  public constructor(options: DiscordGatewayOptions) {
    this.#options = options;
    this.#client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.MessageContent,
        ],
      });
  }

  public get ready(): boolean {
    return this.#ready;
  }

  public async start(): Promise<void> {
    this.#client.on(Events.MessageCreate, (message) => {
      void this.#handleMessage(message).catch((error: unknown) => {
        this.#options.logger.error({ err: error }, 'discord_message_failed');
      });
    });
    this.#client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void this.#handleCommand(interaction).catch((error: unknown) => {
        this.#options.logger.error({ err: error }, 'discord_command_failed');
      });
    });
    const ready = once(this.#client, Events.ClientReady);
    await this.#client.login(this.#options.token);
    await ready;
    this.#validateAllowlist();
    const botUserId = this.#client.user?.id;
    if (botUserId === undefined)
      throw new Error('Discord client has no bot user');
    this.#text = new DiscordTextController(
      {
        botUserId,
        channelId: this.#options.channelId,
        guildId: this.#options.guildId,
      },
      {
        handleText: (turn) => this.#options.orchestrator.handleText(turn),
        observe: (source) => {
          this.#options.memory.observe(source);
        },
      },
    );
    this.#ready = true;
  }

  public async stop(): Promise<void> {
    this.#ready = false;
    await this.#options.voice.leave();
    await this.#client.destroy();
  }

  async #handleMessage(message: Message): Promise<void> {
    const text = this.#text;
    if (text === undefined) return;
    let replied = false;
    await text.handle(
      {
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        channelId: message.channelId,
        content: message.content,
        guildId: message.guildId,
        id: message.id,
        isThread: message.channel.isThread(),
        webhookId: message.webhookId,
      },
      {
        reply: async (content) => {
          if (!replied) {
            await message.reply({
              allowedMentions: { repliedUser: false },
              content,
            });
            replied = true;
          } else if (message.channel.isSendable()) {
            await message.channel.send(content);
          }
        },
        typing: async () => {
          if (message.channel.isSendable()) await message.channel.sendTyping();
        },
      },
    );
  }

  async #handleCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      interaction.guildId !== this.#options.guildId ||
      interaction.channelId !== this.#options.channelId ||
      interaction.guild === null
    ) {
      await interaction.reply({
        content: 'Chief is unavailable here, Mr. President',
        ephemeral: true,
      });
      return;
    }
    switch (interaction.commandName) {
      case 'roll': {
        const maximum = interaction.options.getInteger('max', true);
        await interaction.reply(`${roll(maximum).toString()}, Mr. President`);
        break;
      }
      case 'help': {
        await interaction.reply(
          'Mention @Chief with a request, or use /roll, /join, and /leave. In group voice, address Chief by name. Mr. President',
        );
        break;
      }
      case 'join': {
        const member = await interaction.guild.members.fetch(
          interaction.user.id,
        );
        if (member.voice.channelId !== this.#options.voiceChannelId) {
          await interaction.reply({
            content:
              'Join the configured main voice channel first, Mr. President',
            ephemeral: true,
          });
          break;
        }
        await interaction.deferReply();
        const joined = await this.#options.voice.join(interaction.guild);
        await interaction.editReply(
          joined.aiPaused
            ? 'I am in the room, but AI usage is paused until the next UTC month, so I cannot listen or answer, Mr. President'
            : 'I am in the room, Mr. President',
        );
        break;
      }
      case 'leave': {
        await this.#options.voice.leave();
        await interaction.reply('I have left the room, Mr. President');
        break;
      }
      default:
        await interaction.reply({
          content: 'Unknown command, Mr. President',
          ephemeral: true,
        });
    }
  }

  #validateAllowlist(): void {
    const guild = this.#client.guilds.cache.get(this.#options.guildId);
    if (guild === undefined)
      throw new Error('configured Discord guild is unavailable');
    const text = guild.channels.cache.get(this.#options.channelId);
    if (text?.type !== ChannelType.GuildText) {
      throw new Error('configured Discord text channel is unavailable');
    }
    const voice = guild.channels.cache.get(this.#options.voiceChannelId);
    if (voice?.type !== ChannelType.GuildVoice) {
      throw new Error('configured Discord voice channel is unavailable');
    }
  }
}
