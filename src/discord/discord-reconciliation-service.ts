import type Database from 'better-sqlite3';

import * as queries from '../../gen/sql/application.js';

import type { NormalizedTextSource } from '../app/conversation-orchestrator.js';

const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export type DiscordHistoryMode =
  'backfill' | 'full' | 'incremental' | 'retained';

export interface DiscordHistoryItem {
  readonly messageId: string;
  readonly occurredAt: number;
  readonly revisionChecksum: string;
  readonly source?: NormalizedTextSource;
}

export interface DiscordHistoryPage {
  readonly complete: boolean;
  readonly coverage: {
    readonly newestMessageId: string;
    readonly oldestMessageId: string;
  } | null;
  readonly items: readonly DiscordHistoryItem[];
  readonly nextCursor: string | null;
  readonly rateLimited: boolean;
}

export interface DiscordHistoryFetchInput {
  readonly afterMessageId: string | null;
  readonly cursor: string | null;
  readonly mode: DiscordHistoryMode;
  readonly retentionCutoff: number;
  readonly scanUpperBoundMessageId: string | null;
}

export interface DiscordHistoryTransportIdentity {
  readonly item?: DiscordHistoryItem;
  readonly messageId: string;
  readonly occurredAt: number;
}

export interface DiscordHistorySource {
  fetchPage(input: DiscordHistoryFetchInput): Promise<DiscordHistoryPage>;
}

export interface DiscordSourceLifecycle {
  applyTextSource(source: NormalizedTextSource): unknown;
  deleteTextSource(input: {
    readonly deletedAt: number;
    readonly messageId: string;
  }): unknown;
}

export interface DiscordReconciliationServiceOptions {
  readonly channelId: string;
  readonly database: Database.Database;
  readonly guildId: string;
  readonly history: DiscordHistorySource;
  readonly lifecycle: DiscordSourceLifecycle;
  readonly now?: () => number;
}

export interface DiscordReconciliationResult {
  readonly status: 'completed' | 'failed' | 'incomplete' | 'rate-limited';
}

interface ReconciliationState {
  readonly coveredNewestMessageId: string | null;
  readonly coveredOldestMessageId: string | null;
  readonly cursorMessageId: string | null;
  readonly highWaterMessageId: string | null;
  readonly lastCompleteAt: number | null;
  readonly lastFullScanAt: number | null;
  readonly passKey: string | null;
  readonly phase: DiscordHistoryMode | null;
  readonly scanUpperBoundMessageId: string | null;
}

export class DiscordReconciliationService {
  readonly #channelId: string;
  readonly #database: Database.Database;
  readonly #guildId: string;
  readonly #history: DiscordHistorySource;
  readonly #lifecycle: DiscordSourceLifecycle;
  readonly #now: () => number;
  readonly #scopeId: string;
  readonly #fullScopeId: string;

  public constructor(options: DiscordReconciliationServiceOptions) {
    this.#channelId = options.channelId;
    this.#database = options.database;
    this.#guildId = options.guildId;
    this.#history = options.history;
    this.#lifecycle = options.lifecycle;
    this.#now = options.now ?? Date.now;
    this.#scopeId = `${options.guildId}/${options.channelId}`;
    this.#fullScopeId = `${this.#scopeId}:full`;
    const now = this.#now();
    this.#ensureState(this.#scopeId, now);
    this.#ensureState(this.#fullScopeId, now);
  }

  public async reconcileAfterGap(): Promise<DiscordReconciliationResult> {
    if (this.#state().phase === 'retained') {
      return this.#runPass('retained');
    }
    const incremental = await this.#runPass('incremental');
    if (incremental.status !== 'completed') return incremental;
    return this.#runPass('retained');
  }

  public async reconcileWeeklyIdentity(): Promise<DiscordReconciliationResult> {
    const now = this.#now();
    const state = this.#state('full');
    if (
      state.lastFullScanAt !== null &&
      now - state.lastFullScanAt < FULL_SCAN_INTERVAL_MS
    ) {
      return { status: 'completed' };
    }
    return this.#runPass('full');
  }

