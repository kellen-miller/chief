import { performance } from 'node:perf_hooks';

import { createExecution } from '../src/agent/openai-chief-agent.js';
import { DEFAULT_TEXT_MODEL } from '../src/config/config.js';
import { createOpenAiMemoryExtractor } from '../src/memory/openai-memory.js';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('OPENAI_API_KEY is required for the paid conversation eval');
}

const textModel = process.env.CHIEF_MODEL_TEXT ?? DEFAULT_TEXT_MODEL;
const memoryModel = process.env.CHIEF_MODEL_MEMORY ?? 'gpt-5.4-nano';
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

if (failed) process.exitCode = 1;
