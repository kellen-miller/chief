import type { ChiefAgent, ChiefVoiceSession } from '../agent/chief-agent.js';
import { ensureTextSuffix } from '../replies/suffix.js';
import type { UsageBudget } from '../usage/usage-budget.js';

export interface TextTurn {
  readonly prompt: string;
  readonly requestId: string;
}

export interface ConversationResult {
  readonly citations: readonly string[];
  readonly content: string;
  readonly status: 'completed' | 'budget-paused' | 'failed';
}

export interface MemoryContextRetriever {
  retrieve(prompt: string): Promise<{
    readonly memories: readonly string[];
    readonly usageUsd: number;
  }>;
}

export interface VoiceTurn {
  readonly pcm: ArrayBuffer;
  readonly requestId: string;
}

export interface VoiceSink {
  readonly audio: (pcm: ArrayBuffer) => void;
  readonly transcript: (delta: string) => void;
}

export interface VoiceConversationResult {
  readonly citations: readonly string[];
  readonly inputTranscript: string;
  readonly status: 'budget-paused' | 'completed' | 'failed' | 'interrupted';
  readonly transcript: string;
}

export interface ConversationReservationEstimates {
  readonly textUsd: number;
  readonly transcriptionUsd: number;
  readonly voiceUsd: number;
}

const PROVIDER_OPERATION_TIMEOUT_MS = 30_000;

export class ConversationOrchestrator {
  readonly #agent: ChiefAgent;
  readonly #budget: UsageBudget;
  readonly #memory: MemoryContextRetriever | undefined;
  readonly #reservations: ConversationReservationEstimates;
  #queueTail: Promise<void> = Promise.resolve();
  #voiceIdleTimer: ReturnType<typeof setTimeout> | undefined;
  #voiceSession: ChiefVoiceSession | undefined;

  public constructor(
    agent: ChiefAgent,
    budget: UsageBudget,
    memory?: MemoryContextRetriever,
    reservations: ConversationReservationEstimates = {
      textUsd: 0.25,
      transcriptionUsd: 0.05,
      voiceUsd: 0.25,
    },
  ) {
    this.#agent = agent;
    this.#budget = budget;
    this.#memory = memory;
    this.#reservations = reservations;
  }

  public async handleText(turn: TextTurn): Promise<ConversationResult> {
    const reservation = this.#budget.reserve(
      'text-response',
      this.#reservations.textUsd,
    );
    if (!reservation.allowed) {
      return {
        citations: [],
        content: 'AI usage is paused until the next UTC month, Mr. President',
        status: 'budget-paused',
      };
    }

