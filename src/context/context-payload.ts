import type { ChiefConversationMessage } from '../agent/chief-agent.js';
import type { HistoricalContext } from './context-types.js';

export function serializeContextPayload(input: {
  readonly historicalContext: readonly HistoricalContext[];
  readonly memories: readonly string[];
  readonly recentConversation: readonly ChiefConversationMessage[];
  readonly userRequest: string;
}) {
  return {
    communalMemory: input.memories,
    dataClassification: 'untrusted_user_supplied_context' as const,
    historicalContext: input.historicalContext.map((context) =>
      context.evidenceForm === 'source'
        ? {
            confidence: context.confidence,
            evidenceForm: context.evidenceForm,
            occurredAt: context.occurredAt,
            provenanceQuality: context.provenanceQuality,
            sourceLinks: context.sourceLinks,
            speakerLabel: sanitizeContextLabel(context.speakerName),
            temporalLabel: context.temporalLabel,
            text: context.text,
          }
        : context,
    ),
    recentConversation: input.recentConversation.map((message) => ({
      content: message.content,
      role: message.role,
      speakerLabel: sanitizeContextLabel(message.speakerName),
    })),
    userRequest: input.userRequest,
  };
}

export function sanitizeContextLabel(label: string | null): string {
  if (label === null) return 'President';
  const sanitized = label
    .replace(/<@!?\d+>/gu, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 60);
  return sanitized.length === 0 ? 'President' : sanitized;
}
