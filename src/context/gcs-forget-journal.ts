import { Storage } from '@google-cloud/storage';

import type { ContextForgetJournalEntry } from './context-deletion-store.js';

interface GcsFile {
  download(): Promise<[Buffer]>;
  save(
    content: Buffer,
    options: {
      readonly contentType: string;
      readonly preconditionOpts: { readonly ifGenerationMatch: number };
      readonly resumable: boolean;
    },
  ): Promise<unknown>;
}

interface GcsStorage {
  bucket(name: string): { file(name: string): GcsFile };
}

interface GcsForgetJournalUploaderOptions {
  readonly bucketName: string;
  readonly storage?: GcsStorage;
}

export function createGcsForgetJournalUploader(
  options: GcsForgetJournalUploaderOptions,
): (entry: ContextForgetJournalEntry) => Promise<void> {
  const storage: GcsStorage = options.storage ?? new Storage();
  const bucket = storage.bucket(options.bucketName);
  return async (entry) => {
    if (!/^[0-9a-f]{64}$/u.test(entry.checksum)) {
      throw new Error('forget journal checksum must be SHA-256');
    }
    const content = Buffer.from(JSON.stringify(entry));
    const object = bucket.file(
      `context-forget-journal/${String(entry.occurredAt)}-${entry.checksum}.json`,
    );
    try {
      await object.save(content, {
        contentType: 'application/json',
        preconditionOpts: { ifGenerationMatch: 0 },
        resumable: false,
      });
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const [existing] = await object.download();
      if (!existing.equals(content)) {
        throw new Error('immutable forget journal object conflicts', {
          cause: error,
        });
      }
    }
  };
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 412
  );
}