  public diagnostics(): {
    readonly lagMs: number | null;
    readonly lastCompleteAt: number | null;
  } {
    const state = this.#state();
    return {
      lagMs:
        state.lastCompleteAt === null
          ? null
          : Math.max(0, this.#now() - state.lastCompleteAt),
      lastCompleteAt: state.lastCompleteAt,
    };
  }

  async #runPass(
    mode: DiscordHistoryMode,
  ): Promise<DiscordReconciliationResult> {
    const startedAt = this.#now();
    const stateScopeId = this.#stateScopeId(mode);
    let state = this.#state(mode);
    if (state.phase !== mode || state.passKey === null) {
      const passKey = `${mode}:${startedAt.toString()}`;
      const scanUpperBoundMessageId =
        mode === 'full' ? timestampSnowflakeUpperBound(startedAt) : null;
      this.#database.transaction(() => {
        queries
          .discordReconciliationServiceRunPassDeleteDiscordReconciliationSeen(
            this.#database,
          )
          .run(stateScopeId, passKey);
        queries
          .discordReconciliationServiceRunPassUpdateDiscordReconciliationState(
            this.#database,
          )
          .run(mode, passKey, scanUpperBoundMessageId, startedAt, stateScopeId);
      })();
      state = this.#state(mode);
    }
    const passKey = state.passKey;
    if (passKey === null) return { status: 'failed' };
    let previousCursor: string | null = null;

    try {
      for (;;) {
        const page = await this.#history.fetchPage({
          afterMessageId:
            mode === 'incremental' ? state.highWaterMessageId : null,
          cursor: state.cursorMessageId,
          mode,
          retentionCutoff: startedAt - RAW_RETENTION_MS,
          scanUpperBoundMessageId: state.scanUpperBoundMessageId,
        });
        this.#applyPage(mode, stateScopeId, passKey, page, startedAt);
        this.#updateProgress(mode, page, startedAt);
        if (page.rateLimited) return { status: 'rate-limited' };
        if (!page.complete) return { status: 'incomplete' };
        if (page.nextCursor === null) break;
        if (page.nextCursor === previousCursor) return { status: 'incomplete' };
        previousCursor = page.nextCursor;
        state = this.#state(mode);
      }
    } catch {
      return { status: 'failed' };
    }

    state = this.#state(mode);
    if (
      (mode === 'retained' || mode === 'full') &&
      state.coveredOldestMessageId !== null &&
      state.coveredNewestMessageId !== null
    ) {
      try {
        await this.#inferCoveredDeletions(
          stateScopeId,
          passKey,
          state.coveredOldestMessageId,
          state.coveredNewestMessageId,
          startedAt,
        );
      } catch {
        return { status: 'failed' };
      }
    }
    this.#completePass(mode, stateScopeId, passKey, startedAt);
    return { status: 'completed' };
  }

  #applyPage(
    mode: DiscordHistoryMode,
    stateScopeId: string,
    passKey: string,
    page: DiscordHistoryPage,
    observedAt: number,
  ): void {
    const insertSeen =
      queries.discordReconciliationServiceApplyPageInsertDiscordReconciliationSeen(
        this.#database,
      );
    this.#database.transaction(() => {
      for (const item of page.items) {
        insertSeen.run(
          stateScopeId,
          passKey,
          item.messageId,
          observedAt,
          item.revisionChecksum,
        );
        const source = item.source;
        if (mode !== 'full' && source?.messageId === item.messageId) {
          this.#lifecycle.applyTextSource(source);
        }
      }
    })();
  }

  #updateProgress(
    mode: DiscordHistoryMode,
    page: DiscordHistoryPage,
    now: number,
  ): void {
    const stateScopeId = this.#stateScopeId(mode);
    const state = this.#state(mode);
    const oldest = minimumSnowflake(
      state.coveredOldestMessageId,
      page.coverage?.oldestMessageId ?? null,
    );
    const newest = maximumSnowflake(
      state.coveredNewestMessageId,
      page.coverage?.newestMessageId ?? null,
    );
    queries
      .discordReconciliationServiceUpdateProgressUpdateDiscordReconciliationState(
        this.#database,
      )
      .run(page.nextCursor, oldest, newest, now, stateScopeId);
  }

  async #inferCoveredDeletions(
    stateScopeId: string,
    passKey: string,
    oldestMessageId: string,
    newestMessageId: string,
    deletedAt: number,
  ): Promise<void> {
    const seen = new Set(
      queries
        .discordReconciliationServiceInferCoveredDeletionsSelectDiscordReconciliationSeen(
          this.#database,
        )
        .pluck()
        .all(stateScopeId, passKey),
    );
    const indexed = queries
      .discordReconciliationServiceInferCoveredDeletionsSelectConversationEvents(
        this.#database,
      )
      .pluck()
      .all(this.#guildId, this.#channelId);
    for (const messageId of indexed) {
      if (
        withinSnowflakeRange(messageId, oldestMessageId, newestMessageId) &&
        !seen.has(messageId)
      ) {
        await this.#lifecycle.deleteTextSource({ deletedAt, messageId });
      }
    }
  }

  #completePass(
    mode: DiscordHistoryMode,
    stateScopeId: string,
    passKey: string,
    completedAt: number,
  ): void {
    const state = this.#state(mode);
    let highWater = state.highWaterMessageId;
    if (mode === 'incremental') {
      highWater = maximumSnowflake(highWater, state.coveredNewestMessageId);
      const ids = queries
        .discordReconciliationServiceCompletePassSelectDiscordReconciliationSeen(
          this.#database,
        )
        .pluck()
        .all(stateScopeId, passKey);
      for (const id of ids) highWater = maximumSnowflake(highWater, id);
    }
    this.#database.transaction(() => {
      queries
        .discordReconciliationServiceCompletePassUpdateDiscordReconciliationState(
          this.#database,
        )
        .run(
          highWater,
          completedAt,
          mode,
          completedAt,
          completedAt,
          stateScopeId,
        );
      queries
        .discordReconciliationServiceCompletePassDeleteDiscordReconciliationSeen(
          this.#database,
        )
        .run(stateScopeId, `${mode}:%`, passKey);
    })();
  }

  #ensureState(scopeId: string, now: number): void {
    queries
      .discordReconciliationServiceEnsureStateInsertDiscordReconciliationState(
        this.#database,
      )
      .run(scopeId, now);
  }

  #state(mode?: DiscordHistoryMode): ReconciliationState {
    const scopeId =
      mode === undefined ? this.#scopeId : this.#stateScopeId(mode);
    const state = queries
      .discordReconciliationServiceStateSelectDiscordReconciliationState(
        this.#database,
      )
      .get(scopeId) as ReconciliationState | undefined;
    if (state === undefined) throw new Error('reconciliation state missing');
    return state;
  }

  #stateScopeId(mode: DiscordHistoryMode): string {
    return mode === 'full' ? this.#fullScopeId : this.#scopeId;
  }
}

