import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

export const DEFAULT_TEXT_MODEL = 'gpt-5.6-luna';

const snowflake = z
  .string()
  .regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

const timeZone = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be an IANA timezone' });
    }
  });

const environmentSchema = z.object({
  CHIEF_BACKUP_BUCKET: z.string().min(1),
  CHIEF_CONTEXT_TIME_ZONE: timeZone.default('America/New_York'),
  CHIEF_DATA_DIR: z.string().min(1).default('/var/lib/chief'),
  CHIEF_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  CHIEF_MODEL_EMBEDDING: z.string().min(1).default('text-embedding-3-small'),
  CHIEF_MODEL_MEMORY: z.string().min(1).default('gpt-5.4-nano'),
  CHIEF_MODEL_TEXT: z.string().min(1).default(DEFAULT_TEXT_MODEL),
  CHIEF_MODEL_TRANSCRIPTION: z
    .string()
    .min(1)
    .default('gpt-4o-mini-transcribe-2025-12-15'),
  CHIEF_MODEL_VOICE: z.string().min(1).default('gpt-realtime-2.1-mini'),
  CHIEF_PRICE_EMBEDDING_INPUT: z.coerce.number().nonnegative().default(0.02),
  CHIEF_PRICE_MEMORY_INPUT: z.coerce.number().nonnegative().default(0.2),
  CHIEF_PRICE_MEMORY_OUTPUT: z.coerce.number().nonnegative().default(1.25),
  CHIEF_PRICE_SEARCH_CALL: z.coerce.number().nonnegative().default(0.01),
  CHIEF_PRICE_TEXT_CACHED_INPUT: z.coerce.number().nonnegative().default(0.1),
  CHIEF_PRICE_TEXT_CACHE_WRITE_INPUT: z.coerce
    .number()
    .nonnegative()
    .default(1.25),
  CHIEF_PRICE_TEXT_INPUT: z.coerce.number().nonnegative().default(1),
  CHIEF_PRICE_TEXT_OUTPUT: z.coerce.number().nonnegative().default(6),
  CHIEF_PRICE_TRANSCRIPTION_FALLBACK_MINUTE: z.coerce
    .number()
    .nonnegative()
    .default(0.003),
  CHIEF_PRICE_TRANSCRIPTION_INPUT: z.coerce
    .number()
    .nonnegative()
    .default(1.25),
  CHIEF_PRICE_TRANSCRIPTION_OUTPUT: z.coerce.number().nonnegative().default(5),
  CHIEF_PRICE_VOICE_AUDIO_INPUT: z.coerce.number().nonnegative().default(10),
  CHIEF_PRICE_VOICE_AUDIO_OUTPUT: z.coerce.number().nonnegative().default(20),
  CHIEF_PRICE_VOICE_TEXT_INPUT: z.coerce.number().nonnegative().default(0.6),
  CHIEF_PRICE_VOICE_TEXT_OUTPUT: z.coerce.number().nonnegative().default(2.4),
  CHIEF_USAGE_CEILING_USD: z.coerce.number().positive().default(10),
  CHIEF_USAGE_INDEXING_CEILING_USD: z.coerce.number().positive().default(3),
  CHIEF_USAGE_WARNING_USD: z.coerce.number().nonnegative().default(5),
  CHIEF_VOICE_NAME: z.string().min(1).default('cedar'),
  CHIEF_VOICE_SUFFIX_PATH: z
    .string()
    .min(1)
    .default('/var/lib/chief/voice-suffix.pcm'),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  DISCORD_MAIN_TEXT_CHANNEL_ID: snowflake,
  DISCORD_MAIN_VOICE_CHANNEL_ID: snowflake,
  DISCORD_TOKEN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

export interface ChiefConfig {
  readonly backupBucket: string;
  readonly contextTimeZone: string;
  readonly dataDirectory: string;
  readonly discord: {
    readonly applicationId: string;
    readonly guildId: string;
    readonly textChannelId: string;
    readonly token: string;
    readonly voiceChannelId: string;
  };
  readonly healthPort: number;
  readonly models: {
    readonly embedding: string;
    readonly memory: string;
    readonly text: string;
    readonly transcription: string;
    readonly voice: string;
  };
  readonly openAiApiKey: string;
  readonly pricing: {
    readonly embeddingInput: number;
    readonly memoryInput: number;
    readonly memoryOutput: number;
    readonly searchCall: number;
    readonly textCachedInput: number;
    readonly textCacheWriteInput: number;
    readonly textInput: number;
    readonly textOutput: number;
    readonly transcriptionFallbackMinute: number;
    readonly transcriptionInput: number;
    readonly transcriptionOutput: number;
    readonly voiceAudioInput: number;
    readonly voiceAudioOutput: number;
    readonly voiceTextInput: number;
    readonly voiceTextOutput: number;
  };
  readonly usage: {
    readonly ceilingUsd: number;
    readonly indexingCeilingUsd: number;
    readonly warningUsd: number;
  };
  readonly voiceName: string;
  readonly voiceSuffixPath: string;
}

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ChiefConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid Chief configuration: ${problems}`);
  }
  const value = parsed.data;
  if (value.CHIEF_USAGE_WARNING_USD >= value.CHIEF_USAGE_CEILING_USD) {
    throw new Error(
      'invalid Chief configuration: CHIEF_USAGE_WARNING_USD must be below CHIEF_USAGE_CEILING_USD',
    );
  }
  if (value.CHIEF_USAGE_INDEXING_CEILING_USD > value.CHIEF_USAGE_CEILING_USD) {
    throw new Error(
      'invalid Chief configuration: CHIEF_USAGE_INDEXING_CEILING_USD must not exceed CHIEF_USAGE_CEILING_USD',
    );
  }
  return {
    backupBucket: value.CHIEF_BACKUP_BUCKET,
    contextTimeZone: value.CHIEF_CONTEXT_TIME_ZONE,
    dataDirectory: value.CHIEF_DATA_DIR,
    discord: {
      applicationId: value.DISCORD_APPLICATION_ID,
      guildId: value.DISCORD_GUILD_ID,
      textChannelId: value.DISCORD_MAIN_TEXT_CHANNEL_ID,
      token: value.DISCORD_TOKEN,
      voiceChannelId: value.DISCORD_MAIN_VOICE_CHANNEL_ID,
    },
    healthPort: value.CHIEF_HEALTH_PORT,
    models: {
      embedding: value.CHIEF_MODEL_EMBEDDING,
      memory: value.CHIEF_MODEL_MEMORY,
      text: value.CHIEF_MODEL_TEXT,
      transcription: value.CHIEF_MODEL_TRANSCRIPTION,
      voice: value.CHIEF_MODEL_VOICE,
    },
    openAiApiKey: value.OPENAI_API_KEY,
    pricing: {
      embeddingInput: value.CHIEF_PRICE_EMBEDDING_INPUT,
      memoryInput: value.CHIEF_PRICE_MEMORY_INPUT,
      memoryOutput: value.CHIEF_PRICE_MEMORY_OUTPUT,
      searchCall: value.CHIEF_PRICE_SEARCH_CALL,
      textCachedInput: value.CHIEF_PRICE_TEXT_CACHED_INPUT,
      textCacheWriteInput: value.CHIEF_PRICE_TEXT_CACHE_WRITE_INPUT,
      textInput: value.CHIEF_PRICE_TEXT_INPUT,
      textOutput: value.CHIEF_PRICE_TEXT_OUTPUT,
      transcriptionFallbackMinute:
        value.CHIEF_PRICE_TRANSCRIPTION_FALLBACK_MINUTE,
      transcriptionInput: value.CHIEF_PRICE_TRANSCRIPTION_INPUT,
      transcriptionOutput: value.CHIEF_PRICE_TRANSCRIPTION_OUTPUT,
      voiceAudioInput: value.CHIEF_PRICE_VOICE_AUDIO_INPUT,
      voiceAudioOutput: value.CHIEF_PRICE_VOICE_AUDIO_OUTPUT,
      voiceTextInput: value.CHIEF_PRICE_VOICE_TEXT_INPUT,
      voiceTextOutput: value.CHIEF_PRICE_VOICE_TEXT_OUTPUT,
    },
    usage: {
      ceilingUsd: value.CHIEF_USAGE_CEILING_USD,
      indexingCeilingUsd: value.CHIEF_USAGE_INDEXING_CEILING_USD,
      warningUsd: value.CHIEF_USAGE_WARNING_USD,
    },
    voiceName: value.CHIEF_VOICE_NAME,
    voiceSuffixPath: value.CHIEF_VOICE_SUFFIX_PATH,
  };
}
