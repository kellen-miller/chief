import { Agent, run } from '@openai/agents';
import { z } from 'zod';
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
        _agent: unknown,
        _prompt: string,
        _options: { readonly maxTurns: number; readonly signal: AbortSignal },
      ) => {
        return Promise.resolve({
          finalOutput: {
            confidence: 0.9,
            sourceIndexes: [0],
            summary: 'The group discussed Project Marigold.',
            topicProposals: [{ label: 'Marigold', sourceIndexes: [0] }],
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

  it('constrains summary and topic references to each request source set', async () => {
    let sourceCount = 1;
    const runAgent = vi.fn((agent: unknown) => {
      if (
        !(agent instanceof Agent) ||
        !(agent.outputType instanceof z.ZodObject)
      ) {
        throw new Error('expected structured context agent');
      }

      const valid = {
        confidence: 0.9,
        sourceIndexes: [0],
        summary: 'Supported summary.',
        topicProposals: [{ label: 'Topic', sourceIndexes: [0] }],
      };
      expect(agent.outputType.safeParse(valid).success).toBe(true);
      expect(
        agent.outputType.safeParse({ ...valid, sourceIndexes: [sourceCount] })
          .success,
      ).toBe(false);
      expect(
        agent.outputType.safeParse({
          ...valid,
          topicProposals: [{ label: 'Topic', sourceIndexes: [sourceCount] }],
        }).success,
      ).toBe(false);
      return Promise.resolve({
        finalOutput: valid,
        state: { usage: { inputTokens: 10, outputTokens: 5 } },
      });
    });
    const summarizer = createOpenAiContextSummarizer({
      apiKey: 'test-key',
      dependencies: { runAgent },
      model: 'configured-memory-model',
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
    });
    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [
          { id: 'document:2', text: 'Historical summary citing event:1.' },
        ],
        tier: 'long-term',
      }),
    ).resolves.toMatchObject({
      sourceIds: ['document:2'],
      topicProposals: [{ sourceIds: ['document:2'] }],
    });
    sourceCount = 2;
    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [
          { id: 'document:3', text: 'First source.' },
          { id: 'document:4', text: 'Second source.' },
        ],
        tier: 'long-term',
      }),
    ).resolves.toMatchObject({ sourceIds: ['document:3'] });
  });

  it.each(['summary', 'topic'] as const)(
    'rejects %s references outside the supplied source set',
    async (reference) => {
      const summarizer = createOpenAiContextSummarizer({
        apiKey: 'test-key',
        dependencies: {
          runAgent: () =>
            Promise.resolve({
              finalOutput: {
                confidence: 0.9,
                sourceIndexes: [reference === 'summary' ? 999 : 0],
                summary: 'Unsupported content.',
                topicProposals:
                  reference === 'topic'
                    ? [{ label: 'Topic', sourceIndexes: [999] }]
                    : [],
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
    },
  );

  it('rejects empty input before starting a paid request', async () => {
    const runAgent = vi.fn();
    const summarizer = createOpenAiContextSummarizer({
      apiKey: 'test-key',
      dependencies: { runAgent },
      model: 'configured-memory-model',
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
    });
    await expect(
      summarizer.summarize({
        completeness: 'final',
        sources: [],
        tier: 'hourly',
      }),
    ).rejects.toThrow('context summarization requires sources');
    expect(runAgent).not.toHaveBeenCalled();
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
        sourceIndexes: [0],
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
