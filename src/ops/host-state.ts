import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Host commands use argv, never a shell. Captured output may contain credentials;
// failures deliberately omit stdout/stderr and command arguments.
export function execCommand(
  command: string,
  args: readonly string[],
  options: {
    input?: string;
    inherit?: boolean;
    allowFailure?: boolean;
    timeout?: number;
  } = {},
): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    input: options.input,
    stdio: options.inherit ? 'inherit' : 'pipe',
    timeout: options.timeout ?? 25_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if ((result.error || result.status !== 0) && !options.allowFailure) {
    throw new Error(`${command} failed`);
  }

  return result.status === 0 && !options.inherit ? result.stdout : '';
}

export function readEnvironment(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error('invalid environment file');
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined)
      throw new Error('invalid environment entry');
    values[key] = value;
  }

  return values;
}

export function atomicWrite(path: string, content: string, mode = 0o600): void {
  writeFileSync(`${path}.tmp`, content, { mode });
  chmodSync(`${path}.tmp`, mode);
  renameSync(`${path}.tmp`, path);
}

export function requireImage(image: string | undefined): string {
  if (!image || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(image))
    throw new Error('immutable image digest required');
  return image;
}

export function hostPaths(): {
  data: string;
  runtime: string;
  config: string;
  uid: number;
  gid: number;
} {
  const uid = Number(process.env.CHIEF_DATA_UID ?? 1000);
  const gid = Number(process.env.CHIEF_DATA_GID ?? 1000);
  if (![uid, gid].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('invalid data ownership');
  return {
    data: process.env.CHIEF_DATA_DIR ?? '/var/lib/chief',
    runtime: process.env.CHIEF_RUNTIME_DIR ?? '/run/chief',
    config: process.env.CHIEF_CONFIG_FILE ?? '/etc/chief/chief.env',
    uid,
    gid,
  };
}

export function installDatabase(
  source: string,
  database: string,
  uid: number,
  gid: number,
): void {
  copyFileSync(source, `${database}.restore`);
  chmodSync(`${database}.restore`, 0o600);
  chownSync(`${database}.restore`, uid, gid);
  renameSync(`${database}.restore`, database);
}

export function pruneRecoveryArtifacts(
  data: string,
  includeBackups = false,
): void {
  for (const [directory, match] of [
    [data, /^chief\.db\.failed\./u],
    [join(data, 'pre-deploy'), /\.db$/u],
    ...(includeBackups ? [[join(data, 'backups'), /\.db$/u] as const] : []),
  ] as const) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (
        match.test(name) &&
        stat.isFile() &&
        Date.now() - stat.mtimeMs > 30 * 24 * 3600_000
      )
        rmSync(path);
    }
  }
}

export function verifyImageCapability(database: string, image: string): void {
  const target =
    execCommand('docker', [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "io.chief.database-capability" }}',
      image,
    ]).trim() || '0002_conversation_events';
  if (
    !['0002_conversation_events', '0003_channel_context'].includes(database) ||
    (database === '0003_channel_context' && target !== '0003_channel_context')
  )
    throw new Error('target image cannot run database schema');
}

export function databaseChecksum(database: string): string {
  const hash = createHash('sha256');
  for (const suffix of ['', '-wal', '-shm']) {
    const path = database + suffix;
    if (existsSync(path))
      hash.update(
        `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${path}\n`,
      );
  }

  return hash.digest('hex');
}

export function privateDirectory(
  path: string,
  uid?: number,
  gid?: number,
): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  if (uid !== undefined && gid !== undefined) chownSync(path, uid, gid);
}
