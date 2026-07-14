import { describe, expect, it, vi } from 'vitest';

import type { ChiefAgent } from '../../src/agent/chief-agent.js';
import { ConversationOrchestrator } from '../../src/app/conversation-orchestrator.js';
import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ContextAssembler } from '../../src/context/context-assembler.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

describe('ConversationOrchestrator prepared context', () => {
  it('answers from readable context when live indexing fails', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    conversation.record({
      content: 'The launch date is Friday.',
      medium: 'text',
      occurredAt: 800,
      platformEventId: '52345678901234558',
      requestId: null,
      retentionDeadline: 10_000,
      role: 'human',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
    });
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const answerText = vi.fn<ChiefAgent['answerText']>(() =>
      Promise.resolve({
        citations: [],
        content: 'Friday',
        usageUsd: 0.01,
      }),
    );
    const memory = new MemoryService({
      budget,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const context = new ChannelContextService({
      channelId: '22345678901234567',
      conversation,
      database,
      guildId: '32345678901234567',
      now: () => 1_000,
      timeZone: 'America/New_York',
    });
    vi.spyOn(context, 'apply').mockImplementation(() => {
      throw new Error('FTS unavailable');
    });
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      assembler: new ContextAssembler({
        channelId: '22345678901234567',
        conversation,
        database,
        embed: () =>
          Promise.resolve({
            embedding: new Float32Array(1_536).fill(0.25),
            usageUsd: 0.001,
          }),
        guildId: '32345678901234567',
        memory,
        timeZone: 'America/New_York',
      }),
      budget,
      context,
      conversation,
      memory,
      now: () => 1_000,
    });

    await expect(
      orchestrator.handleText({
        content: 'Chief, when is launch?',
        kind: 'request',
        occurredAt: 900,
        platformSourceId: '52345678901234559',
        prompt: 'when is launch?',
        requestId: '52345678901234559',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
      }),
    ).resolves.toEqual({
      citations: [],
      content: 'Friday Mr. President',
      status: 'completed',
    });
    expect(answerText).toHaveBeenCalledWith(
      expect.objectContaining({
        recentConversation: [
          expect.objectContaining({ content: 'The launch date is Friday.' }),
        ],
      }),
    );
    database.close();
  });

  it('keeps lost-thread behavior when recent history cannot be read', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const answerText = vi.fn<ChiefAgent['answerText']>();
    const memory = new MemoryService({
      budget,
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const assembler = new ContextAssembler({
      channelId: '22345678901234567',
      conversation,
      database,
      embed: () =>
        Promise.resolve({
          embedding: new Float32Array(1_536).fill(0.25),
          usageUsd: 0.001,
        }),
      guildId: '32345678901234567',
      memory,
      timeZone: 'America/New_York',
    });
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      assembler,
      budget,
      context: new ChannelContextService({
        channelId: '22345678901234567',
        conversation,
        database,
        guildId: '32345678901234567',
        now: () => 1_000,
        timeZone: 'America/New_York',
      }),
      conversation,
      memory,
      now: () => 1_000,
    });
    vi.spyOn(conversation, 'recent').mockImplementation(() => {
      throw new Error('database unavailable');
    });

    await expect(
      orchestrator.handleText({
        content: 'Chief, what changed?',
        kind: 'request',
        occurredAt: 900,
        platformSourceId: '52345678901234559',
        prompt: 'what changed?',
        requestId: '52345678901234559',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
      }),
    ).resolves.toEqual({
      citations: [],
      content: 'I lost the thread and could not answer, Mr. President',
      status: 'failed',
    });
    expect(answerText).not.toHaveBeenCalled();
    database.close();
  });

  it('does not assemble context for observation or greeting turns', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const assemble = vi.fn();
    const memory = new MemoryService({
      budget,
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText: vi.fn(),
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      assembler: { assemble },
      budget,
      context: new ChannelContextService({
        channelId: '22345678901234567',
        conversation,
        database,
        guildId: '32345678901234567',
        now: () => 1_000,
        timeZone: 'America/New_York',
      }),
      conversation,
      memory,
      now: () => 1_000,
    });

    await expect(
      orchestrator.handleText({
        content: 'Quiet background context.',
        kind: 'observe',
        occurredAt: 800,
        platformSourceId: '52345678901234560',
        requestId: '52345678901234560',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
      }),
    ).resolves.toBeNull();
    await expect(
      orchestrator.handleText({
        content: '<@chief>',
        kind: 'greeting',
        occurredAt: 900,
        platformSourceId: '52345678901234561',
        requestId: '52345678901234561',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(assemble).not.toHaveBeenCalled();
    database.close();
  });

  it('uses the assembler once and emits only bounded context metrics', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const answerText = vi.fn<ChiefAgent['answerText']>(() =>
      Promise.resolve({
        citations: [],
        content: 'Current answer',
        usageUsd: 0,
      }),
    );
    const assemble = vi.fn(
      (input: {
        readonly beforeEventId?: number;
        readonly now: number;
        readonly prompt: string;
      }) => {
        void input;
        return Promise.resolve({
          approximateTokens: 42,
          degraded: false,
          historicalContext: [
            {
              confidence: 0.9,
              evidenceForm: 'rollup' as const,
              periodEnd: 900,
              periodStart: 800,
              provenanceQuality: 'source-backed' as const,
              sourceLinks: [
                'https://discord.com/channels/32345678901234567/22345678901234567/52345678901234567',
              ],
              summary: 'The group discussed Marigold.',
              temporalLabel: 'Jul 14, 2026',
              tier: 'daily' as const,
            },
          ],
          memories: ['Marigold is an accepted project.'],
          recentConversation: [
            {
              content: 'Earlier discussion.',
              role: 'human' as const,
              speakerName: 'President Test',
            },
          ],
          usageUsd: 0.001,
        });
      },
    );
    const telemetry = vi.fn();
    const memory = new MemoryService({
      budget,
      embed: vi.fn(),
      estimateUsd: 0.1,
      extract: vi.fn(),
      store: new SqliteMemoryStore(database),
    });
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      assembler: { assemble },
      budget,
      context: new ChannelContextService({
        channelId: '22345678901234567',
        conversation,
        database,
        guildId: '32345678901234567',
        now: () => 1_000,
        timeZone: 'America/New_York',
      }),
      conversation,
      memory,
      now: () => 1_000,
      telemetry,
    });

    await expect(
      orchestrator.handleText({
        content: 'Chief, what changed with Marigold?',
        kind: 'request',
        occurredAt: 900,
        platformSourceId: '52345678901234567',
        prompt: 'what changed with Marigold?',
        requestId: '52345678901234567',
        speakerId: '42345678901234567',
        speakerName: 'President Test',
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(assemble).toHaveBeenCalledOnce();
    const assembleInput = assemble.mock.calls[0]?.[0];
    if (assembleInput === undefined)
      throw new Error('assembler was not called');
    expect(assembleInput).toMatchObject({
      now: 1_000,
      prompt: 'what changed with Marigold?',
    });
    expect(typeof assembleInput.beforeEventId).toBe('number');
    expect(answerText).toHaveBeenCalledWith({
      historicalContext: [expect.objectContaining({ tier: 'daily' })],
      memories: ['Marigold is an accepted project.'],
      prompt: 'what changed with Marigold?',
      recentConversation: [
        expect.objectContaining({ content: 'Earlier discussion.' }),
      ],
      requestId: '52345678901234567',
    });
    expect(telemetry).toHaveBeenCalledWith({
      approximateContextTokens: 42,
      degraded: false,
      durableMemoryCount: 1,
      historicalCounts: {
        daily: 1,
        hourly: 0,
        'long-term': 0,
        source: 0,
        weekly: 0,
      },
      recentMessageCount: 1,
      type: 'context-prepared',
    });
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('Marigold');
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('discord.com');
    database.close();
  });
});
