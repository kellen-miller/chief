import type { HistoricalContext } from '../context/context-types.js';

export interface ChiefConversationMessage {
  readonly content: string;
  readonly role: 'human' | 'chief';
  readonly speakerName: string | null;
}

export interface ChiefTextRequest {
  readonly historicalContext?: readonly HistoricalContext[];
  readonly memories?: readonly string[];
  readonly prompt: string;
  readonly recentConversation?: readonly ChiefConversationMessage[];
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
  readonly recentConversation: readonly ChiefConversationMessage[];
  readonly requestId: string;
  readonly speakerId: string;
  readonly speakerName: string;
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
      readonly citations?: readonly string[];
      readonly inputTranscript: string;
      readonly persistenceFailed?: boolean;
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
  sendAudio(
    pcm: ArrayBuffer,
    options?: {
      readonly beforeEventId?: number;
      readonly commit?: boolean;
    },
  ): void;
}

export interface ChiefAgent {
  answerText(request: ChiefTextRequest): Promise<ChiefTextAnswer>;
  interruptVoice(): void;
  openVoice(request: VoiceSessionRequest): Promise<ChiefVoiceSession>;
  transcribe(request: TranscriptionRequest): Promise<Transcript>;
}
