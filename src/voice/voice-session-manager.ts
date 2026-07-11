import type { ParticipantMode, VoiceQualification } from './addressing.js';
import { latchParticipantMode, qualifyVoiceTranscript } from './addressing.js';

export interface VoiceUtterance {
  readonly mode: ParticipantMode;
  readonly speakerId: string;
}

export interface SubmittedVoiceTurn {
  readonly pcm: ArrayBuffer;
  readonly speakerId: string;
  readonly transcript?: string;
}

export interface VoiceSessionDependencies {
  readonly disconnect: () => void;
  readonly interrupt: () => void;
  readonly observe?: (turn: {
    readonly speakerId: string;
    readonly transcript: string;
  }) => void;
  readonly submit: (turn: SubmittedVoiceTurn) => Promise<void>;
  readonly transcribe: (pcm: ArrayBuffer) => Promise<string>;
}

export class VoiceSessionManager {
  readonly #dependencies: VoiceSessionDependencies;
  #humanCount = 0;

  public constructor(dependencies: VoiceSessionDependencies) {
    this.#dependencies = dependencies;
  }

  public setHumanCount(count: number): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError('human participant count must be non-negative');
    }
    this.#humanCount = count;
  }

  public beginUtterance(speakerId: string): VoiceUtterance {
    this.#dependencies.interrupt();
    return {
      mode: latchParticipantMode(this.#humanCount),
      speakerId,
    };
  }

  public async completeUtterance(
    utterance: VoiceUtterance,
    pcm: ArrayBuffer,
  ): Promise<VoiceQualification> {
    if (utterance.mode === 'solo') {
      await this.#dependencies.submit({ pcm, speakerId: utterance.speakerId });
      return { addressed: true, prompt: '' };
    }

    const transcript = await this.#dependencies.transcribe(pcm);
    this.#dependencies.observe?.({
      speakerId: utterance.speakerId,
      transcript,
    });
    const qualification = qualifyVoiceTranscript(utterance.mode, transcript);
    if (qualification.addressed) {
      await this.#dependencies.submit({
        pcm,
        speakerId: utterance.speakerId,
        transcript,
      });
    }
    return qualification;
  }
}