    return this.#enqueue(async () => {
      try {
        const context = await this.#memory?.retrieve(turn.prompt);
        const answer = await this.#agent.answerText(
          context === undefined
            ? turn
            : { ...turn, memories: context.memories },
        );
        this.#budget.reconcile(
          reservation.id,
          answer.usageUsd + (context?.usageUsd ?? 0),
        );
        return {
          citations: answer.citations,
          content: ensureTextSuffix(answer.content),
          status: 'completed',
        };
      } catch {
        this.#budget.reconcile(reservation.id, this.#reservations.textUsd);
        return {
          citations: [],
          content: 'I could not complete that request, Mr. President',
          status: 'failed',
        };
      }
    });
  }

  public interruptActiveVoice(): void {
    this.#agent.interruptVoice();
  }

  public get aiPaused(): boolean {
    return !this.#budget.canAfford(this.#reservations.transcriptionUsd);
  }

  public async transcribeVoice(pcm: ArrayBuffer): Promise<string | null> {
    const reservation = this.#budget.reserve(
      'voice-transcription',
      this.#reservations.transcriptionUsd,
    );
    if (!reservation.allowed) return null;
    return this.#enqueue(async () => {
      try {
        const transcript = await withDeadline(
          this.#agent.transcribe({
            language: 'en',
            pcm,
            sampleRate: 24_000,
          }),
          PROVIDER_OPERATION_TIMEOUT_MS,
        );
        this.#budget.reconcile(reservation.id, transcript.usageUsd);
        return transcript.text;
      } catch {
        this.#budget.reconcile(
          reservation.id,
          this.#reservations.transcriptionUsd,
        );
        return null;
      }
    });
  }

  public async handleVoice(
    turn: VoiceTurn,
    sink: VoiceSink,
  ): Promise<VoiceConversationResult> {
    const reservation = this.#budget.reserve(
      'voice-response',
      this.#reservations.voiceUsd,
    );
    if (!reservation.allowed) {
      return {
        citations: [],
        inputTranscript: '',
        status: 'budget-paused',
        transcript: '',
      };
    }
    return this.#enqueue(async () => {
      let reconciled = false;
      const reconcile = (actualUsd: number): void => {
        if (reconciled) return;
        reconciled = true;
        this.#budget.reconcile(reservation.id, actualUsd);
      };
      try {
        if (this.#voiceIdleTimer !== undefined) {
          clearTimeout(this.#voiceIdleTimer);
          this.#voiceIdleTimer = undefined;
        }
        this.#voiceSession ??= await withDeadline(
          this.#agent.openVoice({ requestId: turn.requestId }),
          PROVIDER_OPERATION_TIMEOUT_MS,
          (lateSession) => lateSession.close(),
        );
        const session = this.#voiceSession;
        const result = new Promise<VoiceConversationResult>(
          (resolve, reject) => {
            let inputTranscript = '';
            let settled = false;
            let unsubscribe = (): void => undefined;
            const cleanup = (): void => {
              clearTimeout(timeout);
              unsubscribe();
            };
            const fail = (error: unknown): void => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            };
            const finish = (
              status: VoiceConversationResult['status'],
              transcript: string,
              usageUsd: number,
              citations: readonly string[] = [],
            ): void => {
              if (settled) return;
              settled = true;
              cleanup();
              reconcile(usageUsd);
              resolve({ citations, inputTranscript, status, transcript });
            };
            const timeout = setTimeout(() => {
              try {
                session.interrupt();
              } catch {
                // The timeout must release the FIFO even if provider cleanup fails.
              }
              finish('failed', '', this.#reservations.voiceUsd);
            }, 90_000);
            timeout.unref();
            unsubscribe = session.onEvent((event) => {
              switch (event.type) {
                case 'audio':
                  sink.audio(event.data);
                  break;
                case 'transcript-delta':
                  sink.transcript(event.delta);
                  break;
                case 'input-transcript':
                  inputTranscript = event.text;
                  break;
                case 'completed':
                  finish(
                    'completed',
                    event.transcript,
                    event.usageUsd,
                    event.citations ?? [],
                  );
                  break;
                case 'interrupted':
                  finish('interrupted', '', this.#reservations.voiceUsd);
                  break;
                case 'error':
                  finish('failed', '', this.#reservations.voiceUsd);
                  break;
                default:
                  break;
              }
            });
            try {
              session.sendAudio(turn.pcm, { commit: true });
            } catch (error) {
              fail(error);
            }
          },
        );
        const completed = await result;
        if (completed.status === 'failed') await this.#closeVoiceSession();
        else this.#scheduleVoiceIdleClose();
        return completed;
      } catch {
        reconcile(this.#reservations.voiceUsd);
        await this.#closeVoiceSession();
        return {
          citations: [],
          inputTranscript: '',
          status: 'failed',
          transcript: '',
        };
      }
    });
  }

  public async shutdown(): Promise<void> {
    await this.#closeVoiceSession();
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#queueTail;
    let release = (): void => undefined;
    this.#queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #closeVoiceSession(): Promise<void> {
    if (this.#voiceIdleTimer !== undefined) {
      clearTimeout(this.#voiceIdleTimer);
      this.#voiceIdleTimer = undefined;
    }
    const session = this.#voiceSession;
    this.#voiceSession = undefined;
    await session?.close();
  }

  #scheduleVoiceIdleClose(): void {
    this.#voiceIdleTimer = setTimeout(() => {
      void this.#closeVoiceSession();
    }, 60_000);
    this.#voiceIdleTimer.unref();
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onLateResult?: (value: T) => Promise<void>,
): Promise<T> {
  let expired = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error('provider operation timed out'));
    }, timeoutMs);
    timer.unref();
    void operation
      .finally(() => {
        clearTimeout(timer);
      })
      .catch(() => undefined);
  });
  const watched = operation.then((value) => {
    if (expired && onLateResult !== undefined) {
      void onLateResult(value).catch(() => undefined);
    }
    return value;
  });
  return Promise.race([watched, timeout]);
}
