import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type {
  ChiefAgent,
  ChiefTextRequest,
} from '../../src/agent/chief-agent.js';
import {
  ConversationOrchestrator,
  type NormalizedTextTurn,
} from '../../src/app/conversation-orchestrator.js';
import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ContextAssembler } from '../../src/context/context-assembler.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import { qualifyTextMessage } from '../../src/discord/invocation-policy.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';
import type { ContextTier } from '../../src/context/context-types.js';

interface ReplayTurn {
  readonly content: string;
  readonly id: string;
}

type QualityRetrievalTier = 'source' | ContextTier | 'memory';

interface QualityEvidence {
  readonly contentState?:
    'available' | 'discord-deleted' | 'locally-forgotten' | 'retention-expired';
  readonly lineageProvenanceId?: string;
  readonly lineageText?: string;
  readonly provenanceId: string;
  readonly speakerName?: string;
  readonly text: string;
  readonly tier: QualityRetrievalTier;
}

interface QualityCase {
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
  readonly expectedProvenanceQuality?: 'source-backed' | 'summary-only';
  readonly expectedRetrievalTier: QualityRetrievalTier;
  readonly forbiddenClaims: readonly string[];
  readonly id: string;
  readonly prompt: string;
  readonly requestSourceLinks: boolean;
  readonly requiredClaims: readonly string[];
}

interface QualityFixture {
  readonly cases: readonly QualityCase[];
  readonly replay: readonly ReplayTurn[];
}

const guildId = '32345678901234567';
const channelId = '22345678901234567';
const now = Date.parse('2026-07-14T16:00:00Z');

async function loadFixture(): Promise<QualityFixture> {
  return JSON.parse(
    await readFile(
      new URL('../fixtures/conversation-quality.json', import.meta.url),
      'utf8',
    ),
  ) as QualityFixture;
}

