import { describe, expect, it, vi } from 'vitest';

import { VoiceSessionManager } from '../../src/voice/voice-session-manager.js';

describe('VoiceSessionManager', () => {
  it('latches solo eligibility for the whole utterance', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const manager = new VoiceSessionManager({
      disconnect: vi.fn(),
      interrupt: vi.fn(),
      submit,
      transcribe: vi.fn(),
    });
    manager.setHumanCount(1);
    const utterance = manager.beginUtterance('president-1');
    manager.setHumanCount(2);

    await expect(
      manager.completeUtterance(utterance, new ArrayBuffer(8)),
    ).resolves.toMatchObject({ addressed: true });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('transcribes group speech and submits only addressed turns', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const observe = vi.fn(() => ({
      observation: { eventId: 42, platformSourceId: 'voice-source' },
      status: 'persisted' as const,
    }));
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce('Are we meeting?')
      .mockResolvedValueOnce('Chief, are we meeting?');
    const manager = new VoiceSessionManager({
      disconnect: vi.fn(),
      interrupt: vi.fn(),
      observe,
      submit,
      transcribe,
    });
    manager.setHumanCount(2);

    await manager.completeUtterance(
      manager.beginUtterance('president-1'),
      new ArrayBuffer(8),
    );
    await manager.completeUtterance(
      manager.beginUtterance('president-1'),
      new ArrayBuffer(8),
    );

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        humanObservation: {
          eventId: 42,
          platformSourceId: 'voice-source',
        },
      }),
    );
  });

  it('does not submit an addressed turn when observation persistence fails', async () => {
    const submit = vi.fn(() => Promise.resolve());
    const persistenceFailure = vi.fn();
    const manager = new VoiceSessionManager({
      disconnect: vi.fn(),
      interrupt: vi.fn(),
      observe: () => ({ status: 'failed' }),
      persistenceFailure,
      submit,
      transcribe: () => Promise.resolve('Chief, brief us'),
    });
    manager.setHumanCount(2);

    await manager.completeUtterance(
      manager.beginUtterance('president-1'),
      new ArrayBuffer(8),
    );

    expect(submit).not.toHaveBeenCalled();
    expect(persistenceFailure).toHaveBeenCalledOnce();
  });

  it('keeps an ambient persistence failure silent', async () => {
    const persistenceFailure = vi.fn();
    const submit = vi.fn(() => Promise.resolve());
    const manager = new VoiceSessionManager({
      disconnect: vi.fn(),
      interrupt: vi.fn(),
      observe: () => ({ status: 'failed' }),
      persistenceFailure,
      submit,
      transcribe: () => Promise.resolve('The cabinet meets at noon'),
    });
    manager.setHumanCount(2);

    await manager.completeUtterance(
      manager.beginUtterance('president-1'),
      new ArrayBuffer(8),
    );

    expect(submit).not.toHaveBeenCalled();
    expect(persistenceFailure).not.toHaveBeenCalled();
  });

  it('interrupts playback synchronously when any human starts speaking', () => {
    const interrupt = vi.fn();
    const manager = new VoiceSessionManager({
      disconnect: vi.fn(),
      interrupt,
      submit: vi.fn(),
      transcribe: vi.fn(),
    });
    manager.setHumanCount(1);

    manager.beginUtterance('president-1');

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('rejects an invalid participant count', () => {
    const manager = new VoiceSessionManager({
      disconnect: vi.fn(),
      interrupt: vi.fn(),
      submit: vi.fn(),
      transcribe: vi.fn(),
    });
    expect(() => {
      manager.setHumanCount(-1);
    }).toThrow(RangeError);
    expect(() => {
      manager.setHumanCount(1.5);
    }).toThrow(RangeError);
  });
});
