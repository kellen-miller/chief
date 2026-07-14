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
import {
  conversationQualitySafetySurface,
  loadConversationQualityFixture,
  type QualityCase,
  replayConversationQualityCase,
} from '../../scripts/conversation-quality-corpus.js';
import { countNormalizedMatches } from '../../scripts/conversation-quality-grades.js';

describe('conversation quality replay', () => {
  it('keeps Teddy constraints through the Polk follow-up', async () => {
    const { replay: turns } = await loadConversationQualityFixture();
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
    const { cases } = await loadConversationQualityFixture();
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
    expect(
      cases.filter(
        ({ expectedClassification }) => expectedClassification === 'memory',
      ).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      cases.filter(
        ({ expectedClassification }) => expectedClassification === 'history',
      ).length,
    ).toBeGreaterThanOrEqual(4);

    const metrics = {
      forbiddenClaims: 0,
      invalidProvenanceIds: 0,
      requestedSourceLinkCases: 0,
      requestedSourceLinkPasses: 0,
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
      if (
        qualityCase.evidence.some(
          ({ contentState }) =>
            contentState !== undefined && contentState !== 'available',
        )
      ) {
        expect(
          qualityCase.leakageMarkers?.length ?? 0,
          qualityCase.id,
        ).toBeGreaterThan(0);
      }

      const result = await replayConversationQualityCase(qualityCase);
      const deterministicAnswer = renderDeterministicAnswer(
        result.classification,
        result.selectedText,
        qualityCase.requestSourceLinks,
        result.returnedSourceLinks,
      );
      for (const claim of qualityCase.requiredClaims) {
        expect(deterministicAnswer, qualityCase.id).toContain(claim);
      }
      const safetySurface = conversationQualitySafetySurface(result);
      metrics.forbiddenClaims += countNormalizedMatches(
        safetySurface,
        qualityCase.forbiddenClaims,
      );
      metrics.suppressedSourceLeaks += countNormalizedMatches(
        safetySurface,
        qualityCase.leakageMarkers ?? [],
      );
      for (const provenanceId of result.returnedProvenanceIds) {
        metrics.returnedProvenanceIds += 1;
        if (!qualityCase.allowedProvenanceIds.includes(provenanceId)) {
          metrics.invalidProvenanceIds += 1;
        }
      }

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
      expect(result.productionPayload, qualityCase.id).toMatchObject({
        dataClassification: 'untrusted_user_supplied_context',
        userRequest: qualityCase.prompt,
      });
      expect(result.classification, qualityCase.id).toBe(
        qualityCase.expectedClassification,
      );
      expect(result.distractors, qualityCase.id).toEqual({
        crossTierFiltered: true,
        memoryPresent: true,
      });
      if (result.classification === 'memory') {
        expect(
          result.productionPayload.communalMemory,
          qualityCase.id,
        ).not.toHaveLength(0);
        expect(
          result.productionPayload.historicalContext,
          qualityCase.id,
        ).toEqual([]);
        for (const claim of qualityCase.requiredClaims) {
          expect(
            JSON.stringify(result.productionPayload.communalMemory),
            qualityCase.id,
          ).toContain(claim);
        }
        expect(deterministicAnswer, qualityCase.id).toMatch(
          /^Accepted communal memory:/u,
        );
      } else {
        expect(
          result.productionPayload.historicalContext,
          qualityCase.id,
        ).not.toHaveLength(0);
        for (const claim of qualityCase.requiredClaims) {
          expect(
            JSON.stringify(result.productionPayload.historicalContext),
            qualityCase.id,
          ).toContain(claim);
          expect(
            JSON.stringify(result.productionPayload.communalMemory),
            qualityCase.id,
          ).not.toContain(claim);
        }
        expect(deterministicAnswer, qualityCase.id).toMatch(
          /^The group discussed:/u,
        );
      }
      if (qualityCase.category === 'joke') {
        expect(result.classification, qualityCase.id).toBe('history');
        expect(deterministicAnswer, qualityCase.id).toMatch(/joke/iu);
      }
      if (qualityCase.category === 'speculation') {
        expect(result.classification, qualityCase.id).toBe('history');
        expect(deterministicAnswer, qualityCase.id).toMatch(
          /speculation|guessed|wondered|proposed|might|could/iu,
        );
      }
      if (qualityCase.expectedFirstClaim !== undefined) {
        expect(result.selectedText[0], qualityCase.id).toContain(
          qualityCase.expectedFirstClaim,
        );
      }
      if (
        qualityCase.category === 'topic-evolution' &&
        qualityCase.expectedClassification === 'history'
      ) {
        expect(
          new Set(result.temporalLabels).size,
          qualityCase.id,
        ).toBeGreaterThanOrEqual(2);
      }
      if (qualityCase.requestSourceLinks) {
        metrics.requestedSourceLinkCases += 1;
        expect(
          result.returnedSourceLinks.length,
          qualityCase.id,
        ).toBeGreaterThan(0);
        const recalledEveryLink = result.returnedSourceLinks.every((link) =>
          deterministicAnswer.includes(link),
        );
        if (recalledEveryLink) metrics.requestedSourceLinkPasses += 1;
        expect(recalledEveryLink, qualityCase.id).toBe(true);
      }
    }

    expect(metrics.returnedProvenanceIds).toBeGreaterThanOrEqual(cases.length);
    expect(metrics).toMatchObject({
      forbiddenClaims: 0,
      invalidProvenanceIds: 0,
      requestedSourceLinkCases: 4,
      requestedSourceLinkPasses: 4,
      suppressedSourceLeaks: 0,
    });
  });

  it('detects a leak returned only through a non-target distractor', async () => {
    const fixture = await loadConversationQualityFixture();
    const baseCase = fixture.cases[0];
    if (baseCase === undefined) throw new Error('quality fixture is empty');
    const qualityCase = {
      ...baseCase,
      distractorLeakageMarker: 'LeAk-OnLy-ToKeN',
    } as QualityCase;

    const result = await replayConversationQualityCase(qualityCase);

    expect(result.selectedText.join(' ')).not.toMatch(/leak.only.token/iu);
    expect(
      countNormalizedMatches(conversationQualitySafetySurface(result), [
        'leak only token',
      ]),
    ).toBe(1);
  });
});

function renderDeterministicAnswer(
  classification: 'history' | 'memory',
  selectedText: readonly string[],
  requestSourceLinks: boolean,
  sourceLinks: readonly string[],
): string {
  const classificationLabel =
    classification === 'memory'
      ? 'Accepted communal memory:'
      : 'The group discussed:';
  const links = requestSourceLinks ? ` Sources: ${sourceLinks.join(' ')}` : '';
  return `${classificationLabel} ${selectedText.join(' ')}${links}`;
}
