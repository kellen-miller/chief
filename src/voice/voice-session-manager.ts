import type { ParticipantMode, VoiceQualification } from './addressing.js';
import { latchParticipantMode, qualifyVoiceTranscript } from './addressing.js';

export interface VoiceUtterance {
  readonly mode: ParticipantMode;
  readonly speakerId: string;
}

export interface HumanVoiceObservation {
  readonly eventId: number;
  readonly platformSourceId: string;
}

export interface SubmittedVoiceTurn {
  readonly humanObservation?: HumanVoiceObservation;
  readonly pcm: ArrayBuffer;
  readonly speakerId: string;
  readonly transcript?: string;
}

export interface VoiceSessionDependencies {
  readonly disconnect: () => void;
  readonly interrupt: () => void;
  readonly persistenceFailure?: () => void;
  readonly observe?: (turn: {
    readonly speakerId: string;
    readonly transcript: string;
  }) =>
    | {
        readonly observation: HumanVoiceObservation;
        readonly status: 'persisted';
      }
    | { readonly status: 'failed' }
    | undefined;
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
    const observed = this.#dependencies.observe?.({
      speakerId: utterance.speakerId,
      transcript,
    });
    const qualification = qualifyVoiceTranscript(utterance.mode, transcript);
    if (observed?.status === 'failed') {
      if (qualification.addressed) {
        this.#dependencies.persistenceFailure?.();
      }
      return qualification;
    }
    if (qualification.addressed) {
      await this.#dependencies.submit({
        pcm,
        speakerId: utterance.speakerId,
        transcript,
        ...(observed?.status !== 'persisted'
          ? {}
          : { humanObservation: observed.observation }),
      });
    }
    return qualification;
  }
}