describe('conversation quality replay', () => {
  it('keeps Teddy constraints through the Polk follow-up', async () => {
    const { replay: turns } = await loadFixture();
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const vector = new Float32Array(1_536).fill(0.4);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const requests: ChiefTextRequest[] = [];
    const answerText = vi.fn((request: ChiefTextRequest) => {
      requests.push(request);
      expect(request.historicalContext).toEqual([]);
      if (request.prompt.includes('Give Teddy')) {
        return Promise.resolve({
          citations: [],
          content: 'Oregon, New Mexico, Air Force, Navy, and Syracuse.',
          usageUsd: 0.01,
        });
      }
      if (request.prompt.includes('outcomes')) {
        expect(
          request.recentConversation?.map(({ content }) => content),
        ).toEqual(
          expect.arrayContaining([
            'The presidential debate focused on education and foreign policy.',
            expect.stringContaining('Oregon, New Mexico, Air Force'),
            'No military academies for the final pick.',
          ]),
        );
        return Promise.resolve({
          citations: [],
          content: 'Oregon won, New Mexico improved, and Syracuse rebuilt.',
          usageUsd: 0.01,
        });
      }
      expect(request.recentConversation?.map(({ content }) => content)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Oregon, New Mexico, Air Force'),
          'No military academies for the final pick.',
          expect.stringContaining('New Mexico improved'),
        ]),
      );
      expect(request.memories).toContain(
        'The group does not choose military academies.',
      );
      return Promise.resolve({
        citations: [],
        content: 'New Mexico.',
        usageUsd: 0.01,
      });
    });
    const agent: ChiefAgent = {
      answerText,
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const memory = new MemoryService({
      budget,
      embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'create',
              canonicalText: 'The group does not choose military academies.',
              confidence: 0.99,
              kind: 'preference',
              sensitivity: 'none',
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });
    let now = 100;
    let deliveredId = 62_345_678_901_234_567n;
    const conversation = new ConversationStore(database);
    const orchestrator = new ConversationOrchestrator({
      agent,
      assembler: new ContextAssembler({
        channelId: 'main-text',
        conversation,
        database,
        embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
        guildId: 'presidents',
        memory,
        timeZone: 'America/New_York',
      }),
      budget,
      context: new ChannelContextService({
        channelId: 'main-text',
        conversation,
        database,
        guildId: 'presidents',
        now: () => now,
        timeZone: 'America/New_York',
      }),
      conversation,
      memory,
      now: () => now,
    });
    let finalContent = '';

    for (const replay of turns) {
      const qualification = qualifyTextMessage(
        {
          botUserId: 'chief',
          channelId: 'main-text',
          guildId: 'presidents',
        },
        {
          authorIsBot: false,
          channelId: 'main-text',
          content: replay.content,
          guildId: 'presidents',
          isThread: false,
          webhookId: null,
        },
      );
      if (qualification.kind === 'ignore') continue;
      const base = {
        content: qualification.content,
        occurredAt: now,
        platformSourceId: replay.id,
        requestId: replay.id,
        speakerId: 'president-replay',
        speakerName: 'President Replay',
      };
      const turn: NormalizedTextTurn =
        qualification.kind === 'request'
          ? { ...base, kind: 'request', prompt: qualification.prompt }
          : { ...base, kind: qualification.kind };
      const result = await orchestrator.handleText(turn);
      if (result !== null) {
        finalContent = result.content;
        deliveredId += 1n;
        orchestrator.recordDeliveredReply({
          chunks: [
            { content: result.content, messageId: deliveredId.toString() },
          ],
          logicalResponseId: `response-${replay.id}`,
          replyToMessageId: replay.id,
          requestId: replay.id,
        });
      }
      now += 1;
    }

    expect(finalContent).toBe('New Mexico. Mr. President');
    expect(finalContent).not.toMatch(/Air Force|Navy/u);
    expect(requests).toHaveLength(3);
    database.close();
  });

  it('meets every pinned deterministic quality contract', async () => {
    const { cases } = await loadFixture();
    const requiredCategories = new Set<QualityCase['category']>([
      'conflicting-speakers',
      'correction',
      'expired-source',
      'joke',
      'requested-source-link',
      'repeated-across-tiers',
      'speculation',
      'summary-only',
      'suppressed-source',
      'topic-evolution',
    ]);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map(({ category }) => category))).toEqual(
      requiredCategories,
    );
    expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);

    const metrics = {
      forbiddenClaims: 0,
      invalidProvenanceIds: 0,
      returnedProvenanceIds: 0,
      suppressedSourceLeaks: 0,
    };

    for (const qualityCase of cases) {
      expect(qualityCase.requiredClaims, qualityCase.id).toBeInstanceOf(Array);
      expect(qualityCase.forbiddenClaims, qualityCase.id).toBeInstanceOf(Array);
      expect(
        qualityCase.allowedProvenanceIds.length,
        qualityCase.id,
      ).toBeGreaterThan(0);

      const result = await replayQualityCase(qualityCase);
      for (const claim of qualityCase.requiredClaims) {
        expect(result.returnedText, qualityCase.id).toContain(claim);
      }
      for (const claim of qualityCase.forbiddenClaims) {
        if (result.returnedText.includes(claim)) metrics.forbiddenClaims += 1;
      }
      for (const suppressedText of result.suppressedSourceTexts) {
        if (result.returnedText.includes(suppressedText)) {
          metrics.suppressedSourceLeaks += 1;
        }
      }
      for (const provenanceId of result.returnedProvenanceIds) {
        metrics.returnedProvenanceIds += 1;
        if (!qualityCase.allowedProvenanceIds.includes(provenanceId)) {
          metrics.invalidProvenanceIds += 1;
        }
      }

      expect(result.classification, qualityCase.id).toBe(
        qualityCase.expectedClassification,
      );
      expect(result.retrievalTiers, qualityCase.id).toEqual(
        new Set([qualityCase.expectedRetrievalTier]),
      );
      expect(result.returnedProvenanceIds, qualityCase.id).toEqual(
        new Set(qualityCase.allowedProvenanceIds),
      );
      if (qualityCase.expectedProvenanceQuality !== undefined) {
        expect(result.provenanceQualities, qualityCase.id).toEqual(
          new Set([qualityCase.expectedProvenanceQuality]),
        );
      }
      if (qualityCase.requestSourceLinks) {
        expect(
          result.returnedSourceLinks.length,
          qualityCase.id,
        ).toBeGreaterThan(0);
      }
    }

    expect(metrics.returnedProvenanceIds).toBeGreaterThanOrEqual(cases.length);
    expect(metrics).toMatchObject({
      forbiddenClaims: 0,
      invalidProvenanceIds: 0,
      suppressedSourceLeaks: 0,
    });
  });
});