function minimumSnowflake(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return BigInt(left) <= BigInt(right) ? left : right;
}

function maximumSnowflake(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return BigInt(left) >= BigInt(right) ? left : right;
}

function withinSnowflakeRange(
  messageId: string,
  oldestMessageId: string,
  newestMessageId: string,
): boolean {
  const value = BigInt(messageId);
  return value >= BigInt(oldestMessageId) && value <= BigInt(newestMessageId);
}

const DISCORD_EPOCH_MS = 1_420_070_400_000;

export function discordHistoryFetchRequest(input: DiscordHistoryFetchInput): {
  readonly after?: string;
  readonly before?: string;
  readonly limit: 100;
} {
  if (
    input.mode === 'backfill' &&
    input.cursor === null &&
    input.scanUpperBoundMessageId !== null
  ) {
    return {
      before: (BigInt(input.scanUpperBoundMessageId) + 1n).toString(),
      limit: 100,
    };
  }
  if (input.mode === 'full' && input.cursor === null) {
    const scanUpperBoundMessageId = requireFullScanUpperBound(input);
    return {
      before: (BigInt(scanUpperBoundMessageId) + 1n).toString(),
      limit: 100,
    };
  }
  const anchor = input.cursor ?? input.afterMessageId;
  if (anchor === null) return { limit: 100 };
  return input.mode === 'incremental' && input.cursor === null
    ? { after: anchor, limit: 100 }
    : { before: anchor, limit: 100 };
}

