import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextAssembler } from '../../src/context/context-assembler.js';
import type { ContextTier } from '../../src/context/context-types.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { ContextPersistenceError } from '../../src/context/context-errors.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const speakerId = '42345678901234567';
const now = Date.parse('2026-07-14T16:00:00Z');
const queryVector = new Float32Array(1_536).fill(0.25);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContextAssembler', () => {
  it('classifies a recent-history read failure as lost persistence', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    vi.spyOn(conversation, 'recent').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: vi.fn(),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: new SqliteMemoryStore(database),
      }),
      timeZone: 'America/New_York',
    });

    await expect(
      assembler.assemble({ now, prompt: 'What changed?' }),
    ).rejects.toBeInstanceOf(ContextPersistenceError);
    database.close();
  });

  it('embeds once and queries source, every tier, and durable memory', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    memoryStore.applyMemory({
      canonicalText: 'The launch color is marigold.',
      confidence: 0.99,
      embedding: queryVector,
      kind: 'fact',
      provenance: {},
      sourceEventId: null,
      timestamp: now - 1_000,
    });
    const memory = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: memoryStore,
    });
    recordEvent(conversation, {
      content: 'The latest conversation stays chronological.',
      messageId: '52345678901234567',
      occurredAt: now - 1_000,
      recentUntil: now + 60_000,
    });
    const sourceId = recordEvent(conversation, {
      content: 'The launch review chose a Friday window.',
      messageId: '52345678901234568',
      occurredAt: now - 8 * 24 * 60 * 60 * 1_000,
      recentUntil: now - 1,
    });
    indexSource(database, sourceId, 'The launch review chose a Friday window.');

    const summaries: Record<ContextTier, string> = {
      hourly: 'The group compared two release windows.',
      daily: 'The group assigned owners for the rollout.',
      weekly: 'The group kept the launch plan unresolved.',
      'long-term': 'The recurring project evolved toward a staged release.',
    };
    for (const [index, tier] of (
      ['hourly', 'daily', 'weekly', 'long-term'] as const
    ).entries()) {
      const eventId = recordEvent(conversation, {
        content: `Lineage ${tier}`,
        messageId: String(52345678901234569n + BigInt(index)),
        occurredAt: now - (index + 1) * 60 * 60 * 1_000,
        recentUntil: now - 1,
      });
      insertDocument(database, {
        eventIds: [eventId],
        id: index + 1,
        periodEnd: tier === 'long-term' ? null : now - index * 1_000,
        periodStart: now - (index + 1) * 60 * 60 * 1_000,
        summary: summaries[tier],
        tier,
      });
    }
    const embed = vi.fn(() =>
      Promise.resolve({ embedding: queryVector, usageUsd: 0.002 }),
    );
    const currentEventId = recordEvent(conversation, {
      content: 'Current launch question.',
      messageId: '52345678901234590',
      occurredAt: now,
      recentUntil: now + 60_000,
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed,
      guildId,
      memory,
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      beforeEventId: currentEventId,
      now,
      prompt: 'What did we decide about the launch?',
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith('What did we decide about the launch?');
    expect(prepared.usageUsd).toBe(0.002);
    expect(prepared.memories).toEqual(['The launch color is marigold.']);
    expect(prepared.recentConversation).toEqual([
      {
        content: 'The latest conversation stays chronological.',
        role: 'human',
        speakerName: 'President Test',
      },
    ]);
    expect(
      prepared.historicalContext.filter(
        ({ evidenceForm }) => evidenceForm === 'source',
      ),
    ).toEqual([
      expect.objectContaining({
        evidenceForm: 'source',
        occurredAt: now - 8 * 24 * 60 * 60 * 1_000,
        sourceLinks: [
          `https://discord.com/channels/${guildId}/${channelId}/52345678901234568`,
        ],
        text: 'The launch review chose a Friday window.',
      }),
    ]);
    expect(
      prepared.historicalContext.flatMap((context) =>
        context.evidenceForm === 'rollup' ? [context.tier] : [],
      ),
    ).toEqual(['hourly', 'daily', 'weekly', 'long-term']);
    expect(prepared.degraded).toBe(false);
    expect(prepared.approximateTokens).toBeLessThanOrEqual(8_000);
    database.close();
  });

  it('reserves recent context and truncates oversized relevant history', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    recordEvent(conversation, {
      content: `Recent ${'conversation '.repeat(2_000)}`,
      messageId: '52345678901234600',
      occurredAt: now - 1_000,
      recentUntil: now + 60_000,
    });
    const historicalText = `Marigold ${'historical detail '.repeat(500)}`;
    const historicalId = recordEvent(conversation, {
      content: historicalText,
      messageId: '52345678901234601',
      occurredAt: now - 8 * 24 * 60 * 60 * 1_000,
      recentUntil: now - 1,
    });
    indexSource(database, historicalId, historicalText);
    const currentEventId = recordEvent(conversation, {
      content: 'Current Marigold question.',
      messageId: '52345678901234602',
      occurredAt: now,
      recentUntil: now + 60_000,
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      beforeEventId: currentEventId,
      now,
      prompt: 'Marigold',
    });

    expect(prepared.approximateTokens).toBeLessThanOrEqual(8_000);
    expect(
      Math.ceil(
        Buffer.byteLength(
          prepared.recentConversation.map(({ content }) => content).join(''),
          'utf8',
        ) / 3,
      ),
    ).toBeGreaterThanOrEqual(4_000);
    const source = prepared.historicalContext.find(
      ({ evidenceForm }) => evidenceForm === 'source',
    );
    expect(source).toMatchObject({ evidenceForm: 'source' });
    if (source?.evidenceForm !== 'source') {
      throw new Error('expected source evidence');
    }
    expect(source.text.length).toBeLessThan(historicalText.length);
    expect(source.text.endsWith('…')).toBe(true);
    database.close();
  });

  it('reassembles Chief source chunks by logical response', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const chunkIds = conversation.recordBatch(
      ['Teddy chose ', 'New Mexico.'].map((content, responseChunkIndex) => ({
        channelId,
        content,
        discordMessageId: String(
          52345678901234605n + BigInt(responseChunkIndex),
        ),
        guildId,
        logicalResponseId: 'response-teddy',
        medium: 'text' as const,
        occurredAt: now - 8 * 24 * 60 * 60 * 1_000 + responseChunkIndex,
        platformEventId: `chief-chunk-${String(responseChunkIndex)}`,
        recentUntil: now - 1,
        requestId: 'teddy-request',
        responseChunkIndex,
        retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
        role: 'chief' as const,
        speakerId: null,
        speakerName: 'Chief',
      })),
    );
    indexSource(database, chunkIds[0] ?? 0, 'Teddy chose ');
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({ now, prompt: 'Teddy' });

    expect(prepared.historicalContext).toEqual([
      expect.objectContaining({
        evidenceForm: 'source',
        sourceLinks: [
          `https://discord.com/channels/${guildId}/${channelId}/52345678901234605`,
          `https://discord.com/channels/${guildId}/${channelId}/52345678901234606`,
        ],
        text: 'Teddy chose New Mexico.',
      }),
    ]);
    database.close();
  });

  it('keeps source matches and grouped chunks before the event boundary', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const firstChunkId = conversation.record({
      channelId,
      content: 'Teddy chose ',
      discordMessageId: '52345678901234607',
      guildId,
      logicalResponseId: 'bounded-response',
      medium: 'text',
      occurredAt: now - 3_000,
      platformEventId: 'bounded-response-0',
      recentUntil: now - 1,
      requestId: 'bounded-request',
      responseChunkIndex: 0,
      retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
      role: 'chief',
      speakerId: null,
      speakerName: 'Chief',
    });
    const currentEventId = recordEvent(conversation, {
      content: 'Current Teddy question.',
      messageId: '52345678901234608',
      occurredAt: now - 2_000,
      recentUntil: now + 60_000,
    });
    conversation.record({
      channelId,
      content: 'New Mexico.',
      discordMessageId: '52345678901234609',
      guildId,
      logicalResponseId: 'bounded-response',
      medium: 'text',
      occurredAt: now - 1_000,
      platformEventId: 'bounded-response-1',
      recentUntil: now - 1,
      requestId: 'bounded-request',
      responseChunkIndex: 1,
      retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
      role: 'chief',
      speakerId: null,
      speakerName: 'Chief',
    });
    const laterEventId = recordEvent(conversation, {
      content: 'Teddy later chose Syracuse.',
      messageId: '52345678901234610',
      occurredAt: now - 1_000,
      recentUntil: now - 1,
    });
    indexSource(database, firstChunkId, 'Teddy chose ');
    indexSource(database, laterEventId, 'Teddy later chose Syracuse.');
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      beforeEventId: currentEventId,
      now,
      prompt: 'Teddy',
    });

    expect(prepared.historicalContext).toEqual([
      expect.objectContaining({
        evidenceForm: 'source',
        sourceLinks: [
          `https://discord.com/channels/${guildId}/${channelId}/52345678901234607`,
        ],
        text: 'Teddy chose ',
      }),
    ]);
    database.close();
  });

  it('excludes recent source hits before the FTS result limit', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    for (let index = 0; index < 24; index += 1) {
      const eventId = recordEvent(conversation, {
        content: 'OverflowBeacon',
        messageId: String(52345678901234900n + BigInt(index)),
        occurredAt: now - index,
        recentUntil: now + 60_000,
      });
      indexSource(database, eventId, 'OverflowBeacon');
    }
    const historicalId = recordEvent(conversation, {
      content: 'OverflowBeacon older retained source.',
      messageId: '52345678901234924',
      occurredAt: now - 8 * 24 * 60 * 60 * 1_000,
      recentUntil: now - 1,
    });
    indexSource(
      database,
      historicalId,
      'OverflowBeacon older retained source.',
    );
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'OverflowBeacon',
    });

    expect(prepared.recentConversation).toHaveLength(24);
    expect(prepared.historicalContext).toEqual([
      expect.objectContaining({
        evidenceForm: 'source',
        text: 'OverflowBeacon older retained source.',
      }),
    ]);
    database.close();
  });

  it('excludes rollups with lineage at or after the event boundary', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const olderEventId = recordEvent(conversation, {
      content: 'Older boundary lineage.',
      messageId: '52345678901234930',
      occurredAt: now - 3_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [olderEventId],
      id: 1,
      periodEnd: now - 3_000,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'BoundaryBeacon older discussion.',
      tier: 'daily',
    });
    const currentEventId = recordEvent(conversation, {
      content: 'Current boundary question.',
      messageId: '52345678901234931',
      occurredAt: now - 2_000,
      recentUntil: now + 60_000,
    });
    const laterEventId = recordEvent(conversation, {
      content: 'Later boundary lineage.',
      messageId: '52345678901234932',
      occurredAt: now - 1_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [laterEventId],
      id: 2,
      periodEnd: now - 1_000,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'BoundaryBeacon later discussion.',
      tier: 'daily',
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      beforeEventId: currentEventId,
      now,
      prompt: 'BoundaryBeacon',
    });

    expect(prepared.historicalContext).toEqual([
      expect.objectContaining({
        evidenceForm: 'rollup',
        summary: 'BoundaryBeacon older discussion.',
      }),
    ]);
    database.close();
  });

  it('prefers newer duplicate evidence within one tier', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const olderEventId = recordEvent(conversation, {
      content: 'Older source.',
      messageId: '52345678901234610',
      occurredAt: now - 2 * 60 * 60 * 1_000,
      recentUntil: now - 1,
    });
    const newerEventId = recordEvent(conversation, {
      content: 'Newer correction source.',
      messageId: '52345678901234611',
      occurredAt: now - 60 * 60 * 1_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [olderEventId],
      id: 1,
      periodEnd: now - 60 * 60 * 1_000,
      periodStart: now - 2 * 60 * 60 * 1_000,
      summary: 'Marigold ships Friday.',
      tier: 'hourly',
    });
    insertDocument(database, {
      eventIds: [newerEventId],
      id: 2,
      periodEnd: now,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'MARIGOLD ships Friday',
      tier: 'hourly',
    });
    database
      .prepare('delete from context_document_vectors where document_id = ?')
      .run(2n);
    database
      .prepare(
        'insert into context_document_vectors (document_id, embedding) values (?, ?)',
      )
      .run(2n, JSON.stringify(Array.from(new Float32Array(1_536).fill(0.275))));
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'Marigold Friday',
    });

    expect(
      prepared.historicalContext.filter(
        ({ evidenceForm }) => evidenceForm === 'rollup',
      ),
    ).toEqual([
      expect.objectContaining({
        periodEnd: now,
        sourceLinks: [
          `https://discord.com/channels/${guildId}/${channelId}/52345678901234611`,
        ],
      }),
    ]);
    database.close();
  });

  it('suppresses rollups whose lineage is already recent', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const recentEventId = recordEvent(conversation, {
      content: 'Marigold moved to Monday.',
      messageId: '52345678901234615',
      occurredAt: now - 1_000,
      recentUntil: now + 60_000,
    });
    insertDocument(database, {
      eventIds: [recentEventId],
      id: 1,
      periodEnd: now,
      periodStart: now - 24 * 60 * 60 * 1_000,
      summary: 'The group rescheduled the Marigold release.',
      tier: 'daily',
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'Marigold release',
    });

    expect(prepared.recentConversation).toEqual([
      expect.objectContaining({ content: 'Marigold moved to Monday.' }),
    ]);
    expect(prepared.historicalContext).toEqual([]);
    database.close();
  });

  it('bounds rollup links and labels expired lineage summary-only', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const lineageIds = [
      'not-a-discord-snowflake',
      '52345678901234620',
      '52345678901234621',
      '52345678901234622',
      '52345678901234623',
      '52345678901234624',
    ].map((messageId, index) =>
      recordEvent(conversation, {
        content: `Archive lineage ${String(index)}`,
        messageId,
        occurredAt: now - index * 1_000,
        recentUntil: now - 1,
      }),
    );
    database
      .prepare(
        `update conversation_events
         set content = '', content_state = 'scrubbed',
             content_state_reason = 'retention-expired'
         where id = ?`,
      )
      .run(lineageIds[2]);
    database
      .prepare(
        `update conversation_events
         set content = '', content_state = 'scrubbed',
             content_state_reason = 'discord-deleted'
         where id = ?`,
      )
      .run(lineageIds[1]);
    insertDocument(database, {
      eventIds: lineageIds,
      id: 1,
      periodEnd: now,
      periodStart: now - 24 * 60 * 60 * 1_000,
      summary: 'The archive discussion remained unresolved.',
      tier: 'daily',
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({ now, prompt: 'archive' });
    const rollup = prepared.historicalContext.find(
      ({ evidenceForm }) => evidenceForm === 'rollup',
    );

    expect(rollup).toMatchObject({
      evidenceForm: 'rollup',
      provenanceQuality: 'summary-only',
      temporalLabel: 'Jul 13, 2026',
    });
    expect(rollup?.sourceLinks).toHaveLength(3);
    expect(rollup?.sourceLinks.join('\n')).not.toContain(
      'not-a-discord-snowflake',
    );
    expect(rollup?.sourceLinks.join('\n')).not.toContain('52345678901234620');
    database.close();
  });

  it('does not force lexically irrelevant tier results', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const relevantEventId = recordEvent(conversation, {
      content: 'Relevant lineage.',
      messageId: '52345678901234630',
      occurredAt: now - 2_000,
      recentUntil: now - 1,
    });
    const irrelevantEventId = recordEvent(conversation, {
      content: 'Irrelevant lineage.',
      messageId: '52345678901234631',
      occurredAt: now - 1_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [relevantEventId],
      id: 1,
      periodEnd: now - 1_000,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'Marigold ships Friday.',
      tier: 'daily',
    });
    insertDocument(database, {
      eventIds: [irrelevantEventId],
      id: 2,
      periodEnd: now,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'We had lunch.',
      tier: 'daily',
    });
    database
      .prepare('delete from context_document_vectors where document_id = ?')
      .run(2n);
    database
      .prepare(
        'insert into context_document_vectors (document_id, embedding) values (?, ?)',
      )
      .run(2n, JSON.stringify(Array.from(new Float32Array(1_536).fill(0.5))));
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'What did we decide about Marigold?',
    });

    expect(
      prepared.historicalContext.flatMap((context) =>
        context.evidenceForm === 'rollup' ? [context.summary] : [],
      ),
    ).toEqual(['Marigold ships Friday.']);
    database.close();
  });

  it('requires the distinctive term for lexical-only evidence', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const weakSourceId = recordEvent(conversation, {
      content: 'The unrelated project lunch menu.',
      messageId: '52345678901234632',
      occurredAt: now - 4_000,
      recentUntil: now - 1,
    });
    indexSource(database, weakSourceId, 'The unrelated project lunch menu.');
    const modifierSourceId = recordEvent(conversation, {
      content: 'The launch lunch menu.',
      messageId: '52345678901234633',
      occurredAt: now - 3_000,
      recentUntil: now - 1,
    });
    indexSource(database, modifierSourceId, 'The launch lunch menu.');
    const validSourceId = recordEvent(conversation, {
      content: 'Marigold ships Friday.',
      messageId: '52345678901234634',
      occurredAt: now - 2_000,
      recentUntil: now - 1,
    });
    indexSource(database, validSourceId, 'Marigold ships Friday.');
    for (const [index, summary] of [
      'The unrelated project lunch plan.',
      'The launch lunch remained unresolved.',
      'Marigold readiness review.',
    ].entries()) {
      const eventId = recordEvent(conversation, {
        content: `Lexical lineage ${String(index)}`,
        messageId: String(52345678901234635n + BigInt(index)),
        occurredAt: now - (index + 1) * 1_000,
        recentUntil: now - 1,
      });
      insertDocument(database, {
        eventIds: [eventId],
        id: index + 1,
        periodEnd: now - index,
        periodStart: now - 24 * 60 * 60 * 1_000,
        summary,
        tier: 'daily',
      });
      database
        .prepare('delete from context_document_vectors where document_id = ?')
        .run(BigInt(index + 1));
      database
        .prepare(
          'insert into context_document_vectors (document_id, embedding) values (?, ?)',
        )
        .run(
          BigInt(index + 1),
          JSON.stringify(Array.from(new Float32Array(1_536).fill(0.5))),
        );
    }
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    for (const prompt of [
      'Marigold launch project',
      'marigold launch project',
    ]) {
      const prepared = await assembler.assemble({ now, prompt });
      const statements = prepared.historicalContext.map((context) =>
        context.evidenceForm === 'source' ? context.text : context.summary,
      );

      expect(statements).toEqual([
        'Marigold ships Friday.',
        'Marigold readiness review.',
      ]);
    }
    database.close();
  });

  it('keeps named-term evidence when a generic modifier is absent', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const sourceId = recordEvent(conversation, {
      content: 'Marigold ships Friday.',
      messageId: '52345678901234636',
      occurredAt: now - 3_000,
      recentUntil: now - 1,
    });
    indexSource(database, sourceId, 'Marigold ships Friday.');
    const rollupEventId = recordEvent(conversation, {
      content: 'Marigold release lineage.',
      messageId: '52345678901234637',
      occurredAt: now - 2_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [rollupEventId],
      id: 1,
      periodEnd: now,
      periodStart: now - 24 * 60 * 60 * 1_000,
      summary: 'Marigold release window is Friday.',
      tier: 'daily',
    });
    database
      .prepare('delete from context_document_vectors where document_id = 1')
      .run();
    database
      .prepare(
        'insert into context_document_vectors (document_id, embedding) values (1, ?)',
      )
      .run(JSON.stringify(Array.from(new Float32Array(1_536).fill(0.5))));
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: new SqliteMemoryStore(database),
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'Marigold update',
    });

    expect(
      prepared.historicalContext.map((context) =>
        context.evidenceForm === 'source' ? context.text : context.summary,
      ),
    ).toEqual(['Marigold ships Friday.', 'Marigold release window is Friday.']);
    database.close();
  });

  it('caps rollup lexical matches before relevance filtering', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const lineageId = recordEvent(conversation, {
      content: 'Bounded scan lineage.',
      messageId: '52345678901234638',
      occurredAt: now - 2_000,
      recentUntil: now - 1,
    });
    for (let index = 0; index < 97; index += 1) {
      insertDocument(database, {
        eventIds: [lineageId],
        id: index + 1,
        periodEnd: now - index,
        periodStart: now - 24 * 60 * 60 * 1_000,
        summary: `Project update ${String(index)}`,
        tier: 'daily',
      });
    }
    database.prepare('delete from context_document_vectors').run();
    const lexicalBatchSizes: number[] = [];
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation((source) => {
      const statement = prepare(source);
      if (!source.includes('from context_document_fts f')) return statement;
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
        const rows = all(...parameters);
        lexicalBatchSizes.push(rows.length);
        return rows;
      });
      return statement;
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: new SqliteMemoryStore(database),
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'Marigold launch project',
    });

    expect(prepared.degraded).toBe(false);
    expect(Math.max(...lexicalBatchSizes)).toBeLessThanOrEqual(96);
    vi.restoreAllMocks();
    database.close();
  });

  it('does not retrieve rollups from another channel', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const otherEventId = conversation.record({
      channelId: 'another-channel',
      content: 'Private other-channel lineage.',
      discordMessageId: '52345678901234635',
      guildId,
      medium: 'text',
      occurredAt: now - 1_000,
      platformEventId: 'other-channel-event',
      recentUntil: now - 1,
      requestId: 'other-channel-event',
      retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
      role: 'human',
      speakerId,
      speakerName: 'President Other',
    });
    insertDocument(database, {
      eventIds: [otherEventId],
      id: 1,
      periodEnd: now,
      periodStart: now - 24 * 60 * 60 * 1_000,
      summary: 'Private other-channel Marigold discussion.',
      tier: 'daily',
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'Marigold discussion',
    });

    expect(prepared.historicalContext).toEqual([]);
    database.close();
  });

  it('uses vector retrieval when no lexical terms remain', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const eventId = recordEvent(conversation, {
      content: 'Vector lineage.',
      messageId: '52345678901234640',
      occurredAt: now - 1_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [eventId],
      id: 1,
      periodEnd: now,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'A semantically relevant discussion.',
      tier: 'weekly',
    });
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'What did we decide about it?',
    });

    expect(prepared.degraded).toBe(false);
    expect(prepared.historicalContext).toEqual([
      expect.objectContaining({ evidenceForm: 'rollup', tier: 'weekly' }),
    ]);
    database.close();
  });

  it('does not let a busy tier starve another tier vector query', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    for (let index = 0; index < 24; index += 1) {
      const eventId = recordEvent(conversation, {
        content: `Hourly lineage ${String(index)}`,
        messageId: String(52345678901234700n + BigInt(index)),
        occurredAt: now - index * 1_000,
        recentUntil: now - 1,
      });
      insertDocument(database, {
        eventIds: [eventId],
        id: index + 1,
        periodEnd: now - index * 1_000,
        periodStart: now - 60 * 60 * 1_000,
        summary: `Hourly candidate ${String(index)}`,
        tier: 'hourly',
      });
    }
    const weeklyEventId = recordEvent(conversation, {
      content: 'Weekly lineage',
      messageId: '52345678901234724',
      occurredAt: now - 7 * 24 * 60 * 60 * 1_000,
      recentUntil: now - 1,
    });
    insertDocument(database, {
      eventIds: [weeklyEventId],
      id: 25,
      periodEnd: now,
      periodStart: now - 7 * 24 * 60 * 60 * 1_000,
      summary: 'Weekly candidate survives a busy hourly tier.',
      tier: 'weekly',
    });
    database
      .prepare('delete from context_document_vectors where document_id = ?')
      .run(25n);
    database
      .prepare(
        'insert into context_document_vectors (document_id, embedding) values (?, ?)',
      )
      .run(
        25n,
        JSON.stringify(Array.from(new Float32Array(1_536).fill(0.275))),
      );
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'What did we decide about it?',
    });

    expect(prepared.historicalContext).toContainEqual(
      expect.objectContaining({ evidenceForm: 'rollup', tier: 'weekly' }),
    );
    database.close();
  });

  it('deduplicates shared lineage while preserving disagreement', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const repeatedId = recordEvent(conversation, {
      content: 'Marigold ships Friday.',
      messageId: '52345678901234650',
      occurredAt: now - 3_000,
      recentUntil: now - 1,
    });
    indexSource(database, repeatedId, 'Marigold ships Friday.');
    insertDocument(database, {
      eventIds: [repeatedId],
      id: 1,
      periodEnd: now - 2_000,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'Marigold ships Friday.',
      tier: 'hourly',
    });
    insertDocument(database, {
      eventIds: [repeatedId],
      id: 2,
      periodEnd: now - 1_000,
      periodStart: now - 24 * 60 * 60 * 1_000,
      summary: 'Marigold ships Friday.',
      tier: 'daily',
    });
    for (const [index, summary] of [
      'Avery said Marigold moved to Monday.',
      'Blake said Marigold still ships Friday.',
    ].entries()) {
      const eventId = recordEvent(conversation, {
        content: summary,
        messageId: String(52345678901234651n + BigInt(index)),
        occurredAt: now - (index + 1) * 1_000,
        recentUntil: now - 1,
      });
      insertDocument(database, {
        eventIds: [eventId],
        id: index + 3,
        periodEnd: now,
        periodStart: now - 7 * 24 * 60 * 60 * 1_000,
        summary,
        tier: 'weekly',
      });
    }
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({
      now,
      prompt: 'Marigold ships',
    });

    const statements = prepared.historicalContext.map((context) =>
      context.evidenceForm === 'source' ? context.text : context.summary,
    );
    expect(statements[0]).toBe('Marigold ships Friday.');
    expect(new Set(statements.slice(1))).toEqual(
      new Set([
        'Avery said Marigold moved to Monday.',
        'Blake said Marigold still ships Friday.',
      ]),
    );
    database.close();
  });

  it('falls back to recent and durable context when history is degraded', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    memoryStore.applyMemory({
      canonicalText: 'Marigold is an accepted project.',
      confidence: 0.99,
      embedding: queryVector,
      kind: 'fact',
      provenance: {},
      sourceEventId: null,
      timestamp: now - 1,
    });
    recordEvent(conversation, {
      content: 'Recent context remains available.',
      messageId: '52345678901234660',
      occurredAt: now - 1_000,
      recentUntil: now + 60_000,
    });
    database.exec('drop table context_document_vectors');
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0.001 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });

    const prepared = await assembler.assemble({ now, prompt: 'Marigold' });

    expect(prepared).toMatchObject({
      degraded: true,
      historicalContext: [],
      memories: ['Marigold is an accepted project.'],
      recentConversation: [
        expect.objectContaining({
          content: 'Recent context remains available.',
        }),
      ],
    });
    database.close();
  });
});

