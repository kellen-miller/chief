export interface ChiefTextRequest {
  readonly memories?: readonly string[];
  readonly prompt: string;
  readonly requestId: string;
}

export interface ChiefTextAnswer {
  readonly citations: readonly string[];
  readonly content: string;
  readonly usageUsd: number;
}

export interface TranscriptionRequest {
  readonly language: string;
  readonly pcm: ArrayBuffer;
  readonly sampleRate: number;
}

export interface Transcript {
  readonly text: string;
  readonly usageUsd: number;
}

export interface VoiceSessionRequest {
  readonly requestId: string;
}

export type ChiefVoiceEvent =
  | { readonly type: 'ready' }
  | {
      readonly data: ArrayBuffer;
      readonly responseId: string;
      readonly type: 'audio';
    }
  | {
      readonly delta: string;
      readonly responseId: string;
      readonly type: 'transcript-delta';
    }
  | {
      readonly itemId: string;
      readonly text: string;
      readonly type: 'input-transcript';
    }
  | {
      readonly citations?: readonly string[];
      readonly transcript: string;
      readonly type: 'completed';
      readonly usageUsd: number;
    }
  | { readonly type: 'interrupted' }
  | { readonly error: Error; readonly type: 'error' };

export interface ChiefVoiceSession {
  close(): Promise<void>;
  interrupt(): void;
  onEvent(listener: (event: ChiefVoiceEvent) => void): () => void;
  sendAudio(pcm: ArrayBuffer, options?: { readonly commit?: boolean }): void;
}

export interface ChiefAgent {
  answerText(request: ChiefTextRequest): Promise<ChiefTextAnswer>;
  interruptVoice(): void;
  openVoice(request: VoiceSessionRequest): Promise<ChiefVoiceSession>;
  transcribe(request: TranscriptionRequest): Promise<Transcript>;
}
