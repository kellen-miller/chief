import type {
  ChiefAgent,
  ChiefConversationMessage,
  ChiefVoiceSession,
} from '../agent/chief-agent.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import {
  detectExplicitMemoryIntent,
  MemoryPersistenceError,
  type ExplicitMemoryIntent,
  MemoryService,
  type MemoryMutationReceipt,
} from '../memory/memory-service.js';
import type { SourceObservation } from '../memory/memory-store.js';
import { ensureTextSuffix } from '../replies/suffix.js';
import type { UsageBudget } from '../usage/usage-budget.js';
import type { HumanVoiceObservation } from '../voice/voice-session-manager.js';

interface TextTurnBase {
  readonly content: string;
  readonly occurredAt: number;
  readonly platformSourceId: string;
  readonly requestId: string;
  readonly speakerId: string;
  readonly speakerName: string;
}

export type NormalizedTextTurn = TextTurnBase &
  (
    | { readonly kind: 'greeting' }
    | { readonly kind: 'observe' }
    | { readonly kind: 'request'; readonly prompt: string }
  );

export interface ConversationResult {
  readonly citations: readonly string[];
  readonly content: string;
  readonly status: 'completed' | 'budget-paused' | 'failed';
}

export interface VoiceTurn {
  readonly groupTranscript?: string;
  readonly humanObservation?: HumanVoiceObservation;
  readonly pcm: ArrayBuffer;
  readonly requestId: string;
  readonly speakerId: string;
  readonly speakerName: string;
}

export interface VoiceSink {
  readonly audio: (pcm: ArrayBuffer) => void;
  readonly transcript: (delta: string) => void;
}

export interface VoiceConversationResult {
  readonly citations: readonly string[];
  readonly inputTranscript: string;
  readonly status:
    'budget-paused' | 'completed' | 'failed' | 'interrupted' | 'lost-thread';
  readonly transcript: string;
}

export interface ConversationReservationEstimates {
  readonly textUsd: number;
  readonly transcriptionUsd: number;
  readonly voiceUsd: number;
}

export interface ConversationOrchestratorOptions {
  readonly agent: ChiefAgent;
  readonly budget: UsageBudget;
  readonly conversation: ConversationStore;
  readonly memory: MemoryService;
  readonly now?: () => number;
  readonly reservations?: ConversationReservationEstimates;
  readonly telemetry?: (event: ConversationTelemetry) => void;
}

export type ConversationTelemetry =
  | {
      readonly approximateContextTokens: number;
      readonly durableMemoryCount: number;
      readonly recentMessageCount: number;
      readonly type: 'context-prepared';
    }
  | {
      readonly outcome: MemoryMutationReceipt['status'];
      readonly type: 'explicit-memory';
    };

