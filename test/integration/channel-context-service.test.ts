import { describe, expect, it } from 'vitest';

import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { contextPeriod } from '../../src/context/context-period.js';
import {
  ContextStore,
  type ContextDocumentRevisionInput,
} from '../../src/context/context-store.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import { discordSourceRevisionChecksum } from '../../src/discord/source-message.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const timeZone = 'America/New_York';
const sevenDays = 7 * 24 * 60 * 60 * 1_000;
const thirtyDays = 30 * 24 * 60 * 60 * 1_000;

function createHarness(now: number) {
  const database = openChiefDatabase(':memory:');
  let current = now;
  const service = new ChannelContextService({
    channelId,
    conversation: new ConversationStore(database),
    database,
    guildId,
    now: () => current,
    timeZone,
  });
  migrateChiefDatabase(database);
  return {
    contextStore: new ContextStore(database),
    database,
    service,
    setNow: (value: number) => {
      current = value;
    },
  };
}

function source(
  occurredAt: number,
  overrides: Partial<{
    attachmentMetadataJson: string;
    content: string;
    editedAt: number | null;
    messageId: string;
    platformEventId: string;
  }> = {},
) {
  return {
    attachmentMetadataJson: overrides.attachmentMetadataJson ?? '[]',
    content: overrides.content ?? 'Project Marigold launches Friday.',
    editedAt: overrides.editedAt ?? null,
    messageId: overrides.messageId ?? '52345678901234567',
    occurredAt,
    platformEventId: overrides.platformEventId ?? 'live-create-key',
    replyToMessageId: null,
    requestId: '52345678901234567',
    role: 'human' as const,
    speakerId: '42345678901234567',
    speakerName: 'President Test',
    type: 'upsert' as const,
  };
}

function lexicalIds(
  database: ReturnType<typeof openChiefDatabase>,
  table: 'context_document_fts' | 'conversation_event_fts',
  query: string,
): number[] {
  return database
    .prepare(`select rowid from ${table} where ${table} match ?`)
    .pluck()
    .all(query) as number[];
}

function embedding(value: number): Float32Array {
  const result = new Float32Array(1536);
  result[0] = value;
  return result;
}

function documentInput(
  overrides: Partial<ContextDocumentRevisionInput> = {},
): ContextDocumentRevisionInput {
  return {
    completeness: 'final',
    confidence: 0.9,
    createdAt: 1_000,
    documentKey: 'hourly-cabinet',
    embedding: embedding(0.1),
    eventIds: [],
    generationInputTokens: 10,
    generationOutputTokens: 5,
    generationUsageUsd: 0.01,
    parentDocumentIds: [],
    periodEnd: 2_000,
    periodStart: 1_000,
    retentionDeadline: null,
    revision: 1,
    summary: 'Cabinet meets Friday.',
    tier: 'hourly',
    timeZone,
    topicKey: null,
    ...overrides,
  };
}

function sourceJobInput(
  database: ReturnType<typeof openChiefDatabase>,
  completeness: 'final' | 'provisional' = 'final',
): Pick<
  ContextDocumentRevisionInput,
  'periodEnd' | 'periodStart' | 'sourceRevisionChecksum' | 'timeZone'
> {
  const row = database
    .prepare(
      `select period_start as periodStart, period_end as periodEnd,
              source_revision_checksum as sourceRevisionChecksum,
              timezone as timeZone
       from context_jobs where completeness = ?`,
    )
    .get(completeness) as
    | Pick<
        ContextDocumentRevisionInput,
        'periodEnd' | 'periodStart' | 'sourceRevisionChecksum' | 'timeZone'
      >
    | undefined;
  if (row === undefined) throw new Error('expected a context source job');
  return row;
}

