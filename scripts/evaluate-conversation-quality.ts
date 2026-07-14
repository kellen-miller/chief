import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { createExecution } from '../src/agent/openai-chief-agent.js';
import { DEFAULT_TEXT_MODEL } from '../src/config/config.js';
import { createOpenAiMemoryExtractor } from '../src/memory/openai-memory.js';
import {
  extractDiscordProvenanceIds,
  parsePaidGrades,
  passesPinnedCorpus,
  summarizePinnedCorpus,
} from './conversation-quality-grades.js';

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

interface PinnedEvidence {
  readonly contentState?:
    'available' | 'discord-deleted' | 'locally-forgotten' | 'retention-expired';
  readonly lineageText?: string;
  readonly provenanceId: string;
  readonly text: string;
  readonly tier:
    'daily' | 'hourly' | 'long-term' | 'memory' | 'source' | 'weekly';
}

interface PinnedCase {
  readonly allowedProvenanceIds: readonly string[];
  readonly evidence: readonly PinnedEvidence[];
  readonly expectedClassification: 'history' | 'memory';
  readonly expectedRetrievalTier: PinnedEvidence['tier'];
  readonly forbiddenClaims: readonly string[];
  readonly id: string;
  readonly prompt: string;
  readonly requiredClaims: readonly string[];
}

async function evaluatePinnedCorpus(options: {
  readonly apiKey: string;
  readonly evaluatorModel: string;
  readonly textModel: string;
}): Promise<boolean> {
  const fixture = JSON.parse(
    await readFile(
      new URL('../test/fixtures/conversation-quality.json', import.meta.url),
      'utf8',
    ),
  ) as { readonly cases: readonly PinnedCase[] };
  if (fixture.cases.length < 40) {
    throw new Error('pinned conversation quality corpus requires 40 cases');
  }
  const answer = createExecution(options.apiKey, options.textModel);
  const grade = createExecution(options.apiKey, options.evaluatorModel);
  const evaluatedAt = new Date().toISOString();
  const totals = {
    classification: 0,
    crossTierRetrievalRelevance: 0,
    forbiddenClaimHits: 0,
    invalidProvenanceIds: 0,
    returnedProvenanceIds: 0,
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
    const availableEvidence = qualityCase.evidence.filter(
      ({ contentState, tier }) =>
        tier !== 'source' ||
        contentState === undefined ||
        contentState === 'available',
    );
    const historicalContext = availableEvidence.flatMap<
      Record<string, unknown>
    >((evidence) =>
      evidence.tier === 'memory'
        ? []
        : evidence.tier === 'source'
          ? [
              {
                confidence: 0.95,
                evidenceForm: 'source',
                occurredAt: 0,
                provenanceQuality: 'source-backed',
                sourceLinks: [discordSourceLink(evidence.provenanceId)],
                speakerLabel: 'President Quality',
                temporalLabel: 'pinned corpus',
                text: evidence.text,
              },
            ]
          : [
              {
                confidence: 0.95,
                evidenceForm: 'rollup',
                periodEnd: null,
                periodStart: 0,
                provenanceQuality:
                  evidence.contentState === undefined ||
                  evidence.contentState === 'available'
                    ? 'source-backed'
                    : 'summary-only',
                sourceLinks: [discordSourceLink(evidence.provenanceId)],
                summary: evidence.text,
                temporalLabel: 'pinned corpus',
                tier: evidence.tier,
              },
            ],
    );
    const communalMemory = availableEvidence.flatMap((evidence) =>
      evidence.tier === 'memory' ? [evidence.text] : [],
    );
    const answerResult = await answer(
      JSON.stringify({
        communalMemory,
        dataClassification: 'untrusted_user_supplied_context',
        historicalContext,
        userRequest: qualityCase.prompt,
      }),
    );
    const output = answerResult.output?.trim() ?? '';
    const gradingResult = await grade(
      paidGradingPrompt(qualityCase, availableEvidence, output),
    );
    const grades = parsePaidGrades(gradingResult.output);
    totals.classification += grades.classification;
    totals.crossTierRetrievalRelevance += grades.crossTierRetrievalRelevance;
    totals.rollupFaithfulness += grades.rollupFaithfulness;
    totals.supportedClaimPrecision += grades.supportedClaimPrecision;
    totals.forbiddenClaimHits += qualityCase.forbiddenClaims.filter((claim) =>
      output.includes(claim),
    ).length;
    totals.suppressedSourceLeaks += qualityCase.evidence.filter(
      (evidence) =>
        evidence.contentState !== undefined &&
        evidence.contentState !== 'available' &&
        output.includes(evidence.lineageText ?? evidence.text),
    ).length;
    const returnedProvenanceIds = extractDiscordProvenanceIds(output);
    totals.returnedProvenanceIds += returnedProvenanceIds.length;
    totals.invalidProvenanceIds += returnedProvenanceIds.filter(
      (provenanceId) =>
        !qualityCase.allowedProvenanceIds.includes(provenanceId),
    ).length;
    process.stdout.write(
      `${JSON.stringify({
        case: qualityCase.id,
        evaluatedAt,
        evaluatorModel: options.evaluatorModel,
        grades,
        inputTokens: answerResult.inputTokens + gradingResult.inputTokens,
        outputTokens: answerResult.outputTokens + gradingResult.outputTokens,
        returnedProvenanceIds,
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

function paidGradingPrompt(
  qualityCase: PinnedCase,
  availableEvidence: readonly PinnedEvidence[],
  output: string,
): string {
  return JSON.stringify({
    instruction:
      'Grade the candidate answer. Return JSON only with numeric scores from 0 to 1 for rollupFaithfulness, supportedClaimPrecision, crossTierRetrievalRelevance, and classification, plus a rationale under 500 characters. A score of 1 means: rollup claims preserve qualifiers and disagreements (or no rollup was supplied); every answer claim is supported; the answer uses only relevant supplied tiers; and it treats history as discussion rather than accepted memory while treating memory as accepted context.',
    rubric: {
      expectedClassification: qualityCase.expectedClassification,
      expectedRetrievalTier: qualityCase.expectedRetrievalTier,
      forbiddenClaims: qualityCase.forbiddenClaims,
      requiredClaims: qualityCase.requiredClaims,
    },
    suppliedEvidence: availableEvidence,
    userRequest: qualityCase.prompt,
    candidateAnswer: output,
  });
}

function discordSourceLink(provenanceId: string): string {
  return `https://discord.com/channels/32345678901234567/22345678901234567/${provenanceId}`;
}