const PROVIDER_OPERATION_TIMEOUT_MS = 30_000;
const CONVERSATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SOURCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class ConversationOrchestrator {
  readonly #agent: ChiefAgent;
  readonly #budget: UsageBudget;
  readonly #conversation: ConversationStore;
  readonly #memory: MemoryService;
  readonly #now: () => number;
  readonly #reservations: ConversationReservationEstimates;
  readonly #telemetry: ((event: ConversationTelemetry) => void) | undefined;
  #queueTail: Promise<void> = Promise.resolve();
  #voiceIdleTimer: ReturnType<typeof setTimeout> | undefined;
  #voiceSession: ChiefVoiceSession | undefined;
  #voiceSpeakerId: string | undefined;

  public constructor(options: ConversationOrchestratorOptions) {
    this.#agent = options.agent;
    this.#budget = options.budget;
    this.#conversation = options.conversation;
    this.#memory = options.memory;
    this.#now = options.now ?? Date.now;
    this.#reservations = options.reservations ?? {
      textUsd: 0.25,
      transcriptionUsd: 0.05,
      voiceUsd: 0.25,
    };
    this.#telemetry = options.telemetry;
  }

  public handleText(
    turn: NormalizedTextTurn,
  ): Promise<ConversationResult | null> {
    let eventId: number;
    let explicit:
      | {
          readonly intent: ExplicitMemoryIntent;
          readonly source: SourceObservation;
          readonly sourceEventId: number;
        }
      | undefined;
    try {
      eventId = this.#conversation.record({
        content: turn.content,
        medium: 'text',
        occurredAt: turn.occurredAt,
        platformEventId: `discord:text:${turn.platformSourceId}`,
        recentUntil: turn.occurredAt + CONVERSATION_RETENTION_MS,
        requestId: turn.requestId,
        retentionDeadline: turn.occurredAt + SOURCE_RETENTION_MS,
        role: 'human',
        speakerId: turn.speakerId,
        speakerName: turn.speakerName,
      });
      const source: SourceObservation = {
        content: turn.content,
        medium: 'text',
        occurredAt: turn.occurredAt,
        platformSourceId: turn.platformSourceId,
        retentionDeadline: turn.occurredAt + SOURCE_RETENTION_MS,
        speakerId: turn.speakerId,
      };
      const intent =
        turn.kind === 'request'
          ? detectExplicitMemoryIntent(turn.content)
          : null;
      if (intent === null) this.#memory.observeAutomatic(source);
      else {
        explicit = {
          intent,
          source,
          sourceEventId: this.#memory.observeExplicit(source),
        };
      }
    } catch {
      return Promise.resolve(this.#lostThread());
    }
    if (turn.kind === 'observe') return Promise.resolve(null);
    if (turn.kind === 'greeting') {
      return Promise.resolve(
        this.#recordLocalReply(
          turn,
          'At your service, Mr. President',
          'completed',
        ),
      );
    }
    if (explicit !== undefined) return this.#handleExplicit(turn, explicit);
    return this.#handlePaidText(turn, eventId);
  }

  #handleExplicit(
    turn: NormalizedTextTurn & { readonly kind: 'request' },
    explicit: {
      readonly intent: ExplicitMemoryIntent;
      readonly source: SourceObservation;
      readonly sourceEventId: number;
    },
  ): Promise<ConversationResult> {
    return this.#enqueue(async () => {
      const receipt = await this.#memory.applyExplicit({
        ...explicit,
        now: this.#now(),
      });
      this.#telemetry?.({ outcome: receipt.status, type: 'explicit-memory' });
      return this.#recordLocalReply(
        turn,
        explicitReceiptContent(receipt),
        receipt.status === 'budget-paused'
          ? 'budget-paused'
          : receipt.status === 'failed'
            ? 'failed'
            : 'completed',
      );
    });
  }

  async #handlePaidText(
    turn: NormalizedTextTurn & { readonly kind: 'request' },
    eventId: number,
  ): Promise<ConversationResult> {
    const reservation = this.#budget.reserve(
      'text-response',
      this.#reservations.textUsd,
    );
    if (!reservation.allowed) {
      return this.#recordLocalReply(
        turn,
        'AI usage is paused until the next UTC month, Mr. President',
        'budget-paused',
      );
    }

    return this.#enqueue(async () => {
      let recent: {
        readonly approximateTokens: number;
        readonly messages: ChiefConversationMessage[];
      };
      try {
        recent = this.#recentConversation(eventId);
      } catch {
        this.#budget.reconcile(reservation.id, this.#reservations.textUsd);
        return this.#lostThread();
      }
      let context: Awaited<ReturnType<MemoryService['recall']>>;
      try {
        context = await this.#memory.recall(turn.prompt);
      } catch (error) {
        this.#budget.reconcile(reservation.id, this.#reservations.textUsd);
        return error instanceof MemoryPersistenceError
          ? this.#lostThread()
          : {
              citations: [],
              content: 'I could not complete that request, Mr. President',
              status: 'failed',
            };
      }
      try {
        this.#telemetry?.({
          approximateContextTokens: recent.approximateTokens,
          durableMemoryCount: context.memories.length,
          recentMessageCount: recent.messages.length,
          type: 'context-prepared',
        });
        const answer = await this.#agent.answerText({
          memories: context.memories,
          prompt: turn.prompt,
          recentConversation: recent.messages,
          requestId: turn.requestId,
        });
        this.#budget.reconcile(
          reservation.id,
          answer.usageUsd + context.usageUsd,
        );
        const result = {
          citations: answer.citations,
          content: ensureTextSuffix(answer.content),
          status: 'completed' as const,
        };
        return this.#recordReply(turn, result);
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

  #recentConversation(beforeEventId?: number): {
    readonly approximateTokens: number;
    readonly messages: ChiefConversationMessage[];
  } {
    const recent = this.#conversation.recent({
      ...(beforeEventId === undefined ? {} : { beforeEventId }),
      now: this.#now(),
    });
    return {
      approximateTokens: recent.approximateTokens,
      messages: recent.events.map(({ content, role, speakerName }) => ({
        content,
        role,
        speakerName,
      })),
    };
  }

  #recordLocalReply(
    turn: NormalizedTextTurn,
    content: string,
    status: ConversationResult['status'],
  ): ConversationResult {
    return this.#recordReply(turn, {
      citations: [],
      content: ensureTextSuffix(content),
      status,
    });
  }

  #recordReply(
    turn: NormalizedTextTurn,
    result: ConversationResult,
  ): ConversationResult {
    try {
      this.#conversation.record({
        content: result.content,
        medium: 'text',
        occurredAt: this.#now(),
        platformEventId: `chief:${turn.requestId}`,
        recentUntil: this.#now() + CONVERSATION_RETENTION_MS,
        requestId: turn.requestId,
        retentionDeadline: this.#now() + SOURCE_RETENTION_MS,
        role: 'chief',
        speakerId: null,
        speakerName: 'Chief',
      });
      return result;
    } catch {
      return this.#lostThread();
    }
  }

  #lostThread(): ConversationResult {
    return {
      citations: [],
      content: 'I lost the thread and could not answer, Mr. President',
      status: 'failed',
    };
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

  public observeVoiceTranscript(input: {
    readonly content: string;
    readonly occurredAt: number;
    readonly platformSourceId: string;
    readonly speakerId: string;
    readonly speakerName: string;
  }): number {
    const eventId = this.#conversation.record({
      content: input.content,
      medium: 'voice',
      occurredAt: input.occurredAt,
      platformEventId: `discord:voice:${input.platformSourceId}`,
      recentUntil: input.occurredAt + CONVERSATION_RETENTION_MS,
      requestId: input.platformSourceId,
      retentionDeadline: input.occurredAt + CONVERSATION_RETENTION_MS,
      role: 'human',
      speakerId: input.speakerId,
      speakerName: input.speakerName,
    });
    this.#memory.observeAutomatic({
      content: input.content,
      medium: 'voice',
      occurredAt: input.occurredAt,
      platformSourceId: input.platformSourceId,
      retentionDeadline: input.occurredAt + CONVERSATION_RETENTION_MS,
      speakerId: input.speakerId,
    });
    return eventId;
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
        if (
          this.#voiceSession !== undefined &&
          this.#voiceSpeakerId !== turn.speakerId
        ) {
          await this.#closeVoiceSession();
        }
        let recentConversation: ChiefConversationMessage[];
        try {
          recentConversation = this.#recentConversation(
            turn.humanObservation?.eventId,
          ).messages;
        } catch {
          reconcile(this.#reservations.voiceUsd);
          return this.#lostVoiceThread();
        }
        this.#voiceSession ??= await withDeadline(
          this.#agent.openVoice({
            recentConversation,
            requestId: turn.requestId,
            speakerId: turn.speakerId,
            speakerName: turn.speakerName,
          }),
          PROVIDER_OPERATION_TIMEOUT_MS,
          (lateSession) => lateSession.close(),
        );
        this.#voiceSpeakerId = turn.speakerId;
        const session = this.#voiceSession;
        const result = new Promise<VoiceConversationResult>(
          (resolve, reject) => {
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
              inputTranscript: string,
              transcript: string,
              usageUsd: number,
              citations: readonly string[] = [],
            ): void => {
              if (settled) return;
              settled = true;
              cleanup();
              reconcile(usageUsd);
              resolve({
                citations,
                inputTranscript:
                  status === 'completed'
                    ? (turn.groupTranscript ?? inputTranscript)
                    : '',
                status,
                transcript,
              });
            };
            const timeout = setTimeout(() => {
              try {
                session.interrupt();
              } catch {
                // The timeout must release the FIFO even if provider cleanup fails.
              }
              finish('failed', '', '', this.#reservations.voiceUsd);
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
                case 'completed':
                  finish(
                    event.persistenceFailed ? 'lost-thread' : 'completed',
                    event.inputTranscript,
                    event.transcript,
                    event.usageUsd,
                    event.citations ?? [],
                  );
                  break;
                case 'interrupted':
                  finish('interrupted', '', '', this.#reservations.voiceUsd);
                  break;
                case 'error':
                  finish('failed', '', '', this.#reservations.voiceUsd);
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
        if (completed.status === 'completed') {
          try {
            this.#persistVoiceTurn(turn, completed);
          } catch {
            await this.#closeVoiceSession();
            return this.#lostVoiceThread();
          }
        }
        if (
          completed.status === 'failed' ||
          completed.status === 'lost-thread'
        ) {
          await this.#closeVoiceSession();
        } else this.#scheduleVoiceIdleClose();
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

  #lostVoiceThread(): VoiceConversationResult {
    return {
      citations: [],
      inputTranscript: '',
      status: 'lost-thread',
      transcript: '',
    };
  }

  #persistVoiceTurn(turn: VoiceTurn, completed: VoiceConversationResult): void {
    const inputTranscript = completed.inputTranscript.trim();
    const outputTranscript = completed.transcript.trim();
    if (inputTranscript.length === 0 || outputTranscript.length === 0) {
      throw new Error('completed voice turn was missing a transcript');
    }
    const now = this.#now();
    const associationId =
      turn.humanObservation?.platformSourceId ?? turn.requestId;
    this.#conversation.recordBatch([
      ...(turn.humanObservation === undefined
        ? [
            {
              content: inputTranscript,
              medium: 'voice' as const,
              occurredAt: now,
              platformEventId: `discord:voice:${turn.requestId}:human`,
              recentUntil: now + CONVERSATION_RETENTION_MS,
              requestId: associationId,
              retentionDeadline: now + CONVERSATION_RETENTION_MS,
              role: 'human' as const,
              speakerId: turn.speakerId,
              speakerName: turn.speakerName,
            },
          ]
        : []),
      {
        content: outputTranscript,
        medium: 'voice',
        occurredAt: now,
        platformEventId: `chief:voice:${turn.requestId}`,
        recentUntil: now + CONVERSATION_RETENTION_MS,
        requestId: associationId,
        retentionDeadline: now + CONVERSATION_RETENTION_MS,
        role: 'chief',
        speakerId: null,
        speakerName: 'Chief',
      },
    ]);
    if (turn.humanObservation === undefined) {
      this.#memory.observeAutomatic({
        content: inputTranscript,
        medium: 'voice',
        occurredAt: now,
        platformSourceId: `voice:${turn.requestId}`,
        retentionDeadline: now + CONVERSATION_RETENTION_MS,
        speakerId: turn.speakerId,
      });
    }
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
    this.#voiceSpeakerId = undefined;
    await session?.close();
  }

  #scheduleVoiceIdleClose(): void {
    this.#voiceIdleTimer = setTimeout(() => {
      void this.#closeVoiceSession();
    }, 60_000);
    this.#voiceIdleTimer.unref();
  }
}

function explicitReceiptContent(receipt: MemoryMutationReceipt): string {
  switch (receipt.status) {
    case 'created':
      return 'I have committed that to the record';
    case 'superseded':
      return 'I have corrected the record';
    case 'forgotten':
      return 'I have removed that from the record';
    case 'conflict':
      return 'I found a conflicting memory and need clarification before treating either as settled';
    case 'rejected-sensitive':
      return 'I did not save that because it is sensitive';
    case 'ambiguous':
      return 'I could not identify a clear durable memory, so I did not save anything';
    case 'budget-paused':
      return 'Memory work is paused until the next UTC month, so I did not save that';
    case 'failed':
      return 'The memory update failed, so I did not save that';
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
