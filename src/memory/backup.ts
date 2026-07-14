import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { openChiefDatabase } from './database.js';
import { SqliteMemoryStore } from './memory-store.js';

export async function backupChiefDatabase(
  databasePath: string,
  destinationDirectory: string,
): Promise<string> {
  await mkdir(destinationDirectory, { recursive: true });
  const destination = join(
    destinationDirectory,
    `chief-${new Date().toISOString().replaceAll(':', '-')}.db`,
  );
  const database = openChiefDatabase(databasePath);
  try {
    await new SqliteMemoryStore(database).backup(destination);
    await chmod(destination, 0o600);
  } finally {
    database.close();
  }
  return destination;
}
