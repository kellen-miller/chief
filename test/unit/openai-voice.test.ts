import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  calculateRealtimeCost,
  calculateTranscriptionCost,
  createRealtimeResearchTool,
  createRealtimeSessionOptions,
  NormalizedRealtimeSession,
} from '../../src/agent/openai-voice.js';
import type { ChiefVoiceEvent } from '../../src/agent/chief-agent.js';

describe('OpenAI voice pricing', () => {
  it('prices realtime audio and text tokens by modality', () => {
    expect(
      calculateRealtimeCost(
        {
          inputTokens: 1_000,
          inputTokensDetails: [
            { audio_tokens: 800, cached_tokens: 100, text_tokens: 200 },
          ],
          outputTokens: 500,
          outputTokensDetails: [{ audio_tokens: 400, text_tokens: 100 }],
        },
        {
          audioInputPerMillionUsd: 10,
          audioOutputPerMillionUsd: 20,
          textInputPerMillionUsd: 0.6,
          textOutputPerMillionUsd: 2.4,
        },
      ),
    ).toBeCloseTo(0.01636, 8);
  });

  it('conservatively prices undocumented realtime details as audio', () => {
    expect(
      calculateRealtimeCost(
        {
          inputTokens: 1_000,
          inputTokensDetails: [],
          outputTokens: 500,
          outputTokensDetails: [],
        },
        {
          audioInputPerMillionUsd: 10,
          audioOutputPerMillionUsd: 20,
          textInputPerMillionUsd: 0.6,
          textOutputPerMillionUsd: 2.4,
        },
      ),
    ).toBe(0.02);
  });

  it('prices transcription tokens and falls back to duration', () => {
    const pricing = {
      fallbackPerMinuteUsd: 0.003,
      inputPerMillionUsd: 1.25,
      outputPerMillionUsd: 5,
    };
    expect(
      calculateTranscriptionCost(
        { input_tokens: 2_000, output_tokens: 100, type: 'tokens' },
        30,
        pricing,
      ),
    ).toBe(0.003);
    expect(calculateTranscriptionCost(undefined, 30, pricing)).toBe(0.0015);
    expect(calculateTranscriptionCost({ type: 'tokens' }, 30, pricing)).toBe(0);
    expect(calculateTranscriptionCost({ type: 'duration' }, 30, pricing)).toBe(
      0.0015,
    );
    expect(
      calculateTranscriptionCost(
        { seconds: 60, type: 'duration' },
        30,
        pricing,
      ),
    ).toBe(0.003);
  });

  it('accepts camel-case modality details and prices unclassified tokens as audio', () => {
    expect(
      calculateRealtimeCost(
        {
          inputTokens: 100,
          inputTokensDetails: [{ audioTokens: 40, textTokens: 30 }],
          outputTokens: 100,
          outputTokensDetails: [{ audioTokens: 50, textTokens: 50 }],
        },
        {
          audioInputPerMillionUsd: 10,
          audioOutputPerMillionUsd: 20,
          textInputPerMillionUsd: 1,
          textOutputPerMillionUsd: 2,
        },
      ),
    ).toBeCloseTo(0.00183);
  });
});

