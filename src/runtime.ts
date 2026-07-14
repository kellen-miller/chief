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
import { ChannelContextService } from './context/channel-context-service.js';
import { createOpenAiContextSummarizer } from './context/openai-context.js';
import { ConversationStore } from './conversation/conversation-store.js';
import { DiscordReconciliationService } from './discord/discord-reconciliation-service.js';
import { DiscordGateway } from './discord/gateway.js';
import { HealthServer } from './health/health-server.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
  verifyContextDatabaseSchema,
} from './memory/database.js';
import { MemoryService } from './memory/memory-service.js';
import { SqliteMemoryStore } from './memory/memory-store.js';
import {
  createOpenAiEmbedder,
  createOpenAiMemoryExtractor,
} from './memory/openai-memory.js';
import { SqliteUsageLedger } from './usage/sqlite-usage-ledger.js';
import { BackgroundScheduler } from './usage/background-scheduler.js';
import { PaidWorkQueue } from './usage/paid-work-queue.js';
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
  const conversation = new ConversationStore(database);
  const queue = new PaidWorkQueue();
  const reservations = calculateConservativeReservations(config.pricing);
  const budget = new UsageBudget({
    ...config.usage,
    backgroundHeadroomUsd: Math.max(
      reservations.textUsd,
      reservations.transcriptionUsd,
      reservations.voiceUsd,
    ),
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
  const context = new ChannelContextService({
    budget,
    channelId: config.discord.textChannelId,
    conversation,
    database,
    embed,
    estimateUsd: 0.05,
    guildId: config.discord.guildId,
    memory,
    summarizer: createOpenAiContextSummarizer({
      apiKey: config.openAiApiKey,
      model: config.models.memory,
      pricing: {
        inputPerMillionUsd: config.pricing.memoryInput,
        outputPerMillionUsd: config.pricing.memoryOutput,
      },
    }),
    timeZone: 'America/New_York',
  });
  const memoryService = new MemoryService({
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
  const agent = new OpenAiChiefAgent({
    apiKey: config.openAiApiKey,
    memory: memoryService,
    model: config.models.text,
    pricing: {
      cachedInputPerMillionUsd: config.pricing.textCachedInput,
      cacheWriteInputPerMillionUsd: config.pricing.textCacheWriteInput,
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
  const orchestrator = new ConversationOrchestrator({
    agent,
    budget,
    context,
    conversation,
    memory: memoryService,
    queue,
    reservations,
    telemetry: (event) => {
      logger.info(event, 'chief_conversation');
    },
  });
  let fallbackSuffixPcm = await readOptionalFile(config.voiceSuffixPath);
  if (fallbackSuffixPcm === undefined) {
    await queue.background(async () => {
      const reservation = budget.reserve('voice-suffix-generation', 0.05, {
        priority: 'background',
        workCategory: 'interaction',
      });
      if (!reservation.allowed) return;
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
    });
  }
  if (fallbackSuffixPcm === undefined) {
    logger.warn('chief_voice_suffix_fallback_missing');
  }
  const voice = new DiscordVoiceController({
    ...(fallbackSuffixPcm === undefined ? {} : { fallbackSuffixPcm }),
    orchestrator,
    textChannelId: config.discord.textChannelId,
    voiceChannelId: config.discord.voiceChannelId,
  });
  let reconciliation: DiscordReconciliationService | undefined;
  let weeklyReconciliationRunning = false;
  const scheduleWeeklyReconciliation = (): void => {
    if (reconciliation === undefined || weeklyReconciliationRunning) return;
    weeklyReconciliationRunning = true;
    void reconciliation
      .reconcileWeeklyIdentity()
      .then((result) => {
        logger.info(
          { ...reconciliation?.diagnostics(), status: result.status },
          'discord_reconciliation_health',
        );
      })
      .catch((error: unknown) => {
        logger.warn(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'discord_reconciliation_health_failed',
        );
      })
      .finally(() => {
        weeklyReconciliationRunning = false;
      });
  };
  const gateway = new DiscordGateway({
    channelId: config.discord.textChannelId,
    guildId: config.discord.guildId,
    logger,
    orchestrator,
    reconciliation: ({ history }) => {
      reconciliation = new DiscordReconciliationService({
        channelId: config.discord.textChannelId,
        database,
        guildId: config.discord.guildId,
        history,
        lifecycle: orchestrator,
      });
      return {
        reconcileAfterGap: async () => {
          const result = await reconciliation?.reconcileAfterGap();
          if (result?.status === 'completed') {
            scheduleWeeklyReconciliation();
          }
          return result ?? { status: 'failed' };
        },
      };
    },
    token: config.discord.token,
    voice,
    voiceChannelId: config.discord.voiceChannelId,
  });
  const startupMaintenanceAt = Date.now();
  memory.maintain(startupMaintenanceAt);
  context.maintain(startupMaintenanceAt);
  let maintenanceAt = startupMaintenanceAt;
  const health = new HealthServer({
    check: async () => ({
      database: checkDatabase(database),
      discord: gateway.ready,
      disk: await checkDisk(config.dataDirectory),
      maintenance: Date.now() - maintenanceAt < 26 * 60 * 60 * 1_000,
    }),
    host: '0.0.0.0',
    port: config.healthPort,
  });
  let workerRunning = false;
  const background = new BackgroundScheduler({
    context: {
      nextDeadline: (now) => context.nextDeadline(now),
      runOne: (now) => context.runNext(now),
    },
    memory: {
      nextDeadline: (now) => memoryService.nextDeadline(now),
      runOne: (now) => memoryService.runAutomaticOne(now),
    },
    queue,
  });
  const workerTimer = setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    void background
      .runBackgroundOne(Date.now())
      .catch((error: unknown) => {
        logger.error({ err: error }, 'background_worker_failed');
      })
      .finally(() => {
        workerRunning = false;
      });
  }, 5_000);
  const maintenanceTimer = setInterval(
    () => {
      try {
        const now = Date.now();
        memory.maintain(now);
        context.maintain(now);
        maintenanceAt = now;
      } catch (error) {
        logger.error({ err: error }, 'memory_maintenance_failed');
      }
    },
    24 * 60 * 60 * 1_000,
  );
  let gapReconciliationRunning = false;
  const reconciliationTimer = setInterval(
    () => {
      if (reconciliation === undefined || gapReconciliationRunning) return;
      gapReconciliationRunning = true;
      void reconciliation
        .reconcileAfterGap()
        .then((result) => {
          logger.info(
            { ...reconciliation?.diagnostics(), status: result.status },
            'discord_reconciliation_health',
          );
          if (result.status === 'completed') scheduleWeeklyReconciliation();
        })
        .catch((error: unknown) => {
          logger.warn(
            { errorName: error instanceof Error ? error.name : 'UnknownError' },
            'discord_reconciliation_health_failed',
          );
        })
        .finally(() => {
          gapReconciliationRunning = false;
        });
    },
    60 * 60 * 1_000,
  );
  workerTimer.unref();
  maintenanceTimer.unref();
  reconciliationTimer.unref();

  await health.start();
  try {
    await gateway.start();
  } catch (error) {
    clearInterval(workerTimer);
    clearInterval(maintenanceTimer);
    clearInterval(reconciliationTimer);
    const queueDrained = queue.shutdown();
    await orchestrator.shutdown();
    await queueDrained;
    await health.stop();
    database.close();
    throw error;
  }
  logger.info('chief_process_started');

  return {
    stop: async () => {
      clearInterval(workerTimer);
      clearInterval(maintenanceTimer);
      clearInterval(reconciliationTimer);
      const queueDrained = queue.shutdown();
      await gateway.stop();
      await orchestrator.shutdown();
      await queueDrained;
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
        database.prepare('select vec_version()').pluck().get() === 'v0.1.9' &&
        verifyContextDatabaseSchema(database) &&
        database
          .prepare('select count(*) from conversation_events where 0')
          .pluck()
          .get() === 0
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
