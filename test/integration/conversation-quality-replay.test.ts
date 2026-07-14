import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type {
  ChiefAgent,
  ChiefTextRequest,
} from '../../src/agent/chief-agent.js';
import {
  ConversationOrchestrator,
  type NormalizedTextTurn,
} from '../../src/app/conversation-orchestrator.js';
import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ContextAssembler } from '../../src/context/context-assembler.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import { qualifyTextMessage } from '../../src/discord/invocation-policy.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

interface ReplayTurn {
  readonly content: string;
  readonly id: string;
}

describe('conversation quality replay', () => {
  it('keeps Teddy constraints through the Polk follow-up', async () => {
    const turns = JSON.parse(
      await readFile(
        new URL('../fixtures/conversation-quality.json', import.meta.url),
        'utf8',
      ),
    ) as ReplayTurn[];
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const vector = new Float32Array(1_536).fill(0.4);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const requests: ChiefTextRequest[] = [];
    const answerText = vi.fn((request: ChiefTextRequest) => {
      requests.push(request);
      expect(request.historicalContext).toEqual([]);
      if (request.prompt.includes('Give Teddy')) {
        return Promise.resolve({
          citations: [],
          content: 'Oregon, New Mexico, Air Force, Navy, and Syracuse.',
          usageUsd: 0.01,
        });
      }
      if (request.prompt.includes('outcomes')) {
        expect(
          request.recentConversation?.map(({ content }) => content),
        ).toEqual(
          expect.arrayContaining([
            'The presidential debate focused on education and foreign policy.',
            expect.stringContaining('Oregon, New Mexico, Air Force'),
            'No military academies for the final pick.',
          ]),
        );
        return Promise.resolve({
          citations: [],
          content: 'Oregon won, New Mexico improved, and Syracuse rebuilt.',
          usageUsd: 0.01,
        });
      }
      expect(request.recentConversation?.map(({ content }) => content)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Oregon, New Mexico, Air Force'),
          'No military academies for the final pick.',
          expect.stringContaining('New Mexico improved'),
        ]),
      );
      expect(request.memories).toContain(
        'The group does not choose military academies.',
      );
      return Promise.resolve({
        citations: [],
        content: 'New Mexico.',
        usageUsd: 0.01,
      });
    });
    const agent: ChiefAgent = {
      answerText,
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const memory = new MemoryService({
      budget,
      embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      estimateUsd: 0.1,
      extract: () =>
        Promise.resolve({
          proposals: [
            {
              action: 'create',
              canonicalText: 'The group does not choose military academies.',
              confidence: 0.99,
              kind: 'preference',
              sensitivity: 'none',
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      store,
    });
    let now = 100;
    let deliveredId = 62_345_678_901_234_567n;
    const conversation = new ConversationStore(database);
    const orchestrator = new ConversationOrchestrator({
      agent,
      assembler: new ContextAssembler({
        channelId: 'main-text',
        conversation,
        database,
        embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
        guildId: 'presidents',
        memory,
        timeZone: 'America/New_York',
      }),
      budget,
      context: new ChannelContextService({
        channelId: 'main-text',
        conversation,
        database,
        guildId: 'presidents',
        now: () => now,
        timeZone: 'America/New_York',
      }),
      conversation,
      memory,
      now: () => now,
    });
    let finalContent = '';

    for (const replay of turns) {
      const qualification = qualifyTextMessage(
        {
          botUserId: 'chief',
          channelId: 'main-text',
          guildId: 'presidents',
        },
        {
          authorIsBot: false,
          channelId: 'main-text',
          content: replay.content,
          guildId: 'presidents',
          isThread: false,
          webhookId: null,
        },
      );
      if (qualification.kind === 'ignore') continue;
      const base = {
        content: qualification.content,
        occurredAt: now,
        platformSourceId: replay.id,
        requestId: replay.id,
        speakerId: 'president-replay',
        speakerName: 'President Replay',
      };
      const turn: NormalizedTextTurn =
        qualification.kind === 'request'
          ? { ...base, kind: 'request', prompt: qualification.prompt }
          : { ...base, kind: qualification.kind };
      const result = await orchestrator.handleText(turn);
      if (result !== null) {
        finalContent = result.content;
        deliveredId += 1n;
        orchestrator.recordDeliveredReply({
          chunks: [
            { content: result.content, messageId: deliveredId.toString() },
          ],
          logicalResponseId: `response-${replay.id}`,
          replyToMessageId: replay.id,
          requestId: replay.id,
        });
      }
      now += 1;
    }

    expect(finalContent).toBe('New Mexico. Mr. President');
    expect(finalContent).not.toMatch(/Air Force|Navy/u);
    expect(requests).toHaveLength(3);
    database.close();
  });
});
