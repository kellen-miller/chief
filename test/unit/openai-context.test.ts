import { run } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@openai/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openai/agents')>()),
  run: vi.fn(),
}));

import { createOpenAiContextSummarizer } from '../../src/context/openai-context.js';

describe('createOpenAiContextSummarizer', () => {
  it('uses the configured memory model pricing and validates source IDs', async () => {
    const runAgent = vi.fn(
      (
        agent: unknown,
        prompt: string,
        options: { readonly maxTurns: number; readonly signal: AbortSignal },
      ) => {
        void agent;
        void prompt;
        void options;
        return Promise.resolve({
          finalOutput: {
            confidence: 0.9,
            sourceIds: ['event:1'],
            summary: 'The group discussed Project Marigold.',
            topicProposals: [{ label: 'Marigold', sourceIds: ['event:1'] }],
          },
          state: { usage: { inputTokens: 100, outputTokens: 40 } },
        });
      },
    );
    const summarizer = createOpenAiContextSummarizer({
      apiKey: 'test-key',
      dependencies: { runAgent },
      model: 'configured-memory-model',
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
    });

    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [{ id: 'event:1', text: 'Project Marigold launches.' }],
        tier: 'hourly',
      }),
    ).resolves.toEqual({
      confidence: 0.9,
      inputTokens: 100,
      outputTokens: 40,
      sourceIds: ['event:1'],
      summary: 'The group discussed Project Marigold.',
      topicProposals: [{ label: 'Marigold', sourceIds: ['event:1'] }],
      usageUsd: 0.00036,
    });
    const call = runAgent.mock.calls[0];
    if (call === undefined) throw new Error('expected context provider call');
    expect(call[1]).toContain('Project Marigold launches.');
    expect(call[2].maxTurns).toBe(1);
    expect(call[2].signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects model references outside the supplied source set', async () => {
    const summarizer = createOpenAiContextSummarizer({
      apiKey: 'test-key',
      dependencies: {
        runAgent: () =>
          Promise.resolve({
            finalOutput: {
              confidence: 0.9,
              sourceIds: ['event:private'],
              summary: 'Unsupported content.',
              topicProposals: [],
            },
            state: { usage: { inputTokens: 10, outputTokens: 5 } },
          }),
      },
      model: 'configured-memory-model',
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
    });

    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [{ id: 'event:1', text: 'Public source.' }],
        tier: 'hourly',
      }),
    ).rejects.toThrow('context summary referenced an unknown source');
  });

  it('rejects a missing structured provider result', async () => {
    const summarizer = createOpenAiContextSummarizer({
      apiKey: 'test-key',
      dependencies: {
        runAgent: () =>
          Promise.resolve({
            finalOutput: undefined,
            state: { usage: { inputTokens: 0, outputTokens: 0 } },
          }),
      },
      model: 'configured-memory-model',
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
    });

    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [{ id: 'event:1', text: 'Public source.' }],
        tier: 'hourly',
      }),
    ).rejects.toThrow('context summarization returned no structured output');
  });

  it('uses the SDK runner when no injected runner is supplied', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      finalOutput: {
        confidence: 0.8,
        sourceIds: ['event:1'],
        summary: 'The group discussed the supplied source.',
        topicProposals: [],
      },
      state: { usage: { inputTokens: 4, outputTokens: 2 } },
    } as never);
    const summarizer = createOpenAiContextSummarizer({
      apiKey: 'test-key',
      model: 'configured-memory-model',
      pricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    });

    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [{ id: 'event:1', text: 'Public source.' }],
        tier: 'hourly',
      }),
    ).resolves.toMatchObject({
      sourceIds: ['event:1'],
      usageUsd: 0,
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