describe('ChannelContextService', () => {
  it('indexes upserts immediately and schedules one hourly job pair', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { database, service, setNow } = createHarness(occurredAt + 1_000);

    const created = service.apply(source(occurredAt));

    expect(created).toMatchObject({ status: 'applied' });
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual([
      created.eventId,
    ]);
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });
    const jobs = database
      .prepare(
        `select job_key as jobKey, completeness,
                source_revision_checksum as sourceRevisionChecksum,
                not_before as notBefore
         from context_jobs order by completeness desc`,
      )
      .all() as {
      completeness: string;
      jobKey: string;
      notBefore: number;
      sourceRevisionChecksum: string;
    }[];
    expect(jobs).toHaveLength(2);
    expect(jobs.map(({ completeness }) => completeness).sort()).toEqual([
      'final',
      'provisional',
    ]);
    expect(
      jobs.find(({ completeness }) => completeness === 'provisional')
        ?.notBefore,
    ).toBeLessThanOrEqual(occurredAt + 1_000 + 5 * 60 * 1_000);
    expect(
      jobs.find(({ completeness }) => completeness === 'final')?.notBefore,
    ).toBe(period.end);
    expect(jobs.every(({ jobKey }) => jobKey.includes(period.key))).toBe(true);
    const originalChecksum = jobs[0]?.sourceRevisionChecksum;

    setNow(occurredAt + 2_000);
    const edited = service.apply(
      source(occurredAt, {
        content: 'Project Juniper launches Monday.',
        editedAt: occurredAt + 1_500,
        platformEventId: 'reconciliation-key',
      }),
    );

    expect(edited.eventId).toBe(created.eventId);
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(1);
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(lexicalIds(database, 'conversation_event_fts', 'Juniper')).toEqual([
      created.eventId,
    ]);
    expect(
      database
        .prepare('select distinct source_revision_checksum from context_jobs')
        .pluck()
        .all(),
    ).not.toContain(originalChecksum);
    expect(
      database.prepare('select count(*) from context_jobs').pluck().get(),
    ).toBe(2);
    database.close();
  });

  it('keeps the first provisional deadline during continuous activity', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const firstNow = occurredAt + 1_000;
    const { database, service, setNow } = createHarness(firstNow);
    service.apply(source(occurredAt));
    const firstSchedule = database
      .prepare(
        `select not_before as notBefore,
                freshness_deadline as freshnessDeadline
         from context_jobs
         where completeness = 'provisional'`,
      )
      .get() as {
      readonly freshnessDeadline: number;
      readonly notBefore: number;
    };

    setNow(firstNow + 4 * 60 * 1_000);
    service.apply(
      source(occurredAt + 4 * 60 * 1_000, {
        content: 'Project Juniper launches Monday.',
        messageId: '52345678901234568',
        platformEventId: 'second-live-key',
      }),
    );

    expect(
      database
        .prepare(
          `select not_before as notBefore,
                  freshness_deadline as freshnessDeadline
           from context_jobs
           where completeness = 'provisional'`,
        )
        .get(),
    ).toEqual(firstSchedule);
    expect(firstSchedule).toEqual({
      freshnessDeadline: firstNow + 5 * 60 * 1_000,
      notBefore: firstNow + 4 * 60 * 1_000,
    });
    expect(
      database
        .prepare(
          `select not_before from context_jobs where completeness = 'final'`,
        )
        .pluck()
        .get(),
    ).toBe(
      contextPeriod({ instant: occurredAt, tier: 'hourly', timeZone }).end,
    );
    database.close();
  });

  it('rejects context output prepared against a stale source checksum', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(source(occurredAt));
    if (created.status !== 'applied')
      throw new Error('expected a source event');
    const staleChecksum = database
      .prepare(
        `select source_revision_checksum from context_jobs
         where completeness = 'provisional'`,
      )
      .pluck()
      .get() as string;
    service.apply(
      source(occurredAt, {
        content: 'Project Juniper launches Monday.',
        editedAt: occurredAt + 2_000,
      }),
    );
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });

    expect(() =>
      contextStore.activateDocumentRevision({
        ...documentInput({
          createdAt: occurredAt + 3_000,
          eventIds: [created.eventId],
          periodEnd: period.end,
          periodStart: period.start,
        }),
        sourceRevisionChecksum: staleChecksum,
      }),
    ).toThrow('context document source revision changed');
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('rejects source-derived context without a revision checksum', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(source(occurredAt));
    if (created.status !== 'applied') {
      throw new Error('expected a source event');
    }
    const period = contextPeriod({
      instant: occurredAt,
      tier: 'hourly',
      timeZone,
    });

    expect(() =>
      contextStore.activateDocumentRevision(
        documentInput({
          createdAt: occurredAt + 2_000,
          eventIds: [created.eventId],
          periodEnd: period.end,
          periodStart: period.start,
        }),
      ),
    ).toThrow('context document requires source revision checksum');
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    database.close();
  });

  it('suppresses active context descendants before applying an edit', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(source(occurredAt));
    if (created.status !== 'applied') {
      throw new Error('expected a source event');
    }
    const documentId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        createdAt: occurredAt + 1_500,
        documentKey: 'hourly-edit-invalidation',
        eventIds: [created.eventId],
        summary: 'Project Marigold launches Friday.',
      }),
    );

    expect(
      service.apply(
        source(occurredAt, {
          content: 'Project Juniper launches Monday.',
          editedAt: occurredAt + 2_000,
        }),
      ),
    ).toMatchObject({ status: 'applied' });

    expect(
      database
        .prepare(
          `select state, content_state as contentState,
                  content_state_reason as contentStateReason, summary
           from context_documents where id = ?`,
        )
        .get(documentId),
    ).toEqual({
      contentState: 'scrubbed',
      contentStateReason: 'retention-expired',
      state: 'suppressed',
      summary: '',
    });
    expect(lexicalIds(database, 'context_document_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(`select distinct status from context_jobs`)
        .pluck()
        .all(),
    ).toEqual(['pending']);
    database.close();
  });

  it('scrubs deletion descendants and blocks resurrection', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { contextStore, database, service } = createHarness(
      occurredAt + 1_000,
    );
    const created = service.apply(
      source(occurredAt, {
        attachmentMetadataJson: '[{"name":"brief.txt"}]',
        content: 'Delete Project Marigold.',
      }),
    );
    if (created.eventId === null) throw new Error('expected a source event');
    const eventId = created.eventId;
    const documentId = contextStore.activateDocumentRevision({
      ...sourceJobInput(database, 'provisional'),
      completeness: 'provisional',
      confidence: 0.9,
      createdAt: occurredAt + 2_000,
      documentKey: 'hourly-marigold',
      embedding: embedding(0.5),
      eventIds: [eventId],
      generationInputTokens: 10,
      generationOutputTokens: 5,
      generationUsageUsd: 0.01,
      parentDocumentIds: [],
      retentionDeadline: occurredAt + thirtyDays,
      revision: 1,
      summary: 'Project Marigold was discussed.',
      tier: 'hourly',
      topicKey: null,
    });

    const deletedAt = occurredAt + 3_000;
    expect(
      service.apply({
        deletedAt,
        messageId: source(occurredAt).messageId,
        reason: 'discord-deleted',
        type: 'delete',
      }),
    ).toMatchObject({ eventId: created.eventId, status: 'suppressed' });

    expect(
      database
        .prepare(
          `select content, attachment_metadata_json as attachmentMetadataJson,
                  deleted_at as deletedAt, content_state as contentState,
                  content_state_reason as contentStateReason,
                  discord_message_id as discordMessageId
           from conversation_events where id = ?`,
        )
        .get(created.eventId),
    ).toEqual({
      attachmentMetadataJson: '[]',
      content: '',
      contentState: 'scrubbed',
      contentStateReason: 'discord-deleted',
      deletedAt,
      discordMessageId: source(occurredAt).messageId,
    });
    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare(
          `select state, content_state as contentState,
                  content_state_reason as contentStateReason, summary
           from context_documents where id = ?`,
        )
        .get(documentId),
    ).toEqual({
      contentState: 'scrubbed',
      contentStateReason: 'discord-deleted',
      state: 'suppressed',
      summary: '',
    });
    expect(lexicalIds(database, 'context_document_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare(
          'select status, last_error_category as error from context_jobs',
        )
        .all(),
    ).toEqual([
      { error: 'source-invalidated', status: 'failed' },
      { error: 'source-invalidated', status: 'failed' },
    ]);
    expect(
      database
        .prepare(`select reason, scope_id as scopeId from context_tombstones`)
        .get(),
    ).toEqual({
      reason: 'discord-deleted',
      scopeId: `${guildId}/${channelId}/${source(occurredAt).messageId}`,
    });
    const journal = database
      .prepare('select * from context_forget_journal')
      .get() as Record<string, unknown>;
    expect(journal.upload_status).toBe('pending');
    expect(JSON.stringify(journal)).not.toContain('Delete Project Marigold');

    expect(service.apply(source(occurredAt))).toMatchObject({
      eventId: created.eventId,
      status: 'suppressed',
    });
    expect(
      database
        .prepare('select content from conversation_events where id = ?')
        .pluck()
        .get(created.eventId),
    ).toBe('');
    expect(() =>
      contextStore.activateDocumentRevision({
        ...sourceJobInput(database),
        completeness: 'final',
        confidence: 0.9,
        createdAt: deletedAt + 1,
        documentKey: 'hourly-marigold',
        embedding: embedding(0.6),
        eventIds: [eventId],
        generationInputTokens: 10,
        generationOutputTokens: 5,
        generationUsageUsd: 0.01,
        parentDocumentIds: [],
        retentionDeadline: occurredAt + thirtyDays,
        revision: 2,
        summary: 'Project Marigold was discussed.',
        tier: 'hourly',
        topicKey: null,
      }),
    ).toThrow('context document source is unavailable');
    database.close();
  });

  it('distinguishes local forgetting from Discord deletion', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { database, service } = createHarness(occurredAt + 1_000);
    const created = service.apply(source(occurredAt));

    service.apply({
      deletedAt: occurredAt + 2_000,
      messageId: source(occurredAt).messageId,
      reason: 'locally-forgotten',
      type: 'forget',
    });

    expect(
      database
        .prepare(
          'select content_state_reason from conversation_events where id = ?',
        )
        .pluck()
        .get(created.eventId),
    ).toBe('locally-forgotten');
    expect(
      database.prepare('select reason from context_tombstones').pluck().get(),
    ).toBe('locally-forgotten');
    database.close();
  });

  it('removes retained text from lexical search at raw expiry', () => {
    const occurredAt = Date.parse('2026-07-14T15:37:00Z');
    const { database, service } = createHarness(occurredAt + 1_000);
    service.apply(source(occurredAt));

    expect(service.maintain(occurredAt + thirtyDays)).toEqual({
      deletedEvents: 1,
    });

    expect(lexicalIds(database, 'conversation_event_fts', 'Marigold')).toEqual(
      [],
    );
    expect(
      database
        .prepare('select content_state_reason from conversation_events')
        .pluck()
        .get(),
    ).toBe('retention-expired');
    database.close();
  });

  it('records delivered chunks once with Discord identity and time', () => {
    const { database, service, setNow } = createHarness(1_000);
    const chunks = [
      {
        content: 'First chunk. ',
        messageId: '62345678901234567',
        occurredAt: 1_100,
      },
      {
        content: 'Second chunk.',
        messageId: '62345678901234568',
        occurredAt: 1_200,
      },
    ];
    const [firstChunk, secondChunk] = chunks;
    if (firstChunk === undefined || secondChunk === undefined) {
      throw new Error('expected reply chunks');
    }

    service.recordDeliveredReply({
      chunks: [firstChunk],
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });
    setNow(2_000);
    service.recordDeliveredReply({
      chunks: [firstChunk, secondChunk],
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });

    expect(
      database
        .prepare(
          `select discord_message_id as discordMessageId, content, occurred_at as occurredAt,
                  recent_until as recentUntil, retention_deadline as retentionDeadline,
                  logical_response_id as logicalResponseId,
                  platform_event_id as platformEventId,
                  reply_to_message_id as replyToMessageId,
                  response_chunk_index as responseChunkIndex,
                  revision_checksum as revisionChecksum,
                  speaker_id as speakerId
           from conversation_events order by id`,
        )
        .all(),
    ).toEqual(
      chunks.map((chunk) => ({
        content: chunk.content,
        discordMessageId: chunk.messageId,
        logicalResponseId: 'response-1',
        occurredAt: chunk.occurredAt,
        platformEventId: chunk.messageId,
        recentUntil: chunk.occurredAt + sevenDays,
        replyToMessageId: '52345678901234567',
        responseChunkIndex: chunks.indexOf(chunk),
        revisionChecksum: discordSourceRevisionChecksum({
          attachmentMetadataJson: '[]',
          authorKind: 'chief',
          content: chunk.content,
          editedAt: null,
          messageId: chunk.messageId,
          occurredAt: chunk.occurredAt,
          replyToMessageId: '52345678901234567',
          requesterId: '12345678901234567',
        }),
        retentionDeadline: chunk.occurredAt + thirtyDays,
        speakerId: '12345678901234567',
      })),
    );

    setNow(3_000);
    service.recordDeliveredReply({
      chunks,
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: 'retry-caller-key',
      speakerId: '12345678901234567',
    });
    expect(
      database
        .prepare('select count(*) from conversation_events')
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      database
        .prepare('select occurred_at from conversation_events order by id')
        .pluck()
        .all(),
    ).toEqual([1_100, 1_200]);
    database.close();
  });

  it('attaches callback lineage when reconciliation won the source race', () => {
    const { database, service } = createHarness(1_000);
    const messageId = '62345678901234567';
    const revisionChecksum = discordSourceRevisionChecksum({
      attachmentMetadataJson: '[]',
      authorKind: 'chief',
      content: 'Delivered answer.',
      editedAt: null,
      messageId,
      occurredAt: 1_100,
      replyToMessageId: '52345678901234567',
      requesterId: '12345678901234567',
    });
    service.apply({
      attachmentMetadataJson: '[]',
      content: 'Delivered answer.',
      editedAt: null,
      messageId,
      occurredAt: 1_100,
      platformEventId: messageId,
      replyToMessageId: '52345678901234567',
      requestId: messageId,
      revisionChecksum,
      role: 'chief',
      speakerId: '12345678901234567',
      speakerName: 'Chief',
      type: 'upsert',
    });

    service.recordDeliveredReply({
      chunks: [{ content: 'Delivered answer.', messageId, occurredAt: 1_100 }],
      logicalResponseId: 'response-1',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });

    expect(
      database
        .prepare(
          `select count(*) as count,
                  max(logical_response_id) as logicalResponseId,
                  max(request_id) as requestId
           from conversation_events where discord_message_id = ?`,
        )
        .get(messageId),
    ).toEqual({
      count: 1,
      logicalResponseId: 'response-1',
      requestId: '52345678901234567',
    });
    database.close();
  });

  it('repairs durable delivered order after reverse reconciliation', () => {
    const { database, service } = createHarness(1_000);
    const chunks = [
      {
        content: 'First chunk. ',
        messageId: '62345678901234567',
        occurredAt: 1_100,
      },
      {
        content: 'Second chunk.',
        messageId: '62345678901234568',
        occurredAt: 1_200,
      },
    ];
    for (const chunk of [...chunks].reverse()) {
      service.apply({
        attachmentMetadataJson: '[]',
        content: chunk.content,
        editedAt: null,
        messageId: chunk.messageId,
        occurredAt: chunk.occurredAt,
        platformEventId: chunk.messageId,
        replyToMessageId: null,
        requestId: chunk.messageId,
        role: 'chief',
        speakerId: '12345678901234567',
        speakerName: 'Chief',
        type: 'upsert',
      });
    }

    service.recordDeliveredReply({
      chunks,
      logicalResponseId: 'response-ordered',
      replyToMessageId: '52345678901234567',
      requestId: '52345678901234567',
      speakerId: '12345678901234567',
    });

    expect(
      database
        .prepare(
          `select discord_message_id as messageId,
                  response_chunk_index as chunkIndex
           from conversation_events order by response_chunk_index`,
        )
        .all(),
    ).toEqual([
      { chunkIndex: 0, messageId: chunks[0]?.messageId },
      { chunkIndex: 1, messageId: chunks[1]?.messageId },
    ]);
    expect(
      new ConversationStore(database).recent({ now: 2_000 }).events,
    ).toEqual([
      expect.objectContaining({ content: 'First chunk. Second chunk.' }),
    ]);
    database.close();
  });
});

