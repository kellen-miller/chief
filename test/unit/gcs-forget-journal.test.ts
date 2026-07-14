import { describe, expect, it } from 'vitest';

import type { ContextForgetJournalEntry } from '../../src/context/context-deletion-store.js';
import { createGcsForgetJournalUploader } from '../../src/context/gcs-forget-journal.js';

const entry: ContextForgetJournalEntry = {
  checksum: 'a'.repeat(64),
  journalKey: 'forget:journal-1',
  occurredAt: 1_720_000_000_000,
  payload: {
    documentIds: [],
    documentKeys: [],
    memoryIds: [],
    sourceScopeIds: ['guild/channel/message'],
    tombstoneKeys: ['source:guild/channel/message'],
  },
};

describe('GCS forget journal uploader', () => {
  it('survives a persisted upload with a lost acknowledgement', async () => {
    const storage = new FakeStorage();
    storage.failNextAcknowledgement = true;
    const firstProcess = createGcsForgetJournalUploader({
      bucketName: 'chief-backups',
      storage,
    });

    await expect(firstProcess(entry)).rejects.toThrow('lost acknowledgement');
    const restartedProcess = createGcsForgetJournalUploader({
      bucketName: 'chief-backups',
      storage,
    });
    await expect(restartedProcess(entry)).resolves.toBeUndefined();
    expect(storage.objects.size).toBe(1);
    const [objectName, content] = [...storage.objects.entries()][0] ?? [];
    expect(objectName).toMatch(
      /^chief-backups\/forget-journal\/\d+-[0-9a-f]{64}\.json$/u,
    );
    expect(JSON.parse(content?.toString('utf8') ?? '')).toEqual({
      ...entry,
      schemaVersion: 1,
    });
  });

  it('refuses an immutable object with conflicting content', async () => {
    const storage = new FakeStorage();
    const upload = createGcsForgetJournalUploader({
      bucketName: 'chief-backups',
      storage,
    });
    await upload(entry);

    await expect(
      upload({
        ...entry,
        payload: { ...entry.payload, sourceScopeIds: ['different'] },
      }),
    ).rejects.toThrow('immutable forget journal object conflicts');
  });
});

class FakeStorage {
  public failNextAcknowledgement = false;
  public readonly objects = new Map<string, Buffer>();

  public bucket(name: string) {
    return {
      file: (objectName: string) => ({
        download: (): Promise<[Buffer]> => {
          const content = this.objects.get(`${name}/${objectName}`);
          if (content === undefined) throw new Error('object not found');
          return Promise.resolve([content]);
        },
        save: (content: Buffer): Promise<void> => {
          const key = `${name}/${objectName}`;
          if (this.objects.has(key)) {
            return Promise.reject(
              Object.assign(new Error('exists'), { code: 412 }),
            );
          }
          this.objects.set(key, content);
          if (this.failNextAcknowledgement) {
            this.failNextAcknowledgement = false;
            return Promise.reject(new Error('lost acknowledgement'));
          }
          return Promise.resolve();
        },
      }),
    };
  }
}
