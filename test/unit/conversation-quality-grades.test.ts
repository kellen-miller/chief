import { describe, expect, it } from 'vitest';

import {
  extractDiscordProvenanceIds,
  parsePaidGrades,
  passesPinnedCorpus,
  summarizePinnedCorpus,
} from '../../scripts/conversation-quality-grades.js';

describe('conversation quality paid grades', () => {
  it('parses one bounded JSON grade and rejects malformed output', () => {
    expect(
      parsePaidGrades(
        '```json\n{"classification":0.9,"crossTierRetrievalRelevance":0.8,"rationale":"supported","rollupFaithfulness":1,"supportedClaimPrecision":0.95}\n```',
      ),
    ).toEqual({
      classification: 0.9,
      crossTierRetrievalRelevance: 0.8,
      rationale: 'supported',
      rollupFaithfulness: 1,
      supportedClaimPrecision: 0.95,
    });
    expect(() => parsePaidGrades('not json')).toThrow(
      'paid grader returned no JSON object',
    );
    expect(() =>
      parsePaidGrades(
        '{"classification":1.1,"crossTierRetrievalRelevance":1,"rationale":"bad","rollupFaithfulness":1,"supportedClaimPrecision":1}',
      ),
    ).toThrow();
  });

  it('enforces the exact activation thresholds and safety invariants', () => {
    const passing = summarizePinnedCorpus({
      count: 40,
      evaluatedAt: '2026-07-14T16:00:00.000Z',
      evaluatorModel: 'grader-model',
      textModel: 'answer-model',
      totals: {
        classification: 36,
        crossTierRetrievalRelevance: 35,
        forbiddenClaimHits: 0,
        invalidProvenanceIds: 0,
        returnedProvenanceIds: 40,
        rollupFaithfulness: 34,
        supportedClaimPrecision: 36,
        suppressedSourceLeaks: 0,
      },
    });

    expect(passing).toMatchObject({
      classificationAccuracy: 0.9,
      provenanceIdValidity: 1,
      supportedClaimPrecision: 0.9,
    });
    expect(passesPinnedCorpus(passing)).toBe(true);
    expect(
      passesPinnedCorpus({ ...passing, supportedClaimPrecision: 0.899 }),
    ).toBe(false);
    expect(
      passesPinnedCorpus({ ...passing, classificationAccuracy: 0.899 }),
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
  });

  it('extracts only Discord message provenance IDs', () => {
    expect(
      extractDiscordProvenanceIds(
        'See https://discord.com/channels/32345678901234567/22345678901234567/62345678901235041 and https://example.com/62345678901235042',
      ),
    ).toEqual(['62345678901235041']);
  });
});
