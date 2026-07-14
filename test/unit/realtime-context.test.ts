import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createRealtimeContextTools,
  NormalizedRealtimeSession,
} from '../../src/agent/openai-voice.js';
import { OpenAiChiefAgent } from '../../src/agent/openai-chief-agent.js';
import type { PreparedContext } from '../../src/context/context-types.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

describe('Realtime context recall', () => {
  it('rejects committed greeting noise without blocking a short topic query', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const assemble = vi.fn(() =>
      Promise.resolve(preparedRealtimeContext('52345678901234569', 0.001)),
    );
    const state = {
      citations: new Set<string>(),
      committedUtterance: 1,
      persistenceFailed: false,
      successfulRecallUtterance: null,
      usageUsd: 0,
    };
    const tools = createRealtimeContextTools(
      { assemble },
      memory,
      {
        recentConversation: [],
        requestId: 'voice-substantive',
        speakerId: 'president-1',
        speakerName: 'President One',
      },
      state,
    );
    const recall = tools.find(
      (candidate) => candidate.name === 'recall_context',
    );
    if (recall === undefined) throw new Error('context recall tool missing');

    await expect(
      recall.invoke({} as never, JSON.stringify({ query: 'Hello, Chief' })),
    ).resolves.toContain('non-substantive-query');
    expect(assemble).not.toHaveBeenCalled();
    await expect(
      recall.invoke({} as never, JSON.stringify({ query: 'x' })),
    ).resolves.toContain('non-substantive-query');
    expect(assemble).not.toHaveBeenCalled();
    await expect(
      recall.invoke({} as never, JSON.stringify({ query: 'Budget?' })),
    ).resolves.toContain('"userRequest":"Budget?"');
    expect(assemble).toHaveBeenCalledOnce();
    database.close();
  });

  it('discards stale recall side effects after the next utterance commits', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const resolvers: ((value: PreparedContext) => void)[] = [];
    const assemble = vi.fn(
      () =>
        new Promise<PreparedContext>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const state = {
      citations: new Set<string>(),
      committedUtterance: 1,
      persistenceFailed: false,
      successfulRecallUtterance: null,
      usageUsd: 0,
    };
    const tools = createRealtimeContextTools(
      { assemble },
      memory,
      {
        recentConversation: [],
        requestId: 'voice-stale',
        speakerId: 'president-1',
        speakerName: 'President One',
      },
      state,
    );
    const recall = tools.find(
      (candidate) => candidate.name === 'recall_context',
    );
    if (recall === undefined) throw new Error('context recall tool missing');

    const stale = recall.invoke(
      {} as never,
      JSON.stringify({ query: 'Old question' }),
    );
    await vi.waitFor(() => {
      expect(assemble).toHaveBeenCalledOnce();
    });
    state.committedUtterance = 2;
    const current = recall.invoke(
      {} as never,
      JSON.stringify({ query: 'Current question' }),
    );
    await vi.waitFor(() => {
      expect(assemble).toHaveBeenCalledTimes(2);
    });
    const staleResolver = resolvers[0];
    if (staleResolver === undefined)
      throw new Error('stale recall did not start');
    staleResolver(preparedRealtimeContext('52345678901234567', 0.1));

    await expect(stale).resolves.toContain('stale-utterance');
    expect(state.citations).toEqual(new Set());
    expect(state.usageUsd).toBe(0);
    expect(state.successfulRecallUtterance).toBeNull();

    const currentResolver = resolvers[1];
    if (currentResolver === undefined)
      throw new Error('current recall did not start');
    currentResolver(preparedRealtimeContext('52345678901234568', 0.2));
    await expect(current).resolves.toContain(
      '"userRequest":"Current question"',
    );
    expect(state.citations).toEqual(
      new Set([
        'https://discord.com/channels/32345678901234567/22345678901234567/52345678901234568',
      ]),
    );
    expect(state.usageUsd).toBe(0.2);
    expect(state.successfulRecallUtterance).toBe(2);
    database.close();
  });

  it('coalesces parallel recall attempts for one utterance', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    let resolveAssembly:
      | ((value: {
          approximateTokens: number;
          degraded: boolean;
          historicalContext: [];
          memories: [];
          recentConversation: [];
          usageUsd: number;
        }) => void)
      | undefined;
    const assemble = vi.fn(
      () =>
        new Promise<{
          approximateTokens: number;
          degraded: boolean;
          historicalContext: [];
          memories: [];
          recentConversation: [];
          usageUsd: number;
        }>((resolve) => {
          resolveAssembly = resolve;
        }),
    );
    const state = {
      citations: new Set<string>(),
      committedUtterance: 1,
      persistenceFailed: false,
      successfulRecallUtterance: null,
      usageUsd: 0,
    };
    const tools = createRealtimeContextTools(
      { assemble },
      memory,
      {
        recentConversation: [],
        requestId: 'voice-parallel',
        speakerId: 'president-1',
        speakerName: 'President One',
      },
      state,
    );
    const recall = tools.find(
      (candidate) => candidate.name === 'recall_context',
    );
    if (recall === undefined) throw new Error('context recall tool missing');

    const first = recall.invoke(
      {} as never,
      JSON.stringify({ query: 'What changed?' }),
    );
    await vi.waitFor(() => {
      expect(assemble).toHaveBeenCalledOnce();
    });
    await expect(
      recall.invoke({} as never, JSON.stringify({ query: 'What changed?' })),
    ).resolves.toContain('already-recalled');
    if (resolveAssembly === undefined)
      throw new Error('assembly did not start');
    resolveAssembly({
      approximateTokens: 0,
      degraded: false,
      historicalContext: [],
      memories: [],
      recentConversation: [],
      usageUsd: 0.001,
    });
    await expect(first).resolves.toContain('"userRequest":"What changed?"');
    expect(assemble).toHaveBeenCalledOnce();
    database.close();
  });

  it('matches the structured text context payload', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const prepared = {
      approximateTokens: 25,
      degraded: false,
      historicalContext: [
        {
          confidence: 0.9,
          evidenceForm: 'source' as const,
          occurredAt: 100,
          provenanceQuality: 'source-backed' as const,
          sourceLinks: [
            'https://discord.com/channels/32345678901234567/22345678901234567/52345678901234567',
          ],
          speakerName: '<@123> President\u0000 One',
          temporalLabel: 'Jul 14, 2026, 11:00 AM',
          text: 'The group discussed Marigold.',
        },
        {
          confidence: 0.8,
          evidenceForm: 'rollup' as const,
          periodEnd: 200,
          periodStart: 100,
          provenanceQuality: 'summary-only' as const,
          sourceLinks: [],
          summary: 'The older discussion did not settle the date.',
          temporalLabel: 'week of Jul 13, 2026',
          tier: 'weekly' as const,
        },
      ],
      memories: ['Marigold is an accepted project.'],
      recentConversation: [
        {
          content: 'Earlier context.',
          role: 'human' as const,
          speakerName: '<@123> President\u0000 One',
        },
      ],
      usageUsd: 0.003,
    };
    const execute = vi.fn((prompt: string) => {
      void prompt;
      return Promise.resolve({
        inputTokens: 0,
        output: 'Noted',
        outputTokens: 0,
        searchCalls: 0,
      });
    });
    const agent = new OpenAiChiefAgent({
      apiKey: 'test',
      execute,
      model: 'gpt-test',
      pricing: {
        cachedInputPerMillionUsd: 1,
        cacheWriteInputPerMillionUsd: 1,
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 1,
        searchCallUsd: 0,
      },
    });
    const query = 'What changed with Marigold?';
    await agent.answerText({
      historicalContext: prepared.historicalContext,
      memories: prepared.memories,
      prompt: query,
      recentConversation: prepared.recentConversation,
      requestId: 'text-context',
    });
    const textPayload = JSON.parse(
      String(execute.mock.calls[0]?.[0]),
    ) as Record<string, unknown>;
    const state = {
      citations: new Set<string>(),
      committedUtterance: 1,
      persistenceFailed: false,
      successfulRecallUtterance: null,
      usageUsd: 0,
    };
    const tools = createRealtimeContextTools(
      { assemble: () => Promise.resolve(prepared) },
      memory,
      {
        recentConversation: [],
        requestId: 'voice-context',
        speakerId: 'president-1',
        speakerName: 'President One',
      },
      state,
    );
    const recall = tools.find(
      (candidate) => candidate.name === 'recall_context',
    );
    if (recall === undefined) throw new Error('context recall tool missing');
    const voicePayload = JSON.parse(
      await recall.invoke({} as never, JSON.stringify({ query })),
    ) as Record<string, unknown>;

    expect({
      communalMemory: voicePayload.communalMemory,
      dataClassification: voicePayload.dataClassification,
      historicalContext: voicePayload.historicalContext,
      recentConversation: voicePayload.recentConversation,
      userRequest: voicePayload.userRequest,
    }).toEqual(textPayload);
    database.close();
  });

  it('allows one successful structured recall per committed utterance', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const memory = new MemoryService({
      budget: new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const sourceLink =
      'https://discord.com/channels/32345678901234567/22345678901234567/52345678901234567';
    const assemble = vi.fn(
      (input: {
        readonly beforeEventId?: number;
        readonly now: number;
        readonly prompt: string;
      }) => {
        void input;
        return Promise.resolve({
          approximateTokens: 25,
          degraded: false,
          historicalContext: [
            {
              confidence: 0.9,
              evidenceForm: 'source' as const,
              occurredAt: 100,
              provenanceQuality: 'source-backed' as const,
              sourceLinks: [sourceLink],
              speakerName: 'President One',
              temporalLabel: 'Jul 14, 2026, 11:00 AM',
              text: 'The group discussed Marigold.',
            },
          ],
          memories: ['Marigold is accepted.'],
          recentConversation: [
            {
              content: 'Earlier context.',
              role: 'human' as const,
              speakerName: 'President One',
            },
          ],
          usageUsd: 0.003,
        });
      },
    );
    const state = {
      citations: new Set<string>(),
      committedUtterance: 0,
      persistenceFailed: false,
      successfulRecallUtterance: null,
      usageUsd: 0,
    };
    const tools = createRealtimeContextTools(
      { assemble },
      memory,
      {
        recentConversation: [],
        requestId: 'voice-context',
        speakerId: 'president-1',
        speakerName: 'President One',
      },
      state,
    );
    const recall = tools.find(
      (candidate) => candidate.name === 'recall_context',
    );
    if (recall === undefined) throw new Error('context recall tool missing');

    await expect(
      recall.invoke(
        {} as never,
        JSON.stringify({ query: 'What changed with Marigold?' }),
      ),
    ).resolves.toContain('no-committed-utterance');
    expect(assemble).not.toHaveBeenCalled();

    const realtime = new FakeRealtimeSession();
    const normalized = new NormalizedRealtimeSession(
      realtime as never,
      {
        audioInputPerMillionUsd: 1,
        audioOutputPerMillionUsd: 1,
        textInputPerMillionUsd: 1,
        textOutputPerMillionUsd: 1,
      },
      state,
    );
    normalized.sendAudio(new ArrayBuffer(8), {
      beforeEventId: 42,
      commit: true,
    });
    const first = JSON.parse(
      await recall.invoke(
        {} as never,
        JSON.stringify({ query: 'What changed with Marigold?' }),
      ),
    ) as Record<string, unknown>;
    await expect(
      recall.invoke(
        {} as never,
        JSON.stringify({ query: 'Give me the source for Marigold' }),
      ),
    ).resolves.toContain('already-recalled');

    expect(first).toEqual({
      communalMemory: ['Marigold is accepted.'],
      dataClassification: 'untrusted_user_supplied_context',
      degraded: false,
      historicalContext: [expect.objectContaining({ evidenceForm: 'source' })],
      recentConversation: [
        expect.objectContaining({ content: 'Earlier context.' }),
      ],
      userRequest: 'What changed with Marigold?',
    });
    expect(assemble).toHaveBeenCalledOnce();
    const assembleInput = assemble.mock.calls[0]?.[0];
    if (assembleInput === undefined)
      throw new Error('assembler was not called');
    expect(assembleInput).toMatchObject({
      beforeEventId: 42,
      prompt: 'What changed with Marigold?',
    });
    expect(typeof assembleInput.now).toBe('number');
    expect(state.citations).toEqual(new Set([sourceLink]));
    expect(state.usageUsd).toBe(0.003);

    normalized.sendAudio(new ArrayBuffer(8), { commit: true });
    await recall.invoke(
      {} as never,
      JSON.stringify({ query: 'Give me the source for Marigold' }),
    );
    expect(assemble).toHaveBeenCalledTimes(2);
    database.close();
  });
});

class FakeRealtimeSession extends EventEmitter {
  public readonly close = vi.fn();
  public readonly interrupt = vi.fn();
  public readonly sendAudio = vi.fn();
  public readonly transport = Object.assign(new EventEmitter(), {
    requestResponse: vi.fn(),
  });
  public usage = {
    inputTokens: 0,
    inputTokensDetails: [] as Readonly<Record<string, number>>[],
    outputTokens: 0,
    outputTokensDetails: [] as Readonly<Record<string, number>>[],
  };
}

function preparedRealtimeContext(
  messageId: string,
  usageUsd: number,
): PreparedContext {
  return {
    approximateTokens: 10,
    degraded: false,
    historicalContext: [
      {
        confidence: 0.9,
        evidenceForm: 'source',
        occurredAt: 100,
        provenanceQuality: 'source-backed',
        sourceLinks: [
          `https://discord.com/channels/32345678901234567/22345678901234567/${messageId}`,
        ],
        speakerName: 'President One',
        temporalLabel: 'Jul 14, 2026, 11:00 AM',
        text: 'Context.',
      },
    ],
    memories: [],
    recentConversation: [],
    usageUsd,
  };
}
