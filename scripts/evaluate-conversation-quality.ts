import { performance } from 'node:perf_hooks';

import { createExecution } from '../src/agent/openai-chief-agent.js';
import { DEFAULT_TEXT_MODEL } from '../src/config/config.js';
import { createOpenAiMemoryExtractor } from '../src/memory/openai-memory.js';
import {
  countNormalizedMatches,
  createConversationQualityGrader,
  extractDiscordProvenanceIds,
  passesPinnedCorpus,
  summarizePinnedCorpus,
} from './conversation-quality-grades.js';
import {
  loadConversationQualityFixture,
  replayConversationQualityCase,
} from './conversation-quality-corpus.js';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('OPENAI_API_KEY is required for the paid conversation eval');
}

const textModel = process.env.CHIEF_MODEL_TEXT ?? DEFAULT_TEXT_MODEL;
const memoryModel = process.env.CHIEF_MODEL_MEMORY ?? 'gpt-5.4-nano';
const evaluatorModel = process.env.CHIEF_MODEL_EVALUATOR ?? textModel;
const gradePinnedCorpus = process.argv.includes('--grade-pinned-corpus');
const execute = createExecution(apiKey, textModel);
const cases = [
  {
    input: JSON.stringify({
      communalMemory: ['The group does not choose military academies.'],
      dataClassification: 'untrusted_user_supplied_context',
      recentConversation: [
        {
          content:
            'The candidates are Oregon, New Mexico, Air Force, Navy, and Syracuse.',
          role: 'human',
          speakerLabel: 'President One',
        },
        {
          content: 'No military academies for the final pick.',
          role: 'human',
          speakerLabel: 'President Two',
        },
      ],
      userRequest: 'Pick one from that list for Polk and explain briefly.',
    }),
    name: 'polk-no-military',
    passes: (output: string) =>
      /\b(Oregon|New Mexico|Syracuse)\b/iu.test(output) &&
      !/\b(Air Force|Navy|Army)\b/iu.test(output),
  },
  {
    input: JSON.stringify({
      communalMemory: [],
      dataClassification: 'untrusted_user_supplied_context',
      recentConversation: [
        {
          content: 'Chief gave a firm recommendation.',
          role: 'chief',
          speakerLabel: 'Chief',
        },
      ],
      userRequest: 'Chief, are you changing your own recommendation?',
    }),
    name: 'chief-self-reference',
    passes: (output: string) =>
      output.trim().length > 0 &&
      !/who is chief|do not know chief/iu.test(output),
  },
  {
    input: JSON.stringify({
      communalMemory: ['The group does not choose military academies.'],
      dataClassification: 'untrusted_user_supplied_context',
      recentConversation: [
        {
          content:
            'Oregon beat Syracuse, New Mexico beat Navy, and Air Force had a bye.',
          role: 'human',
          speakerLabel: 'President One',
        },
      ],
      userRequest: 'What do you think about those outcomes?',
    }),
    name: 'those-outcomes-follow-up',
    passes: (output: string) =>
      /\b(Oregon|Syracuse|New Mexico|Navy|Air Force)\b/iu.test(output) &&
      !/what outcomes|which outcomes|need more context/iu.test(output),
  },
] as const;

let failed = false;
for (const evaluation of cases) {
  const started = performance.now();
  const result = await execute(evaluation.input);
  const output = result.output ?? '';
  const passed = evaluation.passes(output);
  failed ||= !passed;
  process.stdout.write(
    `${JSON.stringify({
      case: evaluation.name,
      inputTokens: result.inputTokens,
      latencyMs: Math.round(performance.now() - started),
      model: textModel,
      outputTokens: result.outputTokens,
      passed,
      reasoning: 'low',
    })}\n`,
  );
}

const extractMemory = createOpenAiMemoryExtractor({
  apiKey,
  model: memoryModel,
  pricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
});
const memoryCases = [
  {
    content: 'Explicit communal memory request: no military academy',
    name: 'memory-clear-preference',
    passes: (
      proposals: Awaited<ReturnType<typeof extractMemory>>['proposals'],
    ) =>
      proposals.some(
        ({ action, confidence, sensitivity }) =>
          action === 'create' && confidence >= 0.9 && sensitivity === 'none',
      ),
  },
  {
    content:
      'Explicit communal memory request: the shared sandbox password is EVAL-ONLY-NOT-A-REAL-SECRET',
    name: 'memory-sensitive-rejection',
    passes: (
      proposals: Awaited<ReturnType<typeof extractMemory>>['proposals'],
    ) =>
      proposals.some(({ sensitivity }) => sensitivity === 'sensitive') &&
      !proposals.some(
        ({ action, sensitivity }) =>
          sensitivity === 'none' &&
          (action === 'create' || action === 'supersede'),
      ),
  },
] as const;

for (const evaluation of memoryCases) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = performance.now();
    const result = await extractMemory({
      candidateMemories: [],
      content: evaluation.content,
      explicitIntent: 'remember',
    });
    const passed = evaluation.passes(result.proposals);
    failed ||= !passed;
    process.stdout.write(
      `${JSON.stringify({
        attempt,
        case: evaluation.name,
        inputTokens: result.inputTokens,
        latencyMs: Math.round(performance.now() - started),
        model: memoryModel,
        outputTokens: result.outputTokens,
        passed,
        reasoning: 'none',
      })}\n`,
    );
  }
}

