import { describe, expect, it, vi } from 'vitest';

import { ContextAssembler } from '../../src/context/context-assembler.js';
import type { ContextTier } from '../../src/context/context-types.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const now = Date.parse('2026-07-14T16:00:00Z');

describe('context retrieval replay', () => {
  it('replays every horizon, provenance mode, conflict, and empty index', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const sourceId = recordEvent(
      conversation,
      'SourceBeacon settled on Friday.',
      '52345678901234800',
    );
    indexSource(database, sourceId, 'SourceBeacon settled on Friday.');

    const hourlyId = recordEvent(
      conversation,
      'Hourly lineage.',
      '52345678901234801',
    );
    insertDocument(database, {
      embedding: replayVector(1),
      eventIds: [hourlyId],
      id: 1,
      periodEnd: now - 1_000,
      periodStart: now - 60 * 60 * 1_000,
      summary: 'HourlyBeacon captured the immediate release discussion.',
      tier: 'hourly',
    });

    const dailyId = recordEvent(
      conversation,
      'Daily lineage.',
      '52345678901234802',
    );
    database
      .prepare(
        `update conversation_events
         set content = '', content_state = 'scrubbed',
             content_state_reason = 'retention-expired'
         where id = ?`,
      )
      .run(dailyId);
    insertDocument(database, {
      embedding: replayVector(2),
      eventIds: [dailyId],
      id: 2,
      periodEnd: now - 1_000,
      periodStart: now - 24 * 60 * 60 * 1_000,
      summary: 'DailyBeacon summarized an expired discussion.',
      tier: 'daily',
    });

    for (const [index, summary] of [
      'Avery said ConflictBeacon moved to Monday.',
      'Blake said ConflictBeacon remained Friday.',
    ].entries()) {
      const eventId = recordEvent(
        conversation,
        summary,
        String(52345678901234803n + BigInt(index)),
      );
      insertDocument(database, {
        embedding: replayVector(3),
        eventIds: [eventId],
        id: 3 + index,
        periodEnd: now,
        periodStart: now - 7 * 24 * 60 * 60 * 1_000,
        summary,
        tier: 'weekly',
      });
    }

    const longTermId = recordEvent(
      conversation,
      'Long-term lineage.',
      '52345678901234805',
    );
    insertDocument(database, {
      embedding: replayVector(4),
      eventIds: [longTermId],
      id: 5,
      periodEnd: null,
      periodStart: now - 90 * 24 * 60 * 60 * 1_000,
      summary: 'LongBeacon tracked the project evolution.',
      tier: 'long-term',
    });

    const repeatedId = recordEvent(
      conversation,
      'DedupBeacon ships Friday.',
      '52345678901234806',
    );
    indexSource(database, repeatedId, 'DedupBeacon ships Friday.');
    for (const [index, tier] of (['hourly', 'daily'] as const).entries()) {
      insertDocument(database, {
        embedding: replayVector(5),
        eventIds: [repeatedId],
        id: 6 + index,
        periodEnd: now,
        periodStart: now - (index + 1) * 60 * 60 * 1_000,
        summary: 'DedupBeacon ships Friday.',
        tier,
      });
    }

    const vectors = new Map<string, Float32Array>([
      ['HourlyBeacon', replayVector(1)],
      ['DailyBeacon', replayVector(2)],
      ['ConflictBeacon', replayVector(3)],
      ['LongBeacon', replayVector(4)],
      ['DedupBeacon', replayVector(5)],
    ]);
    const embed = vi.fn((prompt: string) =>
      Promise.resolve({
        embedding:
          [...vectors].find(([marker]) => prompt.includes(marker))?.[1] ??
          replayVector(20),
        usageUsd: 0.001,
      }),
    );
    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed,
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

    const source = await assembler.assemble({
      now,
      prompt: 'Show the SourceBeacon source',
    });
    expect(source.historicalContext).toHaveLength(1);
    const sourceEvidence = source.historicalContext[0];
    expect(sourceEvidence).toMatchObject({
      evidenceForm: 'source',
      sourceLinks: [
        `https://discord.com/channels/${guildId}/${channelId}/52345678901234800`,
      ],
    });
    if (sourceEvidence?.evidenceForm !== 'source') {
      throw new Error('source replay did not return source evidence');
    }
    expect(sourceEvidence.temporalLabel).toContain('Jul 14, 2026');

    for (const [prompt, tier] of [
      ['What was HourlyBeacon?', 'hourly'],
      ['What was DailyBeacon?', 'daily'],
      ['How did LongBeacon evolve?', 'long-term'],
    ] as const) {
      const result = await assembler.assemble({ now, prompt });
      const rollup = result.historicalContext.find(
        (context) => context.evidenceForm === 'rollup' && context.tier === tier,
      );
      expect(rollup).toBeDefined();
      expect(rollup?.temporalLabel.length).toBeGreaterThan(0);
    }

    const daily = await assembler.assemble({
      now,
      prompt: 'What was DailyBeacon?',
    });
    expect(daily.historicalContext).toContainEqual(
      expect.objectContaining({
        provenanceQuality: 'summary-only',
        sourceLinks: [
          `https://discord.com/channels/${guildId}/${channelId}/52345678901234802`,
        ],
        tier: 'daily',
      }),
    );

    const conflict = await assembler.assemble({
      now,
      prompt: 'Resolve ConflictBeacon',
    });
    expect(
      conflict.historicalContext.filter(
        (context) =>
          context.evidenceForm === 'rollup' && context.tier === 'weekly',
      ),
    ).toHaveLength(2);

    const deduplicated = await assembler.assemble({
      now,
      prompt: 'What was DedupBeacon?',
    });
    expect(deduplicated.historicalContext).toEqual([
      expect.objectContaining({ evidenceForm: 'source' }),
    ]);

    const empty = await assembler.assemble({
      now,
      prompt: 'NoIndexedBeacon has no context',
    });
    expect(empty.historicalContext).toEqual([]);
    expect(empty.degraded).toBe(false);
    expect(embed).toHaveBeenCalledTimes(8);
    database.close();
  });
});

function replayVector(index: number): Float32Array {
  const vector = new Float32Array(1_536);
  vector[index] = 1;
  return vector;
}

function recordEvent(
  conversation: ConversationStore,
  content: string,
  messageId: string,
): number {
  return conversation.record({
    channelId,
    content,
    discordMessageId: messageId,
    guildId,
    medium: 'text',
    occurredAt: now - 1_000,
    platformEventId: messageId,
    recentUntil: now - 1,
    requestId: messageId,
    retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
    role: 'human',
    speakerId: '42345678901234567',
    speakerName: 'President Replay',
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
    readonly embedding: Float32Array;
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
      `replay:${input.tier}:${String(input.id)}`,
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
    .run(BigInt(input.id), JSON.stringify(Array.from(input.embedding)));
}
