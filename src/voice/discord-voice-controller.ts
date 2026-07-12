import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType, type Guild } from 'discord.js';

import type { ConversationOrchestrator } from '../app/conversation-orchestrator.js';
import type { GatewayVoiceController } from '../discord/gateway.js';
import type { SourceObservation } from '../memory/memory-store.js';
import { discordPcmToRealtime, realtimePcmToDiscord } from './pcm.js';
import {
  VoiceSessionManager,
  type VoiceUtterance,
} from './voice-session-manager.js';
import { VoiceSuffixEnforcer } from './voice-suffix.js';

const { OpusEncoder } = createRequire(import.meta.url)('@discordjs/opus') as {
  readonly OpusEncoder: typeof import('@discordjs/opus').OpusEncoder;
};
const MAX_UTTERANCE_BYTES = 48_000 * 2 * 2 * 90;

export interface DiscordVoiceControllerOptions {
  readonly fallbackSuffixPcm?: Buffer;
  readonly observe?: (source: SourceObservation) => void;
  readonly orchestrator: ConversationOrchestrator;
  readonly textChannelId: string;
  readonly voiceChannelId: string;
}

export class DiscordVoiceController implements GatewayVoiceController {
  readonly #activeSpeakers = new Set<string>();
  readonly #decoder = new OpusEncoder(48_000, 2);
  readonly #manager: VoiceSessionManager;
  readonly #options: DiscordVoiceControllerOptions;
  readonly #player: AudioPlayer;
  #connection: VoiceConnection | undefined;
  #guild: Guild | undefined;
  #inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  #playback: PassThrough | undefined;