describe('NormalizedRealtimeSession', () => {
  it('normalizes transport events, usage deltas, and controls', async () => {
    vi.useFakeTimers();
    const session = new FakeRealtimeSession();
    const research = {
      citations: new Set(['https://example.com/source']),
      usageUsd: 0.01,
    };
    const normalized = new NormalizedRealtimeSession(
      session as never,
      {
        audioInputPerMillionUsd: 10,
        audioOutputPerMillionUsd: 20,
        textInputPerMillionUsd: 0.6,
        textOutputPerMillionUsd: 2.4,
      },
      research,
    );
    const events: ChiefVoiceEvent[] = [];
    const unsubscribe = normalized.onEvent((event) => events.push(event));

    normalized.ready();
    session.emit('audio', { data: new ArrayBuffer(2), responseId: 'r1' });
    session.transport.emit('audio_transcript_delta', {
      delta: 'Mr. President',
      responseId: 'r1',
    });
    session.emit('transport_event', {
      item_id: 'item-1',
      transcript: 'Chief, hello',
      type: 'conversation.item.input_audio_transcription.completed',
    });
    session.emit('transport_event', { type: 'unrelated' });
    session.usage = {
      inputTokens: 1_000,
      inputTokensDetails: [{ audio_tokens: 1_000 }],
      outputTokens: 500,
      outputTokensDetails: [{ audio_tokens: 500 }],
    };
    session.emit('audio_stopped');
    await vi.advanceTimersByTimeAsync(50);
    session.emit('audio_stopped');
    await vi.advanceTimersByTimeAsync(50);
    session.emit('audio_stopped');
    session.emit('audio_interrupted');
    await vi.advanceTimersByTimeAsync(50);
    session.emit('error', { error: 'transport failed' });
    session.emit('error', { error: new Error('provider failed') });
    normalized.sendAudio(new ArrayBuffer(4), { commit: true });
    normalized.interrupt();
    await normalized.close();
    unsubscribe();
    normalized.ready();
    vi.useRealTimers();

    expect(events.map((event) => event.type)).toEqual([
      'ready',
      'audio',
      'transcript-delta',
      'input-transcript',
      'completed',
      'completed',
      'interrupted',
      'error',
      'error',
    ]);
    expect(events[4]).toMatchObject({
      citations: ['https://example.com/source'],
      transcript: 'Mr. President',
      usageUsd: 0.03,
    });
    expect(events[5]).toMatchObject({
      citations: [],
      transcript: '',
      usageUsd: 0,
    });
    expect(session.sendAudio).toHaveBeenCalledOnce();
    expect(session.transport.requestResponse).toHaveBeenCalledOnce();
    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('chunks realistic utterances below the SDK encoder argument limit', () => {
    const session = new FakeRealtimeSession();
    const normalized = new NormalizedRealtimeSession(
      session as never,
      {
        audioInputPerMillionUsd: 1,
        audioOutputPerMillionUsd: 1,
        textInputPerMillionUsd: 1,
        textOutputPerMillionUsd: 1,
      },
      { citations: new Set(), usageUsd: 0 },
    );

    normalized.sendAudio(new ArrayBuffer(130_000), { commit: true });

    const calls = session.sendAudio.mock.calls as [
      ArrayBuffer,
      { readonly commit?: boolean },
    ][];
    expect(calls).toHaveLength(4);
    expect(calls.every(([pcm]) => pcm.byteLength <= 32 * 1024)).toBe(true);
    expect(calls.map(([, options]) => options.commit)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(session.transport.requestResponse).toHaveBeenCalledOnce();
  });

  it('ignores an empty committed utterance', () => {
    const session = new FakeRealtimeSession();
    const normalized = new NormalizedRealtimeSession(
      session as never,
      {
        audioInputPerMillionUsd: 1,
        audioOutputPerMillionUsd: 1,
        textInputPerMillionUsd: 1,
        textOutputPerMillionUsd: 1,
      },
      { citations: new Set(), usageUsd: 0 },
    );

    normalized.sendAudio(new ArrayBuffer(0), { commit: true });

    expect(session.sendAudio).not.toHaveBeenCalled();
    expect(session.transport.requestResponse).not.toHaveBeenCalled();
  });
});

describe('Realtime provider boundaries', () => {
  it('builds a bounded, non-traced audio session configuration', () => {
    expect(
      createRealtimeSessionOptions({
        apiKey: 'test',
        model: 'gpt-realtime-test',
        pricing: {
          audioInputPerMillionUsd: 1,
          audioOutputPerMillionUsd: 1,
          textInputPerMillionUsd: 1,
          textOutputPerMillionUsd: 1,
        },
        request: { requestId: 'voice-1' },
        transcriptionModel: 'transcribe-test',
        voice: 'cedar',
      }),
    ).toMatchObject({
      config: {
        outputModalities: ['audio'],
        providerData: { max_output_tokens: 2_400 },
      },
      groupId: 'voice-1',
      historyStoreAudio: false,
      tracingDisabled: true,
      transport: 'websocket',
    });
  });

  it('executes at most three bounded voice searches and accounts for them', async () => {
    const execute = vi.fn((input: string, signal: AbortSignal) => {
      expect(input).toContain('untrusted evidence');
      expect(signal.aborted).toBe(false);
      return Promise.resolve({
        inputTokens: 1_000,
        output: 'current findings',
        outputTokens: 500,
        valueForCitations: { url: 'https://example.com/source' },
      });
    });
    const state = { citations: new Set<string>(), usageUsd: 0 };
    const researchTool = createRealtimeResearchTool(
      {
        apiKey: 'test',
        model: 'gpt-realtime-test',
        pricing: {
          audioInputPerMillionUsd: 1,
          audioOutputPerMillionUsd: 1,
          textInputPerMillionUsd: 1,
          textOutputPerMillionUsd: 1,
        },
        research: {
          execute,
          model: 'gpt-text-test',
          pricing: {
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 2,
            searchCallUsd: 0.01,
          },
        },
        request: { requestId: 'voice-research' },
        transcriptionModel: 'transcribe-test',
        voice: 'cedar',
      },
      state,
    );

    const results: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(
        await researchTool.invoke(
          {} as never,
          JSON.stringify({ query: `question ${String(index)}` }),
        ),
      );
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(results[3]).toContain('three-search limit');
    expect(state.citations).toEqual(new Set(['https://example.com/source']));
    expect(state.usageUsd).toBeCloseTo(0.036);
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
