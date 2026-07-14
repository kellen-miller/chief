import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChiefAgent,
  ChiefTextRequest,
  ChiefVoiceEvent,
} from '../../src/agent/chief-agent.js';
import {
  ConversationOrchestrator,
  type ConversationReservationEstimates,
  type NormalizedTextTurn,
  type VoiceTurn,
} from '../../src/app/conversation-orchestrator.js';
import { ChannelContextService } from '../../src/context/channel-context-service.js';
import { ConversationStore } from '../../src/conversation/conversation-store.js';
import {
  migrateChiefDatabase,
  openChiefDatabase,
} from '../../src/memory/database.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { SqliteMemoryStore } from '../../src/memory/memory-store.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';
import type { HumanVoiceObservation } from '../../src/voice/voice-session-manager.js';

let occurredAt = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

function textTurn(input: {
  readonly prompt: string;
  readonly requestId: string;
}): NormalizedTextTurn {
  occurredAt += 1;
  return {
    content: input.prompt,
    kind: 'request',
    occurredAt,
    platformSourceId: input.requestId,
    prompt: input.prompt,
    requestId: input.requestId,
    speakerId: 'president-test',
    speakerName: 'President Test',
  };
}

function voiceTurn(input: {
  readonly groupTranscript?: string;
  readonly humanObservation?: HumanVoiceObservation;
  readonly pcm: ArrayBuffer;
  readonly requestId: string;
  readonly speakerId?: string;
  readonly speakerName?: string;
}): VoiceTurn {
  return {
    ...input,
    speakerId: input.speakerId ?? 'president-test',
    speakerName: input.speakerName ?? 'President Test',
  };
}