if (gradePinnedCorpus) {
  const pinnedCorpusFailed = await evaluatePinnedCorpus({
    apiKey,
    evaluatorModel,
    textModel,
  });
  failed ||= pinnedCorpusFailed;
}

if (failed) process.exitCode = 1;

async function evaluatePinnedCorpus(options: {
  readonly apiKey: string;
  readonly evaluatorModel: string;
  readonly textModel: string;
}): Promise<boolean> {
  const fixture = await loadConversationQualityFixture();
  if (fixture.cases.length < 40) {
    throw new Error('pinned conversation quality corpus requires 40 cases');
  }
  const answer = createExecution(options.apiKey, options.textModel);
  const grade = createConversationQualityGrader({
    apiKey: options.apiKey,
    model: options.evaluatorModel,
  });
  const evaluatedAt = new Date().toISOString();
  const totals = {
    crossTierRetrievalRelevance: 0,
    forbiddenClaimHits: 0,
    historyClassification: 0,
    historyClassificationCases: 0,
    invalidProvenanceIds: 0,
    memoryClassification: 0,
    memoryClassificationCases: 0,
    returnedProvenanceIds: 0,
    requestedSourceLinkCases: 0,
    requestedSourceLinkPasses: 0,
    rollupFaithfulness: 0,
    supportedClaimPrecision: 0,
    suppressedSourceLeaks: 0,
  };
  process.stdout.write(
    `${JSON.stringify({
      cases: fixture.cases.length,
      evaluatedAt,
      evaluatorModel: options.evaluatorModel,
      event: 'pinned-corpus-start',
      textModel: options.textModel,
    })}\n`,
  );

  for (const qualityCase of fixture.cases) {
    const replay = await replayConversationQualityCase(qualityCase);
    if (replay.classification !== qualityCase.expectedClassification) {
      throw new Error(`pinned case ${qualityCase.id} classification mismatch`);
    }
    const answerResult = await answer(JSON.stringify(replay.productionPayload));
    const output = answerResult.output?.trim() ?? '';
    const gradingResult = await grade({
      candidateAnswer: output,
      expectedClassification: replay.classification,
      expectedRetrievalTier: qualityCase.expectedRetrievalTier,
      forbiddenClaims: qualityCase.forbiddenClaims,
      requiredClaims: qualityCase.requiredClaims,
      suppliedContext: {
        communalMemory: replay.productionPayload.communalMemory,
        historicalContext: replay.productionPayload.historicalContext,
      },
    });
    const numericGrades = {
      classification: gradingResult.grades.classification,
      crossTierRetrievalRelevance:
        gradingResult.grades.crossTierRetrievalRelevance,
      rollupFaithfulness: gradingResult.grades.rollupFaithfulness,
      supportedClaimPrecision: gradingResult.grades.supportedClaimPrecision,
    };
    if (replay.classification === 'history') {
      totals.historyClassification += gradingResult.grades.classification;
      totals.historyClassificationCases += 1;
    } else {
      totals.memoryClassification += gradingResult.grades.classification;
      totals.memoryClassificationCases += 1;
    }
    totals.crossTierRetrievalRelevance +=
      gradingResult.grades.crossTierRetrievalRelevance;
    totals.rollupFaithfulness += gradingResult.grades.rollupFaithfulness;
    totals.supportedClaimPrecision +=
      gradingResult.grades.supportedClaimPrecision;
    totals.forbiddenClaimHits += countNormalizedMatches(
      output,
      qualityCase.forbiddenClaims,
    );
    totals.suppressedSourceLeaks += countNormalizedMatches(
      output,
      qualityCase.leakageMarkers ?? [],
    );
    const returnedProvenanceIds = extractDiscordProvenanceIds(output);
    totals.returnedProvenanceIds += returnedProvenanceIds.length;
    totals.invalidProvenanceIds += returnedProvenanceIds.filter(
      (provenanceId) =>
        !qualityCase.allowedProvenanceIds.includes(provenanceId),
    ).length;
    if (qualityCase.requestSourceLinks) {
      totals.requestedSourceLinkCases += 1;
      if (
        replay.returnedSourceLinks.length > 0 &&
        replay.returnedSourceLinks.every((link) => output.includes(link))
      ) {
        totals.requestedSourceLinkPasses += 1;
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        case: qualityCase.id,
        evaluatedAt,
        evaluatorModel: options.evaluatorModel,
        grades: numericGrades,
        inputTokens: answerResult.inputTokens + gradingResult.inputTokens,
        outputTokens: answerResult.outputTokens + gradingResult.outputTokens,
        returnedProvenanceCount: returnedProvenanceIds.length,
        textModel: options.textModel,
      })}\n`,
    );
  }

  const summary = summarizePinnedCorpus({
    count: fixture.cases.length,
    evaluatedAt,
    evaluatorModel: options.evaluatorModel,
    textModel: options.textModel,
    totals,
  });
  const passed = passesPinnedCorpus(summary);
  process.stdout.write(
    `${JSON.stringify({ event: 'pinned-corpus-summary', passed, ...summary })}\n`,
  );
  return !passed;
}
