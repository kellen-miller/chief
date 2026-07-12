import type { Agent } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenAiEmbedder,
  createOpenAiMemoryExtractor,
} from '../../src/memory/openai-memory.js';

describe('OpenAI memory adapters', () => {
  it('uses the calibrated contract only for remember requests', async () => {
    const runAgent = vi.fn(
      (
        _agent: unknown,
        _prompt: string,
        _options: { readonly maxTurns: number; readonly signal: AbortSignal },
      ) => {
        void _agent;
        void _prompt;
        void _options;
        return Promise.resolve({
          finalOutput: { proposals: [] },
          state: { usage: { inputTokens: 100, outputTokens: 50 } },
        });
      },
    );
    const extract = createOpenAiMemoryExtractor({
      apiKey: 'test',
      dependencies: { runAgent },
      model: 'memory-model',
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
    });

    await extract({
      candidateMemories: [],
      content: 'Explicit communal memory request: no military academy',
      explicitIntent: 'remember',
    });
    await extract({
      candidateMemories: [],
      content: 'Chief correct dinner to seven',
      explicitIntent: 'correct',
    });

    const firstCall = runAgent.mock.calls[0];
    if (firstCall === undefined) throw new Error('remember agent did not run');
    const rememberAgent = firstCall[0] as Agent;
    const correctionAgent = runAgent.mock.calls[1]?.[0] as Agent;
    expect(String(rememberAgent.instructions)).toMatch(
      /topic words\s+such as military[\s\S]*not sensitive/iu,
    );
    expect(String(rememberAgent.instructions)).toMatch(
      /requested non-sensitive memory is clear\s+and unambiguous/iu,
    );
    expect(String(rememberAgent.instructions)).toMatch(
      /confidence of at\s+least 0\.90/iu,
    );
    expect(String(correctionAgent.instructions)).not.toMatch(
      /topic words\s+such as military/iu,
    );
    expect(String(correctionAgent.instructions)).toMatch(
      /similarly sensitive\s+content/iu,
    );
    expect(JSON.parse(firstCall[1])).toMatchObject({
      explicitIntent: 'remember',
    });
  });

  it('runs bounded structured extraction and prices its usage', async () => {
    const runAgent = vi.fn(
      (
        agent: unknown,
        prompt: string,
        options: { readonly maxTurns: number; readonly signal: AbortSignal },
      ) => {
        expect((agent as Agent).modelSettings).toMatchObject({
          maxTokens: 1_200,
        });
        expect(JSON.parse(prompt)).toMatchObject({
          sourceText: 'We meet Friday',
        });
        expect(options.maxTurns).toBe(1);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve({
          finalOutput: {
            proposals: [
              {
                action: 'create' as const,
                canonicalText: 'The group meets Friday',
                confidence: 0.9,
                kind: 'plan',
                sensitivity: 'none' as const,
                targetMemoryId: null,
              },
            ],
          },
          state: { usage: { inputTokens: 1_000, outputTokens: 500 } },
        });
      },
    );
    const extract = createOpenAiMemoryExtractor({
      apiKey: 'test',
      dependencies: { runAgent },
      model: 'memory-model',
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });

    await expect(
      extract({
        candidateMemories: [],
        content: 'We meet Friday',
        explicitIntent: 'remember',
      }),
    ).resolves.toMatchObject({ usageUsd: 0.002 });
  });

  it('rejects empty structured extraction and invalid embeddings', async () => {
    const extract = createOpenAiMemoryExtractor({
      apiKey: 'test',
      dependencies: {
        runAgent: () =>
          Promise.resolve({
            finalOutput: undefined,
            state: { usage: { inputTokens: 0, outputTokens: 0 } },
          }),
      },
      model: 'memory-model',
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
    });
    await expect(
      extract({
        candidateMemories: [],
        content: 'nothing',
        explicitIntent: null,
      }),
    ).rejects.toThrow(/no structured output/u);

    const embed = createOpenAiEmbedder({
      apiKey: 'test',
      createEmbedding: () => Promise.resolve({ embedding: [1], tokens: 1 }),
      model: 'embedding-model',
      pricing: { inputPerMillionUsd: 0.02 },
    });
    await expect(embed('bad')).rejects.toThrow(/invalid memory embedding/u);
  });

  it('normalizes a valid embedding and prices tokens', async () => {
    const embed = createOpenAiEmbedder({
      apiKey: 'test',
      createEmbedding: () =>
        Promise.resolve({ embedding: Array(1_536).fill(0.5), tokens: 2_000 }),
      model: 'embedding-model',
      pricing: { inputPerMillionUsd: 0.02 },
    });

    await expect(embed('cabinet')).resolves.toMatchObject({
      usageUsd: 0.00004,
    });
  });
});