async function replayQualityCase(qualityCase: QualityCase): Promise<{
  readonly classification: 'history' | 'memory';
  readonly provenanceQualities: ReadonlySet<'source-backed' | 'summary-only'>;
  readonly retrievalTiers: ReadonlySet<QualityRetrievalTier>;
  readonly returnedProvenanceIds: ReadonlySet<string>;
  readonly returnedSourceLinks: readonly string[];
  readonly returnedText: string;
  readonly suppressedSourceTexts: readonly string[];
}> {
  const database = openChiefDatabase(':memory:');
  migrateChiefDatabase(database);
  const conversation = new ConversationStore(database);
  const memoryStore = new SqliteMemoryStore(database);
  const eventIds = new Map<string, number>();
  const memoryIdsByText = new Map<string, string>();
  const vector = new Float32Array(1_536);
  vector[qualityCase.id.length % vector.length] = 1;

  for (const [index, evidence] of qualityCase.evidence.entries()) {
    if (evidence.tier === 'memory') {
      memoryStore.applyMemory({
        canonicalText: evidence.text,
        confidence: 0.99,
        embedding: vector,
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
      eventId = conversation.record({
        channelId,
        content: evidence.lineageText ?? evidence.text,
        discordMessageId: evidence.provenanceId,
        guildId,
        medium: 'text',
        occurredAt: now - 10_000 - index,
        platformEventId: `${qualityCase.id}:${evidence.provenanceId}`,
        recentUntil: now - 1,
        requestId: `${qualityCase.id}:${evidence.provenanceId}`,
        retentionDeadline: now + 30 * 24 * 60 * 60 * 1_000,
        role: 'human',
        speakerId: `speaker-${String(index)}`,
        speakerName: evidence.speakerName ?? 'President Quality',
      });
      eventIds.set(evidence.provenanceId, eventId);
    }

    if (evidence.tier === 'source') {
      database
        .prepare(
          'insert into conversation_event_fts (rowid, content) values (?, ?)',
        )
        .run(eventId, evidence.text);
    } else {
      insertQualityDocument(database, {
        embedding: vector,
        eventId,
        id: index + 1,
        summary: evidence.text,
        tier: evidence.tier,
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

  const assembler = new ContextAssembler({
    channelId,
    conversation,
    database,
    embed: () => Promise.resolve({ embedding: vector, usageUsd: 0 }),
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
    prompt: qualityCase.prompt,
  });
  const historicalText = prepared.historicalContext.map((context) =>
    context.evidenceForm === 'source' ? context.text : context.summary,
  );
  const returnedSourceLinks = prepared.historicalContext.flatMap(
    ({ sourceLinks }) => sourceLinks,
  );
  const returnedProvenanceIds = new Set([
    ...returnedSourceLinks.map((link) => link.slice(link.lastIndexOf('/') + 1)),
    ...prepared.memories.flatMap((memory) => {
      const provenanceId = memoryIdsByText.get(memory);
      return provenanceId === undefined ? [] : [provenanceId];
    }),
  ]);
  const retrievalTiers = new Set<QualityRetrievalTier>([
    ...prepared.historicalContext.map((context) =>
      context.evidenceForm === 'source' ? 'source' : context.tier,
    ),
    ...(prepared.memories.length === 0 ? [] : (['memory'] as const)),
  ]);
  const classification: 'history' | 'memory' =
    prepared.memories.length > 0 && prepared.historicalContext.length === 0
      ? 'memory'
      : 'history';
  const suppressedSourceTexts = qualityCase.evidence.flatMap((evidence) =>
    evidence.contentState !== undefined && evidence.contentState !== 'available'
      ? [evidence.lineageText ?? evidence.text]
      : [],
  );
  const result = {
    classification,
    provenanceQualities: new Set(
      prepared.historicalContext.map(
        ({ provenanceQuality }) => provenanceQuality,
      ),
    ),
    retrievalTiers,
    returnedProvenanceIds,
    returnedSourceLinks,
    returnedText: [...historicalText, ...prepared.memories].join('\n'),
    suppressedSourceTexts,
  };
  database.close();
  return result;
}

function insertQualityDocument(
  database: ReturnType<typeof openChiefDatabase>,
  input: {
    readonly embedding: Float32Array;
    readonly eventId: number;
    readonly id: number;
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
               'active', 'available', 'retained', ?, 0.95, null, ?, ?, 0)`,
    )
    .run(
      input.id,
      `quality:${input.tier}:${String(input.id)}`,
      input.tier,
      now - 60 * 60 * 1_000,
      input.tier === 'long-term' ? null : now - 1,
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
