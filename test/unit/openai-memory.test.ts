import type { Agent } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenAiEmbedder,
  createOpenAiMemoryExtractor,
} from '../../src/memory/openai-memory.js';

describe('OpenAI memory adapters', () => {
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
        explicitRemember: true,
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
        explicitRemember: false,
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
