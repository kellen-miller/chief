import { readFile } from 'node:fs/promises';

import { ContextAssembler } from '../src/context/context-assembler.js';
import type {
  ContextTier,
  PreparedContext,
} from '../src/context/context-types.js';
import { serializeContextPayload } from '../src/context/context-payload.js';
import { ConversationStore } from '../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../src/memory/database.js';
import { MemoryService } from '../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../src/memory/memory-store.js';
import { UsageBudget } from '../src/usage/usage-budget.js';

export type QualityRetrievalTier = 'source' | ContextTier | 'memory';

export interface QualityEvidence {
  readonly contentState?:
    'available' | 'discord-deleted' | 'locally-forgotten' | 'retention-expired';
  readonly lineageProvenanceId?: string;
  readonly lineageText?: string;
  readonly provenanceId: string;
  readonly speakerName?: string;
  readonly text: string;
  readonly tier: QualityRetrievalTier;
  readonly topicLabel?: string;
}

export interface QualityCase {
  readonly allowedProvenanceIds: readonly string[];
  readonly category:
    | 'conflicting-speakers'
    | 'correction'
    | 'expired-source'
    | 'joke'
    | 'requested-source-link'
    | 'repeated-across-tiers'
    | 'speculation'
    | 'summary-only'
    | 'suppressed-source'
    | 'topic-evolution';
  readonly evidence: readonly QualityEvidence[];
  readonly expectedClassification: 'history' | 'memory';
  readonly expectedFirstClaim?: string;
  readonly expectedProvenanceQuality?: 'source-backed' | 'summary-only';
  readonly expectedRetrievalTier: QualityRetrievalTier;
  readonly forbiddenClaims: readonly string[];
  readonly id: string;
  readonly leakageMarkers?: readonly string[];
  readonly prompt: string;
  readonly requestSourceLinks: boolean;
  readonly requiredClaims: readonly string[];
}

export interface ReplayTurn {
  readonly content: string;
  readonly id: string;
}

export interface QualityFixture {
  readonly cases: readonly QualityCase[];
  readonly replay: readonly ReplayTurn[];
}

export interface QualityReplayResult {
  readonly classification: 'history' | 'memory';
  readonly distractors: {
    readonly crossTierFiltered: boolean;
    readonly memoryPresent: boolean;
  };
  readonly prepared: PreparedContext;
  readonly productionPayload: ReturnType<typeof serializeContextPayload>;
  readonly provenanceQualities: ReadonlySet<'source-backed' | 'summary-only'>;
  readonly retrievalTiers: ReadonlySet<QualityRetrievalTier>;
  readonly returnedProvenanceIds: ReadonlySet<string>;
  readonly returnedSourceLinks: readonly string[];
  readonly selectedText: readonly string[];
  readonly temporalLabels: readonly string[];
}

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const now = Date.parse('2026-07-14T16:00:00Z');

export async function loadConversationQualityFixture(): Promise<QualityFixture> {
  return JSON.parse(
    await readFile(
      new URL('../test/fixtures/conversation-quality.json', import.meta.url),
      'utf8',
    ),
  ) as QualityFixture;
}