function createOrchestrator(
  agent: ChiefAgent,
  budget: UsageBudget,
  memories: readonly string[] = [],
  reservations?: ConversationReservationEstimates,
): ConversationOrchestrator {
  const database = openChiefDatabase(':memory:');
  migrateChiefDatabase(database);
  const store = new SqliteMemoryStore(database);
  const vector = new Float32Array(1_536).fill(0.4);
  for (const canonicalText of memories) {
    store.applyMemory({
      canonicalText,
      confidence: 0.99,
      embedding: vector,
      kind: 'fact',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
  }
  const conversation = new ConversationStore(database);
  return new ConversationOrchestrator({
    agent,
    budget,
    context: createContext(database, conversation, () => occurredAt),
    conversation,
    memory: new MemoryService({
      budget,
      embed: () => Promise.resolve({ embedding: vector, usageUsd: 0.001 }),
      estimateUsd: 0.1,
      extract: () => Promise.resolve({ proposals: [], usageUsd: 0 }),
      store,
    }),
    now: () => occurredAt,
    ...(reservations === undefined ? {} : { reservations }),
  });
}

function createContext(
  database: ReturnType<typeof openChiefDatabase>,
  conversation = new ConversationStore(database),
  now: () => number = () => occurredAt,
): ChannelContextService {
  return new ChannelContextService({
    channelId: 'main-text',
    conversation,
    database,
    guildId: 'presidents',
    now,
    timeZone: 'America/New_York',
  });
}

describe('ConversationOrchestrator', () => {
  it('records no Chief source before Discord delivery', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText: () =>
          Promise.resolve({ citations: [], content: 'Answer', usageUsd: 0.01 }),
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      budget,
      context: createContext(database, undefined, () => 1_000),
      conversation: new ConversationStore(database),
      memory: new MemoryService({
        budget,
        embed: () =>
          Promise.resolve({
            embedding: new Float32Array(1_536),
            usageUsd: 0,
          }),
        estimateUsd: 0.1,
        extract: () => Promise.resolve({ proposals: [], usageUsd: 0 }),
        store,
      }),
      now: () => 1_000,
    });

    await orchestrator.handleText({
      content: 'Chief, answer',
      kind: 'request',
      occurredAt: 500,
      platformSourceId: '52345678901234567',
      prompt: 'answer',
      requestId: '52345678901234567',
      speakerId: '42345678901234567',
      speakerName: 'President Test',
    });

    expect(
      database
        .prepare(
          "select count(*) from conversation_events where role = 'chief'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it('keeps text raw content after recent context expires', async () => {
    const now = Date.UTC(2026, 6, 14, 12);
    occurredAt = now;
    const record = vi.spyOn(ConversationStore.prototype, 'record');
    const orchestrator = createOrchestrator(
      {
        answerText: () =>
          Promise.resolve({ citations: [], content: 'Answer', usageUsd: 0.01 }),
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const result = await orchestrator.handleText({
      content: 'Question',
      kind: 'request',
      occurredAt: now,
      platformSourceId: 'retention-question',
      prompt: 'Question',
      requestId: 'retention-question',
      speakerId: 'president-test',
      speakerName: 'President Test',
    });
    if (result === null) throw new Error('expected a reply');
    orchestrator.recordDeliveredReply({
      chunks: [{ content: result.content, messageId: '62345678901234567' }],
      logicalResponseId: 'retention-response',
      replyToMessageId: 'retention-question',
      requestId: 'retention-question',
    });

    const sevenDays = 7 * 24 * 60 * 60 * 1_000;
    const thirtyDays = 30 * 24 * 60 * 60 * 1_000;
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      recentUntil: now + sevenDays,
      retentionDeadline: now + thirtyDays,
      role: 'human',
    });
    expect(record.mock.calls[1]?.[0]).toMatchObject({
      recentUntil: now + sevenDays,
      retentionDeadline: now + thirtyDays,
      role: 'chief',
    });
    record.mockRestore();
  });

  it('uses seven days for voice recency and raw retention', () => {
    const now = Date.UTC(2026, 6, 14, 12);
    const record = vi.spyOn(ConversationStore.prototype, 'record');
    const orchestrator = createOrchestrator(
      {
        answerText: vi.fn(),
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    orchestrator.observeVoiceTranscript({
      content: 'Voice context',
      occurredAt: now,
      platformSourceId: 'voice-retention',
      speakerId: 'president-test',
      speakerName: 'President Test',
    });

    const sevenDays = 7 * 24 * 60 * 60 * 1_000;
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        recentUntil: now + sevenDays,
        retentionDeadline: now + sevenDays,
      }),
    );
    record.mockRestore();
  });

  it('serializes paid generations in FIFO order', async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let maximumActive = 0;
    const agent: ChiefAgent = {
      answerText: vi.fn(async ({ prompt }: ChiefTextRequest) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { citations: [], content: prompt, usageUsd: 0.01 };
      }),
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const first = orchestrator.handleText(
      textTurn({ prompt: 'first', requestId: '1' }),
    );
    const second = orchestrator.handleText(
      textTurn({
        prompt: 'second',
        requestId: '2',
      }),
    );
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    releases.shift()?.();
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    releases.shift()?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ content: 'first Mr. President' }),
      expect.objectContaining({ content: 'second Mr. President' }),
    ]);
    expect(maximumActive).toBe(1);
  });

  it('interrupts voice out of band while text generation is active', async () => {
    let release: (() => void) | undefined;
    const interruptVoice = vi.fn();
    const agent: ChiefAgent = {
      answerText: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { citations: [], content: 'done', usageUsd: 0.01 };
      },
      interruptVoice,
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );
    const pending = orchestrator.handleText(
      textTurn({ prompt: 'wait', requestId: '1' }),
    );
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });

    orchestrator.interruptActiveVoice();

    expect(interruptVoice).toHaveBeenCalledOnce();
    release?.();
    await pending;
  });

  it('refuses paid work honestly at the ceiling', async () => {
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    budget.recordActual(10);
    const answerText = vi.fn<ChiefAgent['answerText']>();
    const agent: ChiefAgent = {
      answerText,
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(agent, budget);

    await expect(
      orchestrator.handleText(textTurn({ prompt: 'research', requestId: '1' })),
    ).resolves.toEqual({
      citations: [],
      content: 'AI usage is paused until the next UTC month, Mr. President',
      status: 'budget-paused',
    });
    expect(answerText).not.toHaveBeenCalled();
  });

  it('supplies bounded communal memory to the agent', async () => {
    const answerText = vi.fn<ChiefAgent['answerText']>(() =>
      Promise.resolve({ citations: [], content: 'October', usageUsd: 0.01 }),
    );
    const agent: ChiefAgent = {
      answerText,
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      ['The annual trip is in October.'],
    );

    await orchestrator.handleText(
      textTurn({
        prompt: 'When is the trip?',
        requestId: '1',
      }),
    );

    expect(answerText).toHaveBeenCalledWith({
      memories: ['The annual trip is in October.'],
      prompt: 'When is the trip?',
      recentConversation: [],
      requestId: '1',
    });
  });

  it('supplies prior human and Chief turns to a follow-up', async () => {
    const answerText = vi
      .fn<ChiefAgent['answerText']>()
      .mockResolvedValueOnce({
        citations: [],
        content: 'Teddy had five teams.',
        usageUsd: 0.01,
      })
      .mockResolvedValueOnce({
        citations: [],
        content: 'Those outcomes were mixed.',
        usageUsd: 0.01,
      });
    const agent: ChiefAgent = {
      answerText,
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const first = await orchestrator.handleText(
      textTurn({ prompt: 'List Teddy teams', requestId: '1' }),
    );
    if (first === null) throw new Error('expected a reply');
    orchestrator.recordDeliveredReply({
      chunks: [{ content: first.content, messageId: '62345678901234568' }],
      logicalResponseId: 'response-1',
      replyToMessageId: '1',
      requestId: '1',
    });
    await orchestrator.handleText(
      textTurn({ prompt: 'What about those?', requestId: '2' }),
    );

    expect(answerText.mock.calls[1]?.[0]).toMatchObject({
      recentConversation: [
        expect.objectContaining({ content: 'List Teddy teams', role: 'human' }),
        expect.objectContaining({
          content: 'Teddy had five teams. Mr. President',
          role: 'chief',
        }),
      ],
    });
  });

  it('reports a durable-memory database failure as a lost thread', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    vi.spyOn(store, 'retrieve').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const answerText = vi.fn<ChiefAgent['answerText']>();
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      budget,
      context: createContext(database),
      conversation: new ConversationStore(database),
      memory: new MemoryService({
        budget,
        embed: () =>
          Promise.resolve({
            embedding: new Float32Array(1_536).fill(0.4),
            usageUsd: 0.001,
          }),
        estimateUsd: 0.1,
        extract: () => Promise.resolve({ proposals: [], usageUsd: 0 }),
        store,
      }),
    });

    await expect(
      orchestrator.handleText(
        textTurn({ prompt: 'What do you remember?', requestId: 'db-failure' }),
      ),
    ).resolves.toEqual({
      citations: [],
      content: 'I lost the thread and could not answer, Mr. President',
      status: 'failed',
    });
    expect(answerText).not.toHaveBeenCalled();
    database.close();
  });

  it.each([
    {
      content: 'This list Chief remember no military academy',
      expectedExtraction:
        'Explicit communal memory request: no military academy',
      name: 'address before verb',
    },
    {
      content: 'remember Chief ,no military academies',
      expectedExtraction:
        'Explicit communal memory request: no military academies',
      name: 'imperative verb before address',
    },
  ])(
    'acknowledges explicit memory only after commit for $name',
    async ({ content, expectedExtraction }) => {
      const database = openChiefDatabase(':memory:');
      migrateChiefDatabase(database);
      const store = new SqliteMemoryStore(database);
      const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
      const answerText = vi.fn<ChiefAgent['answerText']>();
      const extract = vi.fn(() =>
        Promise.resolve({
          proposals: [
            {
              action: 'create' as const,
              canonicalText: 'Do not choose a military academy.',
              confidence: 0.99,
              kind: 'preference',
              sensitivity: 'none' as const,
              targetMemoryId: null,
            },
          ],
          usageUsd: 0.002,
        }),
      );
      const agent: ChiefAgent = {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      };
      const orchestrator = new ConversationOrchestrator({
        agent,
        budget,
        context: createContext(database),
        conversation: new ConversationStore(database),
        memory: new MemoryService({
          budget,
          embed: () =>
            Promise.resolve({
              embedding: new Float32Array(1_536).fill(0.4),
              usageUsd: 0.001,
            }),
          estimateUsd: 0.1,
          extract,
          store,
        }),
        now: () => 110,
      });

      const result = await orchestrator.handleText({
        content,
        kind: 'request',
        occurredAt: 100,
        platformSourceId: 'explicit-message',
        prompt: content,
        requestId: 'explicit-message',
        speakerId: 'president-1',
        speakerName: 'President Test',
      });

      expect(result).toMatchObject({
        content: 'I have committed that to the record Mr. President',
        status: 'completed',
      });
      expect(
        database.prepare('select canonical_text from memories').pluck().get(),
      ).toBe('Do not choose a military academy.');
      expect(
        database.prepare('select count(*) from memory_jobs').pluck().get(),
      ).toBe(0);
      expect(extract).toHaveBeenCalledWith(
        expect.objectContaining({ content: expectedExtraction }),
      );
      expect(answerText).not.toHaveBeenCalled();
      database.close();
    },
  );

  it('commits imperative correction and forget receipts', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const store = new SqliteMemoryStore(database);
    const originalId = store.applyMemory({
      canonicalText: 'Dinner is at six.',
      confidence: 0.99,
      embedding: new Float32Array(1_536).fill(0.4),
      kind: 'plan',
      provenance: {},
      sourceEventId: null,
      timestamp: 1,
    });
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const answerText = vi.fn<ChiefAgent['answerText']>();
    const extract = vi.fn(() =>
      Promise.resolve({
        proposals: [
          {
            action: 'supersede' as const,
            canonicalText: 'Dinner is at seven.',
            confidence: 0.99,
            kind: 'plan',
            sensitivity: 'none' as const,
            targetMemoryId: originalId,
          },
        ],
        usageUsd: 0.002,
      }),
    );
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: vi.fn(),
      },
      budget,
      context: createContext(database),
      conversation: new ConversationStore(database),
      memory: new MemoryService({
        budget,
        embed: () =>
          Promise.resolve({
            embedding: new Float32Array(1_536).fill(0.4),
            usageUsd: 0.001,
          }),
        estimateUsd: 0.1,
        extract,
        store,
      }),
      now: () => 110,
    });

    await expect(
      orchestrator.handleText({
        content: 'correct Chief, dinner is at seven',
        kind: 'request',
        occurredAt: 100,
        platformSourceId: 'imperative-correct',
        prompt: 'correct Chief, dinner is at seven',
        requestId: 'imperative-correct',
        speakerId: 'president-1',
        speakerName: 'President Test',
      }),
    ).resolves.toMatchObject({
      content: 'I have corrected the record Mr. President',
      status: 'completed',
    });
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'correct Chief, dinner is at seven',
        explicitIntent: 'correct',
      }),
    );
    expect(
      database
        .prepare("select canonical_text from memories where state = 'active'")
        .pluck()
        .all(),
    ).toEqual(['Dinner is at seven.']);

    await expect(
      orchestrator.handleText({
        content: 'forget Chief: dinner is at seven',
        kind: 'request',
        occurredAt: 120,
        platformSourceId: 'imperative-forget',
        prompt: 'forget Chief: dinner is at seven',
        requestId: 'imperative-forget',
        speakerId: 'president-1',
        speakerName: 'President Test',
      }),
    ).resolves.toMatchObject({
      content: 'I have removed that from the record Mr. President',
      status: 'completed',
    });
    expect(
      database
        .prepare("select count(*) from memories where state = 'active'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(store.findLexical('dinner', 1)).toEqual([]);
    expect(
      database.prepare('select count(*) from memory_jobs').pluck().get(),
    ).toBe(0);
    expect(answerText).not.toHaveBeenCalled();
    database.close();
  });

  it('streams a budgeted realtime voice response through the normalized seam', async () => {
    let listener: ((event: ChiefVoiceEvent) => void) | undefined;
    const sendAudio = vi.fn();
    const answerText = vi.fn(() =>
      Promise.resolve({ citations: [], content: 'Follow-up', usageUsd: 0.01 }),
    );
    const openVoice = vi.fn<ChiefAgent['openVoice']>(() =>
      Promise.resolve({
        close: () => Promise.resolve(),
        interrupt: vi.fn(),
        onEvent: (next: (event: ChiefVoiceEvent) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        sendAudio,
      }),
    );
    const agent: ChiefAgent = {
      answerText,
      interruptVoice: vi.fn(),
      openVoice,
      transcribe: vi.fn(),
    };
    const audio = vi.fn();
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );
    const pending = orchestrator.handleVoice(
      voiceTurn({ pcm: new ArrayBuffer(8), requestId: 'voice-1' }),
      { audio, transcript: vi.fn() },
    );
    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledOnce();
    });
    listener?.({ data: new ArrayBuffer(4), responseId: 'r1', type: 'audio' });
    listener?.({
      inputTranscript: 'Chief, brief us',
      transcript: 'Certainly, Mr. President',
      type: 'completed',
      usageUsd: 0.01,
    });

    await expect(pending).resolves.toMatchObject({ status: 'completed' });
    expect(audio).toHaveBeenCalledOnce();
    expect(sendAudio).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      commit: true,
    });
    expect(openVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        recentConversation: [],
        speakerName: 'President Test',
      }),
    );
    await orchestrator.handleText(
      textTurn({
        prompt: 'What did we just discuss?',
        requestId: 'after-voice',
      }),
    );
    expect(answerText).toHaveBeenCalledWith(
      expect.objectContaining({
        recentConversation: [
          expect.objectContaining({
            content: 'Chief, brief us',
            role: 'human',
          }),
          expect.objectContaining({
            content: 'Certainly, Mr. President',
            role: 'chief',
          }),
        ],
      }),
    );

    const secondSpeaker = orchestrator.handleVoice(
      voiceTurn({
        pcm: new ArrayBuffer(8),
        requestId: 'voice-2',
        speakerId: 'president-two',
        speakerName: 'President Two',
      }),
      { audio: vi.fn(), transcript: vi.fn() },
    );
    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledTimes(2);
    });
    listener?.({
      inputTranscript: 'Chief, second speaker here',
      transcript: 'Welcome, Mr. President',
      type: 'completed',
      usageUsd: 0.01,
    });
    await expect(secondSpeaker).resolves.toMatchObject({ status: 'completed' });
    expect(openVoice).toHaveBeenCalledTimes(2);
    expect(openVoice.mock.calls[1]?.[0]).toMatchObject({
      speakerId: 'president-two',
      speakerName: 'President Two',
    });
  });

  it('does not seed an observed group request twice', async () => {
    let listener: ((event: ChiefVoiceEvent) => void) | undefined;
    const openVoice = vi.fn<ChiefAgent['openVoice']>(() =>
      Promise.resolve({
        close: () => Promise.resolve(),
        interrupt: vi.fn(),
        onEvent: (next: (event: ChiefVoiceEvent) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        sendAudio: vi.fn(),
      }),
    );
    const orchestrator = createOrchestrator(
      {
        answerText: vi.fn(),
        interruptVoice: vi.fn(),
        openVoice,
        transcribe: vi.fn(),
      },
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );
    orchestrator.observeVoiceTranscript({
      content: 'The cabinet meets at noon.',
      occurredAt: ++occurredAt,
      platformSourceId: 'earlier-group-turn',
      speakerId: 'president-one',
      speakerName: 'President One',
    });
    const humanEventId = orchestrator.observeVoiceTranscript({
      content: 'Chief, when does the cabinet meet?',
      occurredAt: ++occurredAt,
      platformSourceId: 'current-group-turn',
      speakerId: 'president-two',
      speakerName: 'President Two',
    });

    const pending = orchestrator.handleVoice(
      voiceTurn({
        groupTranscript: 'Chief, when does the cabinet meet?',
        humanObservation: {
          eventId: humanEventId,
          platformSourceId: 'current-group-turn',
        },
        pcm: new ArrayBuffer(8),
        requestId: 'group-request',
        speakerId: 'president-two',
        speakerName: 'President Two',
      }),
      { audio: vi.fn(), transcript: vi.fn() },
    );
    await vi.waitFor(() => {
      expect(openVoice).toHaveBeenCalledOnce();
    });
    expect(openVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        recentConversation: [
          expect.objectContaining({
            content: 'The cabinet meets at noon.',
            role: 'human',
          }),
        ],
      }),
    );
    listener?.({
      inputTranscript: 'Chief, when does the cabinet meet?',
      transcript: 'At noon, Mr. President',
      type: 'completed',
      usageUsd: 0.01,
    });
    await expect(pending).resolves.toMatchObject({ status: 'completed' });
  });

  it('reports a voice history database failure as a lost thread', async () => {
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    vi.spyOn(conversation, 'recent').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const openVoice = vi.fn<ChiefAgent['openVoice']>();
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText: vi.fn(),
        interruptVoice: vi.fn(),
        openVoice,
        transcribe: vi.fn(),
      },
      budget,
      context: createContext(database, conversation),
      conversation,
      memory: new MemoryService({
        budget,
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: new SqliteMemoryStore(database),
      }),
    });

    await expect(
      orchestrator.handleVoice(
        voiceTurn({ pcm: new ArrayBuffer(8), requestId: 'voice-db-failure' }),
        { audio: vi.fn(), transcript: vi.fn() },
      ),
    ).resolves.toMatchObject({ status: 'lost-thread' });
    expect(openVoice).not.toHaveBeenCalled();
    database.close();
  });

  it('reports a voice reply persistence failure as a lost thread', async () => {
    let listener: ((event: ChiefVoiceEvent) => void) | undefined;
    const database = openChiefDatabase(':memory:');
    migrateChiefDatabase(database);
    const conversation = new ConversationStore(database);
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const orchestrator = new ConversationOrchestrator({
      agent: {
        answerText: vi.fn(),
        interruptVoice: vi.fn(),
        openVoice: () =>
          Promise.resolve({
            close: () => Promise.resolve(),
            interrupt: vi.fn(),
            onEvent: (next) => {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            sendAudio: vi.fn(),
          }),
        transcribe: vi.fn(),
      },
      budget,
      context: createContext(database, conversation),
      conversation,
      memory: new MemoryService({
        budget,
        embed: vi.fn(),
        estimateUsd: 0.1,
        extract: vi.fn(),
        store: new SqliteMemoryStore(database),
      }),
    });
    vi.spyOn(conversation, 'recordBatch').mockImplementation(() => {
      throw new Error('database unavailable');
    });

    const pending = orchestrator.handleVoice(
      voiceTurn({ pcm: new ArrayBuffer(8), requestId: 'voice-write-failure' }),
      { audio: vi.fn(), transcript: vi.fn() },
    );
    await vi.waitFor(() => {
      expect(listener).toBeTypeOf('function');
    });
    listener?.({
      inputTranscript: 'Chief, brief us',
      transcript: 'Certainly, Mr. President',
      type: 'completed',
      usageUsd: 0.01,
    });

    await expect(pending).resolves.toMatchObject({ status: 'lost-thread' });
    database.close();
  });

  it('maps a realtime memory database failure to a lost thread', async () => {
    let listener: ((event: ChiefVoiceEvent) => void) | undefined;
    const close = vi.fn(() => Promise.resolve());
    const orchestrator = createOrchestrator(
      {
        answerText: vi.fn(),
        interruptVoice: vi.fn(),
        openVoice: () =>
          Promise.resolve({
            close,
            interrupt: vi.fn(),
            onEvent: (next) => {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            sendAudio: vi.fn(),
          }),
        transcribe: vi.fn(),
      },
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const pending = orchestrator.handleVoice(
      voiceTurn({ pcm: new ArrayBuffer(8), requestId: 'voice-memory-failure' }),
      { audio: vi.fn(), transcript: vi.fn() },
    );
    await vi.waitFor(() => {
      expect(listener).toBeTypeOf('function');
    });
    listener?.({
      inputTranscript: 'Chief, what do you remember?',
      persistenceFailed: true,
      transcript: '',
      type: 'completed',
      usageUsd: 0.01,
    });

    await expect(pending).resolves.toMatchObject({ status: 'lost-thread' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('accounts conservatively for failed text and transcription calls', async () => {
    const agent: ChiefAgent = {
      answerText: () => Promise.reject(new Error('provider failed')),
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: () => Promise.reject(new Error('provider failed')),
    };
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const orchestrator = createOrchestrator(agent, budget);

    await expect(
      orchestrator.handleText(
        textTurn({ prompt: 'fail', requestId: 'text-fail' }),
      ),
    ).resolves.toMatchObject({ status: 'failed' });
    await expect(
      orchestrator.transcribeVoice(new ArrayBuffer(2)),
    ).resolves.toBeNull();
    expect(budget.snapshot().actualUsd).toBe(0.3);
  });

  it('returns successful transcription and budget-paused voice locally', async () => {
    const budget = new UsageBudget({ ceilingUsd: 1, warningUsd: 0.5 });
    const agent: ChiefAgent = {
      answerText: vi.fn(),
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: () =>
        Promise.resolve({ text: 'Chief, hello', usageUsd: 0.01 }),
    };
    const orchestrator = createOrchestrator(agent, budget);
    await expect(
      orchestrator.transcribeVoice(new ArrayBuffer(2)),
    ).resolves.toBe('Chief, hello');
    budget.recordActual(0.99);
    await expect(
      orchestrator.handleVoice(
        voiceTurn({ pcm: new ArrayBuffer(2), requestId: 'paused' }),
        { audio: vi.fn(), transcript: vi.fn() },
      ),
    ).resolves.toEqual({
      citations: [],
      inputTranscript: '',
      status: 'budget-paused',
      transcript: '',
    });
  });

  it('settles an interrupted voice turn and closes the cached session', async () => {
    let listener: ((event: ChiefVoiceEvent) => void) | undefined;
    const close = vi.fn(() => Promise.resolve());
    const agent: ChiefAgent = {
      answerText: vi.fn(),
      interruptVoice: vi.fn(),
      openVoice: () =>
        Promise.resolve({
          close,
          interrupt: vi.fn(),
          onEvent: (next) => {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          sendAudio: () => {
            queueMicrotask(() => listener?.({ type: 'interrupted' }));
          },
        }),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    await expect(
      orchestrator.handleVoice(
        voiceTurn({ pcm: new ArrayBuffer(2), requestId: 'interrupted' }),
        { audio: vi.fn(), transcript: vi.fn() },
      ),
    ).resolves.toMatchObject({ status: 'interrupted' });
    await orchestrator.shutdown();
    expect(close).toHaveBeenCalledOnce();
  });

  it('times out and closes a voice turn that never emits a terminal event', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => Promise.resolve());
    const interrupt = vi.fn(() => {
      throw new Error('provider cleanup failed');
    });
    const agent: ChiefAgent = {
      answerText: () =>
        Promise.resolve({ citations: [], content: 'online', usageUsd: 0.01 }),
      interruptVoice: vi.fn(),
      openVoice: () =>
        Promise.resolve({
          close,
          interrupt,
          onEvent: () => () => undefined,
          sendAudio: vi.fn(),
        }),
      transcribe: vi.fn(),
    };
    const orchestrator = createOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const result = orchestrator.handleVoice(
      voiceTurn({ pcm: new ArrayBuffer(2), requestId: 'stuck' }),
      { audio: vi.fn(), transcript: vi.fn() },
    );
    const text = orchestrator.handleText(
      textTurn({
        prompt: 'still there?',
        requestId: 'after-stuck-turn',
      }),
    );
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(result).resolves.toMatchObject({ status: 'failed' });
    await expect(text).resolves.toMatchObject({ status: 'completed' });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('releases the FIFO when opening a voice session times out', async () => {
    vi.useFakeTimers();
    try {
      const answerText = vi.fn(() =>
        Promise.resolve({ citations: [], content: 'online', usageUsd: 0.01 }),
      );
      const agent: ChiefAgent = {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: () => new Promise(() => undefined),
        transcribe: vi.fn(),
      };
      const orchestrator = createOrchestrator(
        agent,
        new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      );
      const voice = orchestrator.handleVoice(
        voiceTurn({ pcm: new ArrayBuffer(2), requestId: 'stuck-connect' }),
        { audio: vi.fn(), transcript: vi.fn() },
      );
      const text = orchestrator.handleText(
        textTurn({
          prompt: 'still there?',
          requestId: 'after-stuck-connect',
        }),
      );

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(voice).resolves.toMatchObject({ status: 'failed' });
      await expect(text).resolves.toMatchObject({ status: 'completed' });
      expect(answerText).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up a turn when synchronous audio serialization fails', async () => {
    vi.useFakeTimers();
    try {
      const answerText = vi.fn(() =>
        Promise.resolve({ citations: [], content: 'online', usageUsd: 0.01 }),
      );
      const close = vi.fn(() => Promise.resolve());
      const agent: ChiefAgent = {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: () =>
          Promise.resolve({
            close,
            interrupt: vi.fn(),
            onEvent: () => () => undefined,
            sendAudio: () => {
              throw new RangeError('Maximum call stack size exceeded');
            },
          }),
        transcribe: vi.fn(),
      };
      const orchestrator = createOrchestrator(
        agent,
        new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      );

      await expect(
        orchestrator.handleVoice(
          voiceTurn({
            pcm: new ArrayBuffer(130_000),
            requestId: 'serialization-fail',
          }),
          { audio: vi.fn(), transcript: vi.fn() },
        ),
      ).resolves.toMatchObject({ status: 'failed' });
      await expect(
        orchestrator.handleText(
          textTurn({
            prompt: 'still there?',
            requestId: 'after-serialization-fail',
          }),
        ),
      ).resolves.toMatchObject({ status: 'completed' });
      await vi.advanceTimersByTimeAsync(90_000);

      expect(vi.getTimerCount()).toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(answerText).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the FIFO when transcription times out', async () => {
    vi.useFakeTimers();
    try {
      const answerText = vi.fn(() =>
        Promise.resolve({ citations: [], content: 'online', usageUsd: 0.01 }),
      );
      const agent: ChiefAgent = {
        answerText,
        interruptVoice: vi.fn(),
        openVoice: vi.fn(),
        transcribe: () => new Promise(() => undefined),
      };
      const orchestrator = createOrchestrator(
        agent,
        new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      );
      const transcription = orchestrator.transcribeVoice(new ArrayBuffer(2));
      const text = orchestrator.handleText(
        textTurn({
          prompt: 'still there?',
          requestId: 'after-stuck-transcription',
        }),
      );

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(transcription).resolves.toBeNull();
      await expect(text).resolves.toMatchObject({ status: 'completed' });
      expect(answerText).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
