import { performance } from 'node:perf_hooks';

import { createExecution } from '../src/agent/openai-chief-agent.js';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('OPENAI_API_KEY is required for the paid conversation eval');
}

const model = process.env.CHIEF_MODEL_TEXT ?? 'gpt-5.4-mini';
const execute = createExecution(apiKey, model);
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
      model,
      outputTokens: result.outputTokens,
      passed,
      reasoning: 'low',
    })}\n`,
  );
}

if (failed) process.exitCode = 1;