export function buildDiscordHistoryPage(
  input: DiscordHistoryFetchInput,
  fetched: readonly DiscordHistoryTransportIdentity[],
): DiscordHistoryPage {
  const incremental = input.mode === 'incremental';
  const fullScanUpperBound =
    input.mode === 'full' ? requireFullScanUpperBound(input) : null;
  if (
    fullScanUpperBound !== null &&
    fetched.some(
      ({ messageId }) => BigInt(messageId) > BigInt(fullScanUpperBound),
    )
  ) {
    return {
      complete: false,
      coverage: null,
      items: [],
      nextCursor: input.cursor,
      rateLimited: false,
    };
  }
  const afterMessageId = input.afterMessageId;
  const reachedIncrementalBoundary =
    incremental &&
    afterMessageId !== null &&
    fetched.some(
      ({ messageId }) => BigInt(messageId) <= BigInt(afterMessageId),
    );
  const containsExpired = fetched.some(
    ({ occurredAt }) => occurredAt < input.retentionCutoff,
  );
  const terminal =
    (incremental && input.afterMessageId === null) ||
    fetched.length < 100 ||
    reachedIncrementalBoundary ||
    (input.mode === 'retained' && containsExpired);
  const rawIds = fetched.map(({ messageId }) => messageId);
  const oldestRaw = snowflakeMinimum(rawIds);
  const newestRaw = snowflakeMaximum(rawIds);
  const items = fetched.flatMap(({ item, messageId, occurredAt }) => {
    if (
      incremental &&
      afterMessageId !== null &&
      BigInt(messageId) <= BigInt(afterMessageId)
    ) {
      return [];
    }
    if (input.mode === 'retained' && occurredAt < input.retentionCutoff) {
      return [];
    }
    return item === undefined ? [] : [item];
  });
  const coverage =
    oldestRaw === null && newestRaw === null && !terminal
      ? null
      : {
          newestMessageId:
            fullScanUpperBound ??
            newestRaw ??
            timestampSnowflake(input.retentionCutoff + RAW_RETENTION_MS),
          oldestMessageId:
            input.mode === 'full' && terminal
              ? '0'
              : input.mode === 'retained' && terminal
                ? timestampSnowflake(input.retentionCutoff)
                : (oldestRaw ?? timestampSnowflake(input.retentionCutoff)),
        };
  return {
    complete: true,
    coverage,
    items,
    nextCursor: terminal ? null : oldestRaw,
    rateLimited: false,
  };
}

export function rateLimitedDiscordHistoryPage(
  input: DiscordHistoryFetchInput,
): DiscordHistoryPage {
  return {
    complete: false,
    coverage: null,
    items: [],
    nextCursor: input.cursor,
    rateLimited: true,
  };
}

function snowflakeMinimum(ids: readonly string[]): string | null {
  return ids.reduce<string | null>(
    (minimum, id) =>
      minimum === null || BigInt(id) < BigInt(minimum) ? id : minimum,
    null,
  );
}

function snowflakeMaximum(ids: readonly string[]): string | null {
  return ids.reduce<string | null>(
    (maximum, id) =>
      maximum === null || BigInt(id) > BigInt(maximum) ? id : maximum,
    null,
  );
}

function timestampSnowflake(timestamp: number): string {
  return (
    BigInt(Math.max(0, Math.floor(timestamp) - DISCORD_EPOCH_MS)) << 22n
  ).toString();
}

function timestampSnowflakeUpperBound(timestamp: number): string {
  return (
    (BigInt(Math.max(0, Math.floor(timestamp) - DISCORD_EPOCH_MS)) << 22n) |
    ((1n << 22n) - 1n)
  ).toString();
}

function requireFullScanUpperBound(input: DiscordHistoryFetchInput): string {
  if (input.scanUpperBoundMessageId === null) {
    throw new Error('full Discord scan requires an upper bound');
  }
  return input.scanUpperBoundMessageId;
}
