import { z } from 'zod';

const paidGradeSchema = z.object({
  classification: z.number().min(0).max(1),
  crossTierRetrievalRelevance: z.number().min(0).max(1),
  rationale: z.string().max(500),
  rollupFaithfulness: z.number().min(0).max(1),
  supportedClaimPrecision: z.number().min(0).max(1),
});

export type PaidGrades = z.infer<typeof paidGradeSchema>;

export interface PinnedCorpusGradeTotals {
  readonly classification: number;
  readonly crossTierRetrievalRelevance: number;
  readonly forbiddenClaimHits: number;
  readonly invalidProvenanceIds: number;
  readonly returnedProvenanceIds: number;
  readonly rollupFaithfulness: number;
  readonly supportedClaimPrecision: number;
  readonly suppressedSourceLeaks: number;
}

export interface PinnedCorpusSummary {
  readonly classificationAccuracy: number;
  readonly crossTierRetrievalRelevance: number;
  readonly evaluatedAt: string;
  readonly evaluatorModel: string;
  readonly forbiddenClaimHits: number;
  readonly provenanceIdValidity: number;
  readonly rollupFaithfulness: number;
  readonly supportedClaimPrecision: number;
  readonly suppressedSourceLeaks: number;
  readonly textModel: string;
}

export function parsePaidGrades(output: string | undefined): PaidGrades {
  if (output === undefined) throw new Error('paid grader returned no output');
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('paid grader returned no JSON object');
  }
  return paidGradeSchema.parse(
    JSON.parse(output.slice(firstBrace, lastBrace + 1)),
  );
}

export function summarizePinnedCorpus(input: {
  readonly count: number;
  readonly evaluatedAt: string;
  readonly evaluatorModel: string;
  readonly textModel: string;
  readonly totals: PinnedCorpusGradeTotals;
}): PinnedCorpusSummary {
  if (!Number.isSafeInteger(input.count) || input.count <= 0) {
    throw new RangeError('pinned corpus count must be a positive integer');
  }
  return {
    classificationAccuracy: input.totals.classification / input.count,
    crossTierRetrievalRelevance:
      input.totals.crossTierRetrievalRelevance / input.count,
    evaluatedAt: input.evaluatedAt,
    evaluatorModel: input.evaluatorModel,
    forbiddenClaimHits: input.totals.forbiddenClaimHits,
    provenanceIdValidity:
      input.totals.returnedProvenanceIds === 0
        ? 1
        : 1 -
          input.totals.invalidProvenanceIds /
            input.totals.returnedProvenanceIds,
    rollupFaithfulness: input.totals.rollupFaithfulness / input.count,
    supportedClaimPrecision: input.totals.supportedClaimPrecision / input.count,
    suppressedSourceLeaks: input.totals.suppressedSourceLeaks,
    textModel: input.textModel,
  };
}

export function passesPinnedCorpus(summary: PinnedCorpusSummary): boolean {
  return (
    summary.supportedClaimPrecision >= 0.9 &&
    summary.classificationAccuracy >= 0.9 &&
    summary.forbiddenClaimHits === 0 &&
    summary.suppressedSourceLeaks === 0 &&
    summary.provenanceIdValidity === 1
  );
}

export function extractDiscordProvenanceIds(output: string): readonly string[] {
  return [
    ...output.matchAll(
      /https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/(\d{17,20})/gu,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}