  public constructor(options: DiscordVoiceControllerOptions) {
    this.#options = options;
    this.#player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.#manager = new VoiceSessionManager({
      disconnect: () => {
        void this.leave();
      },
      interrupt: () => {
        this.#interruptPlayback();
      },
      observe: (turn) => {
        this.#observeTranscript(turn.speakerId, turn.transcript);
      },
      submit: async (turn) => {
        this.#resetInactivityTimer();
        await this.#submitTurn(turn.pcm, turn.speakerId, turn.transcript);
        this.#resetInactivityTimer();
      },
      transcribe: async (pcm) =>
        (await this.#options.orchestrator.transcribeVoice(pcm)) ?? '',
    });
  }

  public async join(guild: Guild): Promise<{ readonly aiPaused: boolean }> {
    if (this.#connection !== undefined) {
      return { aiPaused: this.#options.orchestrator.aiPaused };
    }
    const connection = joinVoiceChannel({
      adapterCreator: guild.voiceAdapterCreator,
      channelId: this.#options.voiceChannelId,
      guildId: guild.id,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connection.subscribe(this.#player);
    connection.receiver.speaking.on('start', (speakerId) => {
      void this.#receiveSpeaker(speakerId).catch(() => {
        void this.#postStatus('Voice receive failed, Mr. President');
      });
    });
    this.#connection = connection;
    this.#guild = guild;
    this.#resetInactivityTimer();
    return { aiPaused: this.#options.orchestrator.aiPaused };
  }

  public async leave(): Promise<void> {
    if (this.#inactivityTimer !== undefined)
      clearTimeout(this.#inactivityTimer);
    this.#inactivityTimer = undefined;
    this.#interruptPlayback();
    this.#connection?.destroy();
    this.#connection = undefined;
    this.#guild = undefined;
    this.#activeSpeakers.clear();
    await this.#options.orchestrator.shutdown();
  }

  async #receiveSpeaker(speakerId: string): Promise<void> {
    const connection = this.#connection;
    const guild = this.#guild;
    if (
      connection === undefined ||
      guild === undefined ||
      this.#activeSpeakers.has(speakerId) ||
      guild.members.cache.get(speakerId)?.user.bot === true
    ) {
      return;
    }
    this.#activeSpeakers.add(speakerId);
    this.#manager.setHumanCount(this.#humanCount(guild));
    const utterance = this.#manager.beginUtterance(speakerId);
    const stream = connection.receiver.subscribe(speakerId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
    });
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    stream.on('data', (packet: Buffer) => {
      try {
        const decoded = this.#decoder.decode(packet);
        receivedBytes += decoded.length;
        if (receivedBytes > MAX_UTTERANCE_BYTES) {
          stream.destroy(new Error('voice utterance exceeded 90 seconds'));
          return;
        }
        chunks.push(decoded);
      } catch {
        stream.destroy(new Error('invalid Discord Opus packet'));
      }
    });
    await new Promise<void>((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    }).finally(() => this.#activeSpeakers.delete(speakerId));
    const pcm = Buffer.concat(chunks);
    if (pcm.length === 0) return;
    await this.#completeUtterance(utterance, pcm);
  }

  async #completeUtterance(
    utterance: VoiceUtterance,
    pcm: Buffer,
  ): Promise<void> {
    await this.#manager.completeUtterance(
      utterance,
      Uint8Array.from(discordPcmToRealtime(pcm)).buffer,
    );
  }

  async #submitTurn(
    pcm: ArrayBuffer,
    speakerId: string,
    groupTranscript?: string,
  ): Promise<void> {
    const playback = new PassThrough();
    this.#playback = playback;
    this.#player.play(
      createAudioResource(playback, { inputType: StreamType.Raw }),
    );
    const suffix =
      this.#options.fallbackSuffixPcm === undefined
        ? undefined
        : new VoiceSuffixEnforcer(this.#options.fallbackSuffixPcm);
    const result = await this.#options.orchestrator.handleVoice(
      { pcm, requestId: `voice-${speakerId}-${Date.now().toString()}` },
      {
        audio: (audio) => {
          const discordPcm = realtimePcmToDiscord(Buffer.from(audio));
          for (const chunk of suffix?.push(discordPcm) ?? [discordPcm]) {
            playback.write(chunk);
          }
        },
        transcript: (delta) => suffix?.addTranscript(delta),
      },
    );
    if (result.status === 'completed') {
      for (const chunk of suffix?.complete() ?? []) playback.write(chunk);
      playback.end();
      if (result.citations.length > 0) {
        await this.#postStatus(
          `Sources: ${result.citations.slice(0, 5).join(' ')}`,
        );
      }
      if (groupTranscript === undefined && result.inputTranscript.length > 0) {
        this.#observeTranscript(speakerId, result.inputTranscript);
      }
    } else {
      suffix?.interrupt();
      playback.destroy();
      if (result.status === 'budget-paused') {
        await this.#postStatus(
          'AI usage is paused until the next UTC month, Mr. President',
        );
      } else if (result.status === 'failed') {
        await this.#postStatus(
          'I could not complete that reply, Mr. President',
        );
      }
    }
  }

  #observeTranscript(speakerId: string, transcript: string): void {
    if (transcript.trim().length === 0) return;
    const now = Date.now();
    this.#options.observe?.({
      content: transcript,
      medium: 'voice',
      occurredAt: now,
      platformSourceId: `voice-${speakerId}-${randomUUID()}`,
      retentionDeadline: now + 7 * 24 * 60 * 60 * 1_000,
      speakerId,
    });
  }

  #humanCount(guild: Guild): number {
    return guild.members.cache.filter(
      (member) =>
        !member.user.bot &&
        member.voice.channelId === this.#options.voiceChannelId,
    ).size;
  }

  #interruptPlayback(): void {
    this.#options.orchestrator.interruptActiveVoice();
    this.#playback?.destroy();
    this.#playback = undefined;
    if (this.#player.state.status !== AudioPlayerStatus.Idle)
      this.#player.stop(true);
  }

  async #postStatus(content: string): Promise<void> {
    const channel = this.#guild?.channels.cache.get(
      this.#options.textChannelId,
    );
    if (channel?.type === ChannelType.GuildText) await channel.send(content);
  }

  #resetInactivityTimer(): void {
    if (this.#inactivityTimer !== undefined)
      clearTimeout(this.#inactivityTimer);
    this.#inactivityTimer = setTimeout(() => {
      if (this.#activeSpeakers.size === 0) void this.leave();
      else this.#resetInactivityTimer();
    }, 15 * 60_000);
    this.#inactivityTimer.unref();
  }
}
