import { describe, expect, it, vi } from 'vitest';

import type {
  ChiefAgent,
  ChiefTextRequest,
  ChiefVoiceEvent,
} from '../../src/agent/chief-agent.js';
import { ConversationOrchestrator } from '../../src/app/conversation-orchestrator.js';
import { UsageBudget } from '../../src/usage/usage-budget.js';

describe('ConversationOrchestrator', () => {
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
    const orchestrator = new ConversationOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const first = orchestrator.handleText({ prompt: 'first', requestId: '1' });
    const second = orchestrator.handleText({
      prompt: 'second',
      requestId: '2',
    });
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
    const orchestrator = new ConversationOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );
    const pending = orchestrator.handleText({ prompt: 'wait', requestId: '1' });
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
    const orchestrator = new ConversationOrchestrator(agent, budget);

    await expect(
      orchestrator.handleText({ prompt: 'research', requestId: '1' }),
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
    const orchestrator = new ConversationOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      {
        retrieve: vi.fn(() =>
          Promise.resolve({
            memories: ['The annual trip is in October.'],
            usageUsd: 0.001,
          }),
        ),
      },
    );

    await orchestrator.handleText({
      prompt: 'When is the trip?',
      requestId: '1',
    });

    expect(answerText).toHaveBeenCalledWith({
      memories: ['The annual trip is in October.'],
      prompt: 'When is the trip?',
      requestId: '1',
    });
  });

  it('streams a budgeted realtime voice response through the normalized seam', async () => {
    let listener: ((event: ChiefVoiceEvent) => void) | undefined;
    const sendAudio = vi.fn();
    const agent: ChiefAgent = {
      answerText: vi.fn(),
      interruptVoice: vi.fn(),
      openVoice: vi.fn(() =>
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
      ),
      transcribe: vi.fn(),
    };
    const audio = vi.fn();
    const orchestrator = new ConversationOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );
    const pending = orchestrator.handleVoice(
      { pcm: new ArrayBuffer(8), requestId: 'voice-1' },
      { audio, transcript: vi.fn() },
    );
    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledOnce();
    });
    listener?.({ data: new ArrayBuffer(4), responseId: 'r1', type: 'audio' });
    listener?.({
      transcript: 'Certainly, Mr. President',
      type: 'completed',
      usageUsd: 0.01,
    });

    await expect(pending).resolves.toMatchObject({ status: 'completed' });
    expect(audio).toHaveBeenCalledOnce();
    expect(sendAudio).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      commit: true,
    });
  });

  it('accounts conservatively for failed text and transcription calls', async () => {
    const agent: ChiefAgent = {
      answerText: () => Promise.reject(new Error('provider failed')),
      interruptVoice: vi.fn(),
      openVoice: vi.fn(),
      transcribe: () => Promise.reject(new Error('provider failed')),
    };
    const budget = new UsageBudget({ ceilingUsd: 10, warningUsd: 5 });
    const orchestrator = new ConversationOrchestrator(agent, budget);

    await expect(
      orchestrator.handleText({ prompt: 'fail', requestId: 'text-fail' }),
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
    const orchestrator = new ConversationOrchestrator(agent, budget);
    await expect(
      orchestrator.transcribeVoice(new ArrayBuffer(2)),
    ).resolves.toBe('Chief, hello');
    budget.recordActual(0.99);
    await expect(
      orchestrator.handleVoice(
        { pcm: new ArrayBuffer(2), requestId: 'paused' },
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
    const orchestrator = new ConversationOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    await expect(
      orchestrator.handleVoice(
        { pcm: new ArrayBuffer(2), requestId: 'interrupted' },
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
    const orchestrator = new ConversationOrchestrator(
      agent,
      new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
    );

    const result = orchestrator.handleVoice(
      { pcm: new ArrayBuffer(2), requestId: 'stuck' },
      { audio: vi.fn(), transcript: vi.fn() },
    );
    const text = orchestrator.handleText({
      prompt: 'still there?',
      requestId: 'after-stuck-turn',
    });
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
      const orchestrator = new ConversationOrchestrator(
        agent,
        new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      );
      const voice = orchestrator.handleVoice(
        { pcm: new ArrayBuffer(2), requestId: 'stuck-connect' },
        { audio: vi.fn(), transcript: vi.fn() },
      );
      const text = orchestrator.handleText({
        prompt: 'still there?',
        requestId: 'after-stuck-connect',
      });

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
      const orchestrator = new ConversationOrchestrator(
        agent,
        new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      );

      await expect(
        orchestrator.handleVoice(
          { pcm: new ArrayBuffer(130_000), requestId: 'serialization-fail' },
          { audio: vi.fn(), transcript: vi.fn() },
        ),
      ).resolves.toMatchObject({ status: 'failed' });
      await expect(
        orchestrator.handleText({
          prompt: 'still there?',
          requestId: 'after-serialization-fail',
        }),
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
      const orchestrator = new ConversationOrchestrator(
        agent,
        new UsageBudget({ ceilingUsd: 10, warningUsd: 5 }),
      );
      const transcription = orchestrator.transcribeVoice(new ArrayBuffer(2));
      const text = orchestrator.handleText({
        prompt: 'still there?',
        requestId: 'after-stuck-transcription',
      });

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(transcription).resolves.toBeNull();
      await expect(text).resolves.toMatchObject({ status: 'completed' });
      expect(answerText).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