export async function replayConversationQualityCase(
  qualityCase: QualityCase,
): Promise<QualityReplayResult> {
  const database = openChiefDatabase(':memory:');
  try {
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const memoryStore = new SqliteMemoryStore(database);
    const eventIds = new Map<string, number>();
    const memoryIdsByText = new Map<string, string>();
    const queryVector = deterministicVector(`${qualityCase.id}:relevant`);

    for (const [index, evidence] of qualityCase.evidence.entries()) {
      if (evidence.tier === 'memory') {
        memoryStore.applyMemory({
          canonicalText: evidence.text,
          confidence: 0.99,
          embedding: relatedVector(queryVector, index),
          kind: 'fact',
          provenance: { qualityFixtureId: evidence.provenanceId },
          sourceEventId: null,
          timestamp: now - index,
        });
        memoryIdsByText.set(evidence.text, evidence.provenanceId);
        continue;
      }

      let eventId =
        evidence.lineageProvenanceId === undefined
          ? undefined
          : eventIds.get(evidence.lineageProvenanceId);
      if (eventId === undefined) {
        eventId = recordQualityEvent(conversation, {
          index,
          messageId: evidence.provenanceId,
          platformEventId: `${qualityCase.id}:${evidence.provenanceId}`,
          speakerName: evidence.speakerName ?? 'President Quality',
          text: evidence.lineageText ?? evidence.text,
        });
        eventIds.set(evidence.provenanceId, eventId);
      }

      if (evidence.tier === 'source') {
        indexSource(database, eventId, evidence.text);
      } else {
        insertQualityDocument(database, {
          embedding: relatedVector(queryVector, index),
          eventId,
          id: index + 1,
          periodOffset: index,
          summary: evidence.text,
          tier: evidence.tier,
          ...(evidence.topicLabel === undefined
            ? {}
            : { topicLabel: evidence.topicLabel }),
        });
      }
      if (
        evidence.contentState !== undefined &&
        evidence.contentState !== 'available'
      ) {
        database
          .prepare(
            `update conversation_events
             set content = '', content_state = 'scrubbed',
                 content_state_reason = ? where id = ?`,
          )
          .run(evidence.contentState, eventId);
      }
    }

    seedCrossTierDistractor(database, conversation, qualityCase, queryVector);
    seedActiveMemoryDistractor(memoryStore, qualityCase);

    const assembler = new ContextAssembler({
      channelId,
      conversation,
      database,
      embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0 }),
      guildId,
      memory: new MemoryService({
        budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
        embed: () => Promise.resolve({ embedding: queryVector, usageUsd: 0 }),
        estimateUsd: 0.1,
        extract: () =>
          Promise.resolve({
            inputTokens: 0,
            outputTokens: 0,
            proposals: [],
            usageUsd: 0,
          }),
        store: memoryStore,
      }),
      timeZone: 'America/New_York',
    });
    const prepared = await assembler.assemble({
      now,
      prompt: qualityCase.prompt,
    });
    const historicalText = prepared.historicalContext.map((context) =>
      context.evidenceForm === 'source' ? context.text : context.summary,
    );
    const targetTexts = new Set(qualityCase.evidence.map(({ text }) => text));
    const targetHistorical = prepared.historicalContext.filter((context) =>
      targetTexts.has(
        context.evidenceForm === 'source' ? context.text : context.summary,
      ),
    );
    const targetMemories = prepared.memories.filter((memory) =>
      targetTexts.has(memory),
    );
    const returnedSourceLinks = prepared.historicalContext.flatMap(
      ({ sourceLinks }) => sourceLinks,
    );
    const classification = classifyTargetSelection(
      targetHistorical.length,
      targetMemories.length,
    );
    return {
      classification,
      distractors: {
        crossTierFiltered: !historicalText.some((text) =>
          text.includes('UnrelatedDistractor'),
        ),
        memoryPresent: prepared.memories.some((memory) =>
          memory.includes('UnrelatedMemoryDistractor'),
        ),
      },
      prepared,
      productionPayload: serializeContextPayload({
        historicalContext: prepared.historicalContext,
        memories: prepared.memories,
        recentConversation: prepared.recentConversation,
        userRequest: qualityCase.prompt,
      }),
      provenanceQualities: new Set(
        prepared.historicalContext.map(
          ({ provenanceQuality }) => provenanceQuality,
        ),
      ),
      retrievalTiers: new Set<QualityRetrievalTier>([
        ...targetHistorical.map((context) =>
          context.evidenceForm === 'source' ? 'source' : context.tier,
        ),
        ...(targetMemories.length === 0 ? [] : (['memory'] as const)),
      ]),
      returnedProvenanceIds: new Set([
        ...returnedSourceLinks.map((link) =>
          link.slice(link.lastIndexOf('/') + 1),
        ),
        ...prepared.memories.flatMap((memory) => {
          const provenanceId = memoryIdsByText.get(memory);
          return provenanceId === undefined ? [] : [provenanceId];
        }),
      ]),
      returnedSourceLinks,
      selectedText: [
        ...targetHistorical.map((context) =>
          context.evidenceForm === 'source' ? context.text : context.summary,
        ),
        ...targetMemories,
      ],
      temporalLabels: prepared.historicalContext.map(
        ({ temporalLabel }) => temporalLabel,
      ),
    };
  } finally {
    database.close();
  }
}

function classifyTargetSelection(
  historicalCount: number,
  memoryCount: number,
): 'history' | 'memory' {
  if (historicalCount > 0 && memoryCount === 0) return 'history';
  if (memoryCount > 0 && historicalCount === 0) return 'memory';
  throw new Error('quality target was missing or crossed classification');
}

