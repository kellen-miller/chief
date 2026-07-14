import { describe, expect, it } from 'vitest';

import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const messageId = '52345678901234567';

function createHarness() {
  const database = openChiefDatabase(':memory:');
  migrateChiefDatabase(database);
  const memory = new SqliteMemoryStore(database);
  const context = new ChannelContextService({
    channelId,
    conversation: new ConversationStore(database),
    database,
    guildId,
    memory,
    now: () => 1_999,
    timeZone: 'America/New_York',
  });
  return { context, database, memory };
}

function source(
  overrides: Partial<{
    content: string;
    editedAt: number | null;
    revisionChecksum: string;
  }> = {},
) {
  return {
    attachmentMetadataJson: '[]',
    content: overrides.content ?? 'Project Marigold launches Friday.',
    editedAt: overrides.editedAt ?? null,
    memoryExtraction: 'automatic' as const,
    messageId,
    occurredAt: 1_000,
    platformEventId: messageId,
    replyToMessageId: null,
    requestId: messageId,
    revisionChecksum: overrides.revisionChecksum ?? 'revision-one',
    role: 'human' as const,
    speakerId: '42345678901234567',
    speakerName: 'President Test',
    type: 'upsert' as const,
  };
}

describe('Discord source lifecycle', () => {
  it('makes the canonical source and extraction snapshot available together', () => {
    const { context, database } = createHarness();

    expect(context.apply(source())).toMatchObject({
      status: 'applied',
    });

    expect(
      database
        .prepare(
          `select c.content as canonical, s.content as extraction,
                  s.revision_checksum as revisionChecksum,
                  j.status as jobStatus
           from conversation_events c
           join source_events s on s.platform_source_id = c.discord_message_id
           join memory_jobs j on j.source_event_id = s.id`,
        )
        .get(),
    ).toEqual({
      canonical: 'Project Marigold launches Friday.',
      extraction: 'Project Marigold launches Friday.',
      jobStatus: 'pending',
      revisionChecksum: 'revision-one',
    });
    database.close();
  });

  it('atomically replaces an edited snapshot and its derived memory', () => {
    const { context, database, memory } = createHarness();
    context.apply(source());
    const sourceEventId = database
      .prepare('select id from source_events where platform_source_id = ?')
      .pluck()
      .get(messageId) as number;
    memory.applyMemory({
      canonicalText: 'Project Marigold launches Friday.',
      confidence: 0.9,
      embedding: new Float32Array(1_536),
      kind: 'fact',
      provenance: { platformSourceId: messageId },
      sourceEventId,
      timestamp: 1_500,
    });

    expect(
      context.apply(
        source({
          content: 'Project Juniper launches Monday.',
          editedAt: 1_800,
          revisionChecksum: 'revision-two',
        }),
      ),
    ).toMatchObject({ status: 'applied' });

    expect(
      database
        .prepare(
          `select c.content as canonical, s.content as extraction,
                  s.revision_checksum as revisionChecksum
           from conversation_events c join source_events s
             on s.platform_source_id = c.discord_message_id`,
        )
        .get(),
    ).toEqual({
      canonical: 'Project Juniper launches Monday.',
      extraction: 'Project Juniper launches Monday.',
      revisionChecksum: 'revision-two',
    });
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          `select revision_checksum from memory_jobs where status = 'pending'`,
        )
        .pluck()
        .all(),
    ).toEqual(['revision-two']);
    database.close();
  });

  it('rejects stale extraction after the source revision changes', () => {
    const { context, database, memory } = createHarness();
    context.apply(source());
    const job = memory.leaseNextJob(1_000, 60_000);
    if (job === null) throw new Error('expected an extraction job');
    const staleSource = memory.getJobSource(job.id);
    if (staleSource === null) throw new Error('expected an extraction source');

    context.apply(
      source({
        content: 'Project Juniper launches Monday.',
        editedAt: 1_800,
        revisionChecksum: 'revision-two',
      }),
    );
    const applied = memory.applyPreparedMutationBatch({
      completedAt: 1_900,
      expectedRevisionChecksum: staleSource.revisionChecksum,
      jobId: job.id,
      mutations: [
        {
          action: 'create',
          memory: {
            canonicalText: 'Project Marigold launches Friday.',
            confidence: 0.9,
            embedding: new Float32Array(1_536),
            kind: 'fact',
            provenance: { platformSourceId: messageId },
            sourceEventId: staleSource.id,
            timestamp: 1_900,
          },
        },
      ],
      sourceEventId: staleSource.id,
    });

    expect(applied).toEqual([]);
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('scrubs canonical, extraction, memory, and descendants on delete', () => {
    const { context, database, memory } = createHarness();
    context.apply(source());
    const sourceEventId = database
      .prepare('select id from source_events')
      .pluck()
      .get() as number;
    memory.applyMemory({
      canonicalText: 'Project Marigold launches Friday.',
      confidence: 0.9,
      embedding: new Float32Array(1_536),
      kind: 'fact',
      provenance: { platformSourceId: messageId },
      sourceEventId,
      timestamp: 1_500,
    });

    context.apply({
      deletedAt: 1_750,
      messageId,
      reason: 'discord-deleted',
      type: 'delete',
    });

    expect(
      database
        .prepare(
          `select content, content_state as contentState,
                  content_state_reason as reason
           from conversation_events`,
        )
        .get(),
    ).toEqual({
      content: '',
      contentState: 'scrubbed',
      reason: 'discord-deleted',
    });
    expect(
      database.prepare('select count(*) from source_events').pluck().get(),
    ).toBe(0);
    expect(
      database.prepare('select count(*) from memories').pluck().get(),
    ).toBe(0);
    expect(
      database.prepare('select count(*) from context_tombstones').pluck().get(),
    ).toBe(1);
    expect(
      database
        .prepare('select count(*) from context_forget_journal')
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });

  it('keeps the newest Discord revision under duplicates and reordering', () => {
    const { context, database } = createHarness();
    context.apply(source());
    context.apply(
      source({
        content: 'Newest revision.',
        editedAt: 2_000,
        revisionChecksum: 'revision-three',
      }),
    );

    expect(
      context.apply(
        source({
          content: 'Older revision.',
          editedAt: 1_500,
          revisionChecksum: 'revision-two',
        }),
      ),
    ).toMatchObject({ status: 'unchanged' });
    expect(
      context.apply(
        source({
          content: 'Newest revision.',
          editedAt: 2_000,
          revisionChecksum: 'revision-three',
        }),
      ),
    ).toMatchObject({ status: 'unchanged' });
    expect(
      database.prepare('select content from conversation_events').pluck().get(),
    ).toBe('Newest revision.');
    database.close();
  });
});
