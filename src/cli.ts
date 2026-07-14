import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { loadConfig } from './config/config.js';
import { executeContextBackfillCommand } from './context/context-backfill-command.js';
import { ContextBackfillService } from './context/context-backfill.js';
import { DiscordRestHistorySource } from './discord/rest-history-source.js';
import { registerGuildCommands } from './discord/register-commands.js';
import { HealthServer } from './health/health-server.js';
import { migrateChiefDatabase, openChiefDatabase } from './memory/database.js';
import { backupChiefDatabase } from './memory/backup.js';
import { SqliteMemoryStore } from './memory/memory-store.js';
import {
  readForgetJournalDirectory,
  replayForgetJournals,
  verifyRestorableDatabase,
} from './memory/recovery.js';
import { startChief } from './runtime.js';

const { OpusEncoder } = createRequire(import.meta.url)('@discordjs/opus') as {
  readonly OpusEncoder: typeof import('@discordjs/opus').OpusEncoder;
};

async function main(arguments_: readonly string[]): Promise<void> {
  const [command = 'run'] = arguments_;
  switch (command) {
    case 'run': {
      const runtime = await startChief(loadConfig(process.env));
      const stop = (): void => {
        void runtime.stop().finally(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      break;
    }
    case 'register-commands': {
      const config = loadConfig(process.env);
      await registerGuildCommands({
        applicationId: config.discord.applicationId,
        guildId: config.discord.guildId,
        token: config.discord.token,
      });
      break;
    }
    case 'migrate': {
      const database = openChiefDatabase(requireFlag(arguments_, '--database'));
      migrateChiefDatabase(database);
      database.close();
      break;
    }
    case 'backup': {
      const destination = await backupChiefDatabase(
        requireFlag(arguments_, '--database'),
        requireFlag(arguments_, '--destination'),
      );
      process.stdout.write(`${destination}\n`);
      break;
    }
    case 'verify-restore': {
      const backup = requireFlag(arguments_, '--backup');
      const database = openChiefDatabase(backup);
      const requiredMigration = optionalFlag(arguments_, '--require-migration');
      const verified = verifyRestorableDatabase(database, requiredMigration);
      database.close();
      if (!verified) {
        throw new Error(`backup verification failed for ${basename(backup)}`);
      }
      break;
    }
    case 'recover-forget-journals': {
      const database = openChiefDatabase(requireFlag(arguments_, '--database'));
      try {
        const entries = await readForgetJournalDirectory(
          requireFlag(arguments_, '--journal-directory'),
        );
        replayForgetJournals(database, entries, Date.now());
        if (!verifyRestorableDatabase(database)) {
          throw new Error('recovered database verification failed');
        }
        process.stdout.write(
          `replayed ${entries.length.toString()} journals\n`,
        );
      } finally {
        database.close();
      }
      break;
    }
    case 'context-backfill': {
      const config = loadConfig(process.env);
      const database = openChiefDatabase(
        join(config.dataDirectory, 'chief.db'),
      );
      try {
        migrateChiefDatabase(database);
        const history = new DiscordRestHistorySource({
          botUserId: config.discord.applicationId,
          channelId: config.discord.textChannelId,
          guildId: config.discord.guildId,
          token: config.discord.token,
        });
        const service = new ContextBackfillService({
          channelId: config.discord.textChannelId,
          database,
          guildId: config.discord.guildId,
          history,
          pricing: {
            embeddingInputPerMillionUsd: config.pricing.embeddingInput,
            summaryInputPerMillionUsd: config.pricing.memoryInput,
            summaryOutputPerMillionUsd: config.pricing.memoryOutput,
          },
        });
        const output = await executeContextBackfillCommand(
          arguments_.slice(1),
          service,
        );
        process.stdout.write(`${output}\n`);
      } finally {
        database.close();
      }
      break;
    }
    case 'smoke':
      await smoke();
      break;
    default:
      throw new Error(`unknown Chief command: ${command}`);
  }
}

async function smoke(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'chief-smoke-'));
  const database = openChiefDatabase(join(directory, 'chief.db'));
  migrateChiefDatabase(database);
  const codec = new OpusEncoder(48_000, 2);
  const pcm = Buffer.alloc(3_840);
  const decoded = codec.decode(codec.encode(pcm));
  if (decoded.length === 0) throw new Error('Opus smoke test failed');
  await new SqliteMemoryStore(database).backup(join(directory, 'backup.db'));
  database.close();
  const health = new HealthServer({
    check: () =>
      Promise.resolve({
        database: true,
        discord: true,
        disk: true,
        maintenance: true,
      }),
    port: 0,
  });
  await health.start();
  const response = await fetch(
    `http://127.0.0.1:${health.port.toString()}/healthz`,
  );
  await health.stop();
  if (!response.ok) throw new Error('health smoke test failed');
  process.stdout.write('READY\n');
}

function requireFlag(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = arguments_[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function optionalFlag(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const cliArguments = process.argv.slice(2);
void main(
  cliArguments[0] === '--' ? cliArguments.slice(1) : cliArguments,
).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Chief failed'}\n`,
  );
  process.exitCode = 1;
});