function seedCrossTierDistractor(
  database: ReturnType<typeof openChiefDatabase>,
  conversation: ConversationStore,
  qualityCase: QualityCase,
  queryVector: Float32Array,
): void {
  const eventId = recordQualityEvent(conversation, {
    index: 900,
    messageId: '72345678901239998',
    platformEventId: `${qualityCase.id}:cross-tier-distractor`,
    speakerName: 'President Distractor',
    text: 'UnrelatedDistractor discussed the lunch menu.',
  });
  insertQualityDocument(database, {
    embedding: orthogonalVector(queryVector),
    eventId,
    id: 9_998,
    periodOffset: 900,
    summary: 'UnrelatedDistractor summarized the lunch menu.',
    tier: qualityCase.expectedRetrievalTier === 'daily' ? 'weekly' : 'daily',
  });
}

function seedActiveMemoryDistractor(
  memoryStore: SqliteMemoryStore,
  qualityCase: QualityCase,
): void {
  memoryStore.applyMemory({
    canonicalText: 'UnrelatedMemoryDistractor prefers a pineapple menu.',
    confidence: 0.99,
    embedding: deterministicVector(`${qualityCase.id}:memory-distractor`),
    kind: 'preference',
    provenance: { qualityFixtureId: 'memory-distractor' },
    sourceEventId: null,
    timestamp: now - 100_000,
  });
}

function recordQualityEvent(
  conversation: ConversationStore,
  input: {
    readonly index: number;
    readonly messageId: string;
    readonly platformEventId: string;
    readonly speakerName: string;
    readonly text: string;
  },
): number {
  return conversation.record({
    channelId,
    content: input.text,
    discordMessageId: input.messageId,
    guildId,
    medium: 'text',
    occurredAt: now - 10_000 - input.index * 1_000,
    platformEventId: input.platformEventId,
    recentUntil: now - 1,
    requestId: input.platformEventId,
    retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
    role: 'human',
    speakerId: `speaker-${String(input.index)}`,
    speakerName: input.speakerName,
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

function insertQualityDocument(
  database: ReturnType<typeof openChiefDatabase>,
  input: {
    readonly embedding: Float32Array;
    readonly eventId: number;
    readonly id: number;
    readonly periodOffset: number;
    readonly summary: string;
    readonly tier: ContextTier;
    readonly topicLabel?: string;
  },
): void {
  const intervalMs =
    input.tier === 'hourly'
      ? 60 * 60 * 1_000
      : input.tier === 'daily'
        ? 24 * 60 * 60 * 1_000
        : input.tier === 'weekly'
          ? 7 * 24 * 60 * 60 * 1_000
          : 30 * 24 * 60 * 60 * 1_000;
  const periodEnd = now - input.periodOffset * intervalMs;
  database
    .prepare(
      `insert into context_documents
         (id, document_key, tier, period_start, period_end, timezone,
          topic_key, topic_label, revision, completeness, state,
          content_state, content_state_reason, summary, confidence,
          retention_deadline, created_at, updated_at, is_internal)
       values (?, ?, ?, ?, ?, 'America/New_York', ?, ?, 1, 'final',
               'active', 'available', 'retained', ?, 0.95, null, ?, ?, 0)`,
    )
    .run(
      input.id,
      `quality:${input.tier}:${String(input.id)}`,
      input.tier,
      periodEnd - intervalMs,
      input.tier === 'long-term' ? null : periodEnd,
      input.topicLabel === undefined ? null : `topic:${input.topicLabel}`,
      input.topicLabel ?? null,
      input.summary,
      now,
      now,
    );
  database
    .prepare(
      'insert into context_document_events (document_id, event_id) values (?, ?)',
    )
    .run(input.id, input.eventId);
  database
    .prepare('insert into context_document_fts (rowid, content) values (?, ?)')
    .run(input.id, input.summary);
  database
    .prepare(
      'insert into context_document_vectors (document_id, embedding) values (?, ?)',
    )
    .run(BigInt(input.id), JSON.stringify(Array.from(input.embedding)));
}

function deterministicVector(key: string): Float32Array {
  let hash = 2_166_136_261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const vector = new Float32Array(1_536);
  vector[hash % vector.length] = 1;
  return vector;
}

function orthogonalVector(vector: Float32Array): Float32Array {
  const activeIndex = vector.findIndex((value) => value !== 0);
  const result = new Float32Array(vector.length);
  result[(activeIndex + 1) % result.length] = 1;
  return result;
}

function relatedVector(vector: Float32Array, index: number): Float32Array {
  const activeIndex = vector.findIndex((value) => value !== 0);
  const result = vector.slice();
  result[(activeIndex + index + 1) % result.length] = 0.05 * (index + 1);
  return result;
}