describe('ContextStore', () => {
  it('rejects a document without source or parent lineage atomically', () => {
    const { contextStore, database } = createHarness(1_000);

    expect(() =>
      contextStore.activateDocumentRevision(documentInput()),
    ).toThrow('context document requires lineage');
    expect(
      database.prepare('select count(*) from context_documents').pluck().get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_fts')
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare('select count(*) from context_document_vectors')
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('replaces an active document and its search rows atomically', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const base = {
      ...documentInput(),
      ...sourceJobInput(database),
      eventIds: [created.eventId],
    };
    const firstId = contextStore.activateDocumentRevision({
      ...base,
      embedding: embedding(0.1),
      revision: 1,
      summary: 'Cabinet meets Friday.',
    });
    const secondId = contextStore.activateDocumentRevision({
      ...base,
      createdAt: 2_000,
      embedding: embedding(0.2),
      revision: 2,
      summary: 'Cabinet meets Monday.',
    });

    expect(
      database
        .prepare('select id, state from context_documents order by id')
        .all(),
    ).toEqual([
      { id: firstId, state: 'superseded' },
      { id: secondId, state: 'active' },
    ]);
    expect(lexicalIds(database, 'context_document_fts', 'Friday')).toEqual([]);
    expect(lexicalIds(database, 'context_document_fts', 'Monday')).toEqual([
      secondId,
    ]);
    expect(
      database
        .prepare('select document_id from context_document_vectors')
        .pluck()
        .all(),
    ).toEqual([secondId]);
    database.close();
  });

  it.each(['daily', 'weekly', 'long-term'] as const)(
    'rejects raw source lineage for $tier documents atomically',
    (tier) => {
      const { contextStore, database, service } = createHarness(1_000);
      const created = service.apply(source(500));
      if (created.eventId === null) throw new Error('expected a source event');
      const eventId = created.eventId;

      expect(() =>
        contextStore.activateDocumentRevision(
          documentInput({
            documentKey: `${tier}-raw-source`,
            eventIds: [eventId],
            parentDocumentIds: [],
            periodEnd: tier === 'long-term' ? null : 3_000,
            summary: 'Raw source must not bypass hierarchy.',
            tier,
          }),
        ),
      ).toThrow('higher context tier requires parent lineage');
      for (const table of [
        'context_documents',
        'context_document_fts',
        'context_document_vectors',
        'context_document_events',
        'context_document_parents',
      ]) {
        expect(
          database.prepare(`select count(*) from ${table}`).pluck().get(),
        ).toBe(0);
      }
      database.close();
    },
  );

  it('rejects mixed raw and parent lineage for a higher tier atomically', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const eventId = created.eventId;
    const finalParentId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        completeness: 'final',
        documentKey: 'hourly-final-parent',
        eventIds: [eventId],
        summary: 'Final hourly parent.',
      }),
    );
    const tables = [
      'context_documents',
      'context_document_fts',
      'context_document_vectors',
      'context_document_events',
      'context_document_parents',
    ] as const;
    const countsBefore = tables.map((table) =>
      database.prepare(`select count(*) from ${table}`).pluck().get(),
    );

    expect(() =>
      contextStore.activateDocumentRevision(
        documentInput({
          documentKey: 'daily-mixed-lineage',
          eventIds: [eventId],
          parentDocumentIds: [finalParentId],
          periodEnd: 3_000,
          summary: 'Mixed lineage must not bypass hierarchy.',
          tier: 'daily',
        }),
      ),
    ).toThrow('higher context tier requires parent-only lineage');
    expect(
      tables.map((table) =>
        database.prepare(`select count(*) from ${table}`).pluck().get(),
      ),
    ).toEqual(countsBefore);
    expect(lexicalIds(database, 'context_document_fts', 'Mixed')).toEqual([]);
    expect(
      database
        .prepare(
          `select count(*) from context_documents
           where document_key = 'daily-mixed-lineage'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('requires final parents for every higher context tier', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const provisionalId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database, 'provisional'),
        completeness: 'provisional',
        documentKey: 'hourly-source',
        eventIds: [created.eventId],
        summary: 'Provisional hourly rollup.',
      }),
    );

    for (const tier of ['daily', 'weekly', 'long-term'] as const) {
      expect(() =>
        contextStore.activateDocumentRevision(
          documentInput({
            documentKey: `${tier}-rejected`,
            eventIds: [],
            parentDocumentIds: [provisionalId],
            periodEnd: tier === 'long-term' ? null : 3_000,
            summary: 'Rejected higher rollup.',
            tier,
          }),
        ),
      ).toThrow('higher context tier requires final parents');
    }
    expect(lexicalIds(database, 'context_document_fts', 'Rejected')).toEqual(
      [],
    );

    const finalId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        completeness: 'final',
        createdAt: 2_000,
        documentKey: 'hourly-source',
        embedding: embedding(0.2),
        eventIds: [created.eventId],
        revision: 2,
        summary: 'Final hourly rollup.',
      }),
    );
    const dailyId = contextStore.activateDocumentRevision(
      documentInput({
        documentKey: 'daily-accepted',
        eventIds: [],
        parentDocumentIds: [finalId],
        periodEnd: 3_000,
        summary: 'Accepted daily rollup.',
        tier: 'daily',
      }),
    );
    expect(lexicalIds(database, 'context_document_fts', 'Accepted')).toEqual([
      dailyId,
    ]);
    database.close();
  });

  it('rejects a revision below the maximum without replacing search state', () => {
    const { contextStore, database, service } = createHarness(1_000);
    const created = service.apply(source(500));
    if (created.eventId === null) throw new Error('expected a source event');
    const eventId = created.eventId;
    const secondId = contextStore.activateDocumentRevision(
      documentInput({
        ...sourceJobInput(database),
        documentKey: 'hourly-monotonic',
        eventIds: [eventId],
        revision: 2,
        summary: 'Revision two remains searchable.',
      }),
    );

    expect(() =>
      contextStore.activateDocumentRevision(
        documentInput({
          ...sourceJobInput(database),
          createdAt: 2_000,
          documentKey: 'hourly-monotonic',
          embedding: embedding(0.2),
          eventIds: [eventId],
          revision: 1,
          summary: 'Revision one must not replace it.',
        }),
      ),
    ).toThrow('context document revision must increase');
    expect(
      database
        .prepare(
          `select id, revision, state from context_documents
           where document_key = 'hourly-monotonic'`,
        )
        .all(),
    ).toEqual([{ id: secondId, revision: 2, state: 'active' }]);
    expect(lexicalIds(database, 'context_document_fts', 'remains')).toEqual([
      secondId,
    ]);
    expect(lexicalIds(database, 'context_document_fts', 'replace')).toEqual([]);
    expect(
      database
        .prepare('select document_id from context_document_vectors')
        .pluck()
        .all(),
    ).toContain(secondId);
    database.close();
  });
});
