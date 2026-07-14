import { describe, expect, it } from 'vitest';

import {
  countNormalizedMatches,
  createConversationQualityGrader,
  extractDiscordProvenanceIds,
  passesPinnedCorpus,
  summarizePinnedCorpus,
} from '../../scripts/conversation-quality-grades.js';

describe('conversation quality paid grades', () => {
  it('enforces the exact activation thresholds and safety invariants', () => {
    const passing = summarizePinnedCorpus({
      count: 40,
      evaluatedAt: '2026-07-14T16:00:00.000Z',
      evaluatorModel: 'grader-model',
      textModel: 'answer-model',
      totals: {
        historyClassification: 32.4,
        historyClassificationCases: 36,
        memoryClassification: 3.6,
        memoryClassificationCases: 4,
        crossTierRetrievalRelevance: 35,
        forbiddenClaimHits: 0,
        invalidProvenanceIds: 0,
        returnedProvenanceIds: 40,
        requestedSourceLinkCases: 4,
        requestedSourceLinkPasses: 4,
        rollupFaithfulness: 34,
        supportedClaimPrecision: 36,
        suppressedSourceLeaks: 0,
      },
    });

    expect(passing).toMatchObject({
      historyClassificationAccuracy: 0.9,
      macroClassificationAccuracy: 0.9,
      memoryClassificationAccuracy: 0.9,
      provenanceIdValidity: 1,
      requestedSourceLinkRecall: 1,
      supportedClaimPrecision: 0.9,
    });
    expect(passesPinnedCorpus(passing)).toBe(true);
    expect(
      passesPinnedCorpus({ ...passing, supportedClaimPrecision: 0.899 }),
    ).toBe(false);
    expect(
      passesPinnedCorpus({
        ...passing,
        historyClassificationAccuracy: 0.899,
        macroClassificationAccuracy: 0.8995,
      }),
    ).toBe(false);
    expect(
      passesPinnedCorpus({
        ...passing,
        macroClassificationAccuracy: 0.8995,
        memoryClassificationAccuracy: 0.899,
      }),
    ).toBe(false);
    expect(passesPinnedCorpus({ ...passing, forbiddenClaimHits: 1 })).toBe(
      false,
    );
    expect(passesPinnedCorpus({ ...passing, suppressedSourceLeaks: 1 })).toBe(
      false,
    );
    expect(passesPinnedCorpus({ ...passing, provenanceIdValidity: 0.99 })).toBe(
      false,
    );
    expect(
      passesPinnedCorpus({ ...passing, requestedSourceLinkRecall: 0.75 }),
    ).toBe(false);
  });

  it('extracts only Discord message provenance IDs', () => {
    expect(
      extractDiscordProvenanceIds(
        'See https://discord.com/channels/32345678901234567/22345678901234567/62345678901235041 and https://example.com/62345678901235042',
      ),
    ).toEqual(['62345678901235041']);
  });

  it('matches forbidden claims and leak markers case-insensitively', () => {
    expect(
      countNormalizedMatches(
        'The QUEUE IS the bottleneck; leaked MICA-HIDDEN.',
        ['The queue is the bottleneck', 'mica-hidden', 'not present'],
      ),
    ).toBe(2);
  });

  it('uses a dedicated structured grader behind an injected runner', async () => {
    let instructions = '';
    let suppliedPrompt = '';
    const runAgent = (
      agent: unknown,
      prompt: string,
      options: { readonly maxTurns: number; readonly signal: AbortSignal },
    ) => {
      instructions = String(
        (agent as { readonly instructions?: unknown }).instructions,
      );
      suppliedPrompt = prompt;
      expect(options.maxTurns).toBe(1);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({
        finalOutput: {
          classification: 1,
          crossTierRetrievalRelevance: 0.9,
          rationale: 'The candidate preserves the evidence boundary.',
          rollupFaithfulness: 0.8,
          supportedClaimPrecision: 0.95,
        },
        state: { usage: { inputTokens: 12, outputTokens: 8 } },
      });
    };
    const grader = createConversationQualityGrader({
      apiKey: 'test-key',
      model: 'grader-model',
      runAgent,
    });
    const result = await grader({
      candidateAnswer: 'The group discussed a possible Tuesday launch.',
      expectedClassification: 'history',
      expectedRetrievalTier: 'weekly',
      forbiddenClaims: ['Tuesday is confirmed'],
      requiredClaims: ['possible Tuesday launch'],
      suppliedContext: [{ evidenceForm: 'rollup', tier: 'weekly' }],
    });

    expect(instructions).toContain('independent conversation-quality grader');
    expect(instructions).not.toContain('private group of friends');
    expect(JSON.parse(suppliedPrompt)).toMatchObject({
      candidateAnswer: 'The group discussed a possible Tuesday launch.',
      expectedClassification: 'history',
    });
    expect(result).toEqual({
      grades: {
        classification: 1,
        crossTierRetrievalRelevance: 0.9,
        rationale: 'The candidate preserves the evidence boundary.',
        rollupFaithfulness: 0.8,
        supportedClaimPrecision: 0.95,
      },
      inputTokens: 12,
      outputTokens: 8,
    });
  });

  it('rejects missing structured grader output', async () => {
    const grader = createConversationQualityGrader({
      apiKey: 'test-key',
      model: 'grader-model',
      runAgent: () =>
        Promise.resolve({
          finalOutput: undefined,
          state: { usage: { inputTokens: 1, outputTokens: 0 } },
        }),
    });

    await expect(
      grader({
        candidateAnswer: 'answer',
        expectedClassification: 'memory',
        expectedRetrievalTier: 'memory',
        forbiddenClaims: [],
        requiredClaims: ['answer'],
        suppliedContext: [],
      }),
    ).rejects.toThrow(
      'conversation quality grader returned no structured output',
    );
  });

  it('rejects invalid structured grader output', async () => {
    const grader = createConversationQualityGrader({
      apiKey: 'test-key',
      model: 'grader-model',
      runAgent: () =>
        Promise.resolve({
          finalOutput: {
            classification: 2,
            crossTierRetrievalRelevance: 1,
            rationale: 'invalid',
            rollupFaithfulness: 1,
            supportedClaimPrecision: 1,
          } as never,
          state: { usage: { inputTokens: 1, outputTokens: 1 } },
        }),
    });

    await expect(
      grader({
        candidateAnswer: 'answer',
        expectedClassification: 'history',
        expectedRetrievalTier: 'source',
        forbiddenClaims: [],
        requiredClaims: ['answer'],
        suppliedContext: [],
      }),
    ).rejects.toThrow();
  });
});