function recordEvent(
  conversation: ConversationStore,
  input: {
    readonly content: string;
    readonly messageId: string;
    readonly occurredAt: number;
    readonly recentUntil: number;
  },
): number {
  return conversation.record({
    channelId,
    content: input.content,
    discordMessageId: input.messageId,
    guildId,
    medium: 'text',
    occurredAt: input.occurredAt,
    platformEventId: input.messageId,
    recentUntil: input.recentUntil,
    requestId: input.messageId,
    retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
    role: 'human',
    speakerId,
    speakerName: 'President Test',
  });
}

function indexSource(
  database: ReturnType<typeof openChiefDatabase>,
  eventId: number,
  content: string,
): void {
  database
    .prepare(
      'insert into conversation_event_fts (rowid, content) values (?, ?)',
    )
    .run(eventId, content);
}

function insertDocument(
  database: ReturnType<typeof openChiefDatabase>,
  input: {
    readonly eventIds: readonly number[];
    readonly id: number;
    readonly periodEnd: number | null;
    readonly periodStart: number;
    readonly summary: string;
    readonly tier: ContextTier;
  },
): void {
  database
    .prepare(
      `insert into context_documents
         (id, document_key, tier, period_start, period_end, timezone,
          topic_key, topic_label, revision, completeness, state,
          content_state, content_state_reason, summary, confidence,
          retention_deadline, created_at, updated_at, is_internal)
       values (?, ?, ?, ?, ?, 'America/New_York', null, null, 1, 'final',
               'active', 'available', 'retained', ?, 0.9, null, ?, ?, 0)`,
    )
    .run(
      input.id,
      `test:${input.tier}:${String(input.id)}`,
      input.tier,
      input.periodStart,
      input.periodEnd,
      input.summary,
      now,
      now,
    );
  const insertLineage = database.prepare(
    'insert into context_document_events (document_id, event_id) values (?, ?)',
  );
  for (const eventId of input.eventIds) insertLineage.run(input.id, eventId);
  database
    .prepare('insert into context_document_fts (rowid, content) values (?, ?)')
    .run(input.id, input.summary);
  database
    .prepare(
      'insert into context_document_vectors (document_id, embedding) values (?, ?)',
    )
    .run(BigInt(input.id), JSON.stringify(Array.from(queryVector)));
}
