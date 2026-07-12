import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import pino from 'pino';
import { setTracingDisabled } from '@openai/agents';

import {
  calculateConservativeReservations,
  OpenAiChiefAgent,
} from './agent/openai-chief-agent.js';
import { generateOpenAiVoiceSuffix } from './agent/openai-voice.js';
import { ConversationOrchestrator } from './app/conversation-orchestrator.js';
import type { ChiefConfig } from './config/config.js';
import { DiscordGateway } from './discord/gateway.js';
import { HealthServer } from './health/health-server.js';
import { migrateChiefDatabase, openChiefDatabase } from './memory/database.js';
import { MemoryContext } from './memory/memory-context.js';
import { SqliteMemoryStore } from './memory/memory-store.js';
import {
  createOpenAiEmbedder,
  createOpenAiMemoryExtractor,
} from './memory/openai-memory.js';
import { MemoryWorker } from './memory/memory-worker.js';
import { SqliteUsageLedger } from './usage/sqlite-usage-ledger.js';
import { UsageBudget } from './usage/usage-budget.js';
import { DiscordVoiceController } from './voice/discord-voice-controller.js';
import { realtimePcmToDiscord } from './voice/pcm.js';

export interface ChiefRuntime {
  stop(): Promise<void>;
}

export async function startChief(config: ChiefConfig): Promise<ChiefRuntime> {
  setTracingDisabled(true);
  await mkdir(config.dataDirectory, { recursive: true });
  const logger = pino({
    redact: {
      censor: '[REDACTED]',
      paths: [
        '*.apiKey',
        '*.token',
        '*.authorization',
        '*.headers.authorization',
        'err.config',
        'err.request',
        'err.response',
      ],
    },
  });
  const database = openChiefDatabase(join(config.dataDirectory, 'chief.db'));
  migrateChiefDatabase(database);
  const memory = new SqliteMemoryStore(database);
  const budget = new UsageBudget({
    ...config.usage,
    ledger: new SqliteUsageLedger(database),
    onThreshold: (event) => {
      logger.warn(
        event === 'warning' ? 'chief_budget_warning' : 'chief_budget_ceiling',
      );
    },
  });
  const embed = createOpenAiEmbedder({
    apiKey: config.openAiApiKey,
    model: config.models.embedding,
    pricing: { inputPerMillionUsd: config.pricing.embeddingInput },
  });
  const agent = new OpenAiChiefAgent({
    apiKey: config.openAiApiKey,
    model: config.models.text,
    pricing: {
      inputPerMillionUsd: config.pricing.textInput,
      outputPerMillionUsd: config.pricing.textOutput,
      searchCallUsd: config.pricing.searchCall,
    },
    transcriptionModel: config.models.transcription,
    transcriptionPricing: {
      fallbackPerMinuteUsd: config.pricing.transcriptionFallbackMinute,
      inputPerMillionUsd: config.pricing.transcriptionInput,
      outputPerMillionUsd: config.pricing.transcriptionOutput,
    },
    voiceModel: config.models.voice,
    voiceName: config.voiceName,
    voicePricing: {
      audioInputPerMillionUsd: config.pricing.voiceAudioInput,
      audioOutputPerMillionUsd: config.pricing.voiceAudioOutput,
      textInputPerMillionUsd: config.pricing.voiceTextInput,
      textOutputPerMillionUsd: config.pricing.voiceTextOutput,
    },
  });
  const orchestrator = new ConversationOrchestrator(
    agent,
    budget,
    new MemoryContext({ embed, store: memory }),
    calculateConservativeReservations(config.pricing),
  );
  let fallbackSuffixPcm = await readOptionalFile(config.voiceSuffixPath);
  if (fallbackSuffixPcm === undefined) {
    const reservation = budget.reserve('voice-suffix-generation', 0.05);
    if (reservation.allowed) {
      try {
        const generated = await generateOpenAiVoiceSuffix({
          apiKey: config.openAiApiKey,
          model: config.models.voice,
          pricing: {
            audioInputPerMillionUsd: config.pricing.voiceAudioInput,
            audioOutputPerMillionUsd: config.pricing.voiceAudioOutput,
            textInputPerMillionUsd: config.pricing.voiceTextInput,
            textOutputPerMillionUsd: config.pricing.voiceTextOutput,
          },
          voice: config.voiceName,
        });
        fallbackSuffixPcm = realtimePcmToDiscord(generated.pcm);
        await mkdir(dirname(config.voiceSuffixPath), { recursive: true });
        await writeFile(config.voiceSuffixPath, fallbackSuffixPcm, {
          mode: 0o600,
        });
        budget.reconcile(
          reservation.id,
          generated.usageUsd > 0 ? generated.usageUsd : 0.05,
        );
      } catch (error) {
        budget.reconcile(reservation.id, 0.05);
        logger.error({ err: error }, 'chief_voice_suffix_generation_failed');
      }
    }
  }
  if (fallbackSuffixPcm === undefined) {
    logger.warn('chief_voice_suffix_fallback_missing');
  }
  const voice = new DiscordVoiceController({
    ...(fallbackSuffixPcm === undefined ? {} : { fallbackSuffixPcm }),
    observe: (source) => {
      memory.observe(source);
    },
    orchestrator,
    textChannelId: config.discord.textChannelId,
    voiceChannelId: config.discord.voiceChannelId,
  });
  const gateway = new DiscordGateway({
    channelId: config.discord.textChannelId,
    guildId: config.discord.guildId,
    logger,
    memory,
    orchestrator,
    token: config.discord.token,
    voice,
    voiceChannelId: config.discord.voiceChannelId,
  });
  let maintenanceAt = Date.now();
  const health = new HealthServer({
    check: async () => ({
      database: checkDatabase(database),
      discord: gateway.ready,
      disk: await checkDisk(config.dataDirectory),
      maintenance: Date.now() - maintenanceAt < 26 * 60 * 60 * 1_000,
    }),
    port: config.healthPort,
  });
  const worker = new MemoryWorker({
    budget,
    embed,
    estimateUsd: 0.05,
    extract: createOpenAiMemoryExtractor({
      apiKey: config.openAiApiKey,
      model: config.models.memory,
      pricing: {
        inputPerMillionUsd: config.pricing.memoryInput,
        outputPerMillionUsd: config.pricing.memoryOutput,
      },
    }),
    store: memory,
  });
  let workerRunning = false;
  const workerTimer = setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    void worker
      .runOne(Date.now())
      .catch((error: unknown) => {
        logger.error({ err: error }, 'memory_worker_failed');
      })
      .finally(() => {
        workerRunning = false;
      });
  }, 5_000);
  const maintenanceTimer = setInterval(
    () => {
      try {
        memory.maintain(Date.now());
        maintenanceAt = Date.now();
      } catch (error) {
        logger.error({ err: error }, 'memory_maintenance_failed');
      }
    },
    24 * 60 * 60 * 1_000,
  );
  workerTimer.unref();
  maintenanceTimer.unref();

  await health.start();
  try {
    await gateway.start();
  } catch (error) {
    clearInterval(workerTimer);
    clearInterval(maintenanceTimer);
    await health.stop();
    database.close();
    throw error;
  }
  logger.info('chief_process_started');

  return {
    stop: async () => {
      clearInterval(workerTimer);
      clearInterval(maintenanceTimer);
      await gateway.stop();
      await health.stop();
      database.close();
    },
  };
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    const content = await readFile(path);
    return content.length === 0 ? undefined : content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function checkDatabase(
  database: ReturnType<typeof openChiefDatabase>,
): boolean {
  try {
    return database.transaction(() => {
      database
        .prepare(
          `insert into maintenance_runs (kind, started_at, completed_at, status)
           values ('health', ?, ?, 'completed')`,
        )
        .run(Date.now(), Date.now());
      database
        .prepare("delete from maintenance_runs where kind = 'health'")
        .run();
      return (
        database.prepare('select vec_version()').pluck().get() === 'v0.1.9'
      );
    })();
  } catch {
    return false;
  }
}

async function checkDisk(path: string): Promise<boolean> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize >= 100 * 1024 * 1024;
}
