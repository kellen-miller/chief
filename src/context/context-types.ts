import type { ChiefConversationMessage } from '../agent/chief-agent.js';

export type ContextTier = 'hourly' | 'daily' | 'weekly' | 'long-term';
export type CalendarContextTier = Exclude<ContextTier, 'long-term'>;
export type ContextCompleteness = 'provisional' | 'final';
export type ContextDocumentState = 'active' | 'superseded' | 'suppressed';
export type ContextContentState = 'available' | 'scrubbed';
export type ContextContentStateReason =
  'retained' | 'retention-expired' | 'discord-deleted' | 'locally-forgotten';

export interface HistoricalSourceContext {
  readonly confidence: number;
  readonly evidenceForm: 'source';
  readonly occurredAt: number;
  readonly sourceLinks: readonly string[];
  readonly text: string;
}

export interface HistoricalRollupContext {
  readonly confidence: number;
  readonly evidenceForm: 'rollup';
  readonly periodEnd: number | null;
  readonly periodStart: number;
  readonly sourceLinks: readonly string[];
  readonly summary: string;
  readonly tier: ContextTier;
  readonly topicLabel?: string;
}

export type HistoricalContext =
  HistoricalSourceContext | HistoricalRollupContext;

export interface PreparedContext {
  readonly approximateTokens: number;
  readonly historicalContext: readonly HistoricalContext[];
  readonly memories: readonly string[];
  readonly recentConversation: readonly ChiefConversationMessage[];
  readonly usageUsd: number;
}
