import type Database from 'better-sqlite3';

import type { NormalizedTextSource } from '../app/conversation-orchestrator.js';

const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export type DiscordHistoryMode = 'full' | 'incremental' | 'retained';

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

export interface DiscordHistorySource {
  fetchPage(input: {
    readonly afterMessageId: string | null;
    readonly cursor: string | null;
    readonly mode: DiscordHistoryMode;
    readonly retentionCutoff: number;
  }): Promise<DiscordHistoryPage>;
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
    readonly highWaterMessageId: string | null;
    readonly lagMs: number | null;
    readonly lastCompleteAt: number | null;
  } {
    const state = this.#state();
    return {
      highWaterMessageId: state.highWaterMessageId,
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
      this.#database.transaction(() => {
        this.#database
          .prepare(
            `delete from discord_reconciliation_seen
             where scope_id = ? and pass_key = ?`,
          )
          .run(stateScopeId, passKey);
        this.#database
          .prepare(
            `update discord_reconciliation_state
             set phase = ?, pass_key = ?, cursor_message_id = null,
                 covered_oldest_message_id = null,
                 covered_newest_message_id = null, updated_at = ?
             where scope_id = ?`,
          )
          .run(mode, passKey, startedAt, stateScopeId);
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
      this.#inferCoveredDeletions(
        stateScopeId,
        passKey,
        state.coveredOldestMessageId,
        state.coveredNewestMessageId,
        startedAt,
      );
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
    const insertSeen = this.#database.prepare(
      `insert into discord_reconciliation_seen
         (scope_id, pass_key, message_id, observed_at, revision_checksum)
       values (?, ?, ?, ?, ?)
       on conflict(scope_id, pass_key, message_id) do update set
         observed_at = excluded.observed_at,
         revision_checksum = excluded.revision_checksum`,
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
    this.#database
      .prepare(
        `update discord_reconciliation_state
         set cursor_message_id = ?, covered_oldest_message_id = ?,
             covered_newest_message_id = ?, updated_at = ?
         where scope_id = ?`,
      )
      .run(page.nextCursor, oldest, newest, now, stateScopeId);
  }

  #inferCoveredDeletions(
    stateScopeId: string,
    passKey: string,
    oldestMessageId: string,
    newestMessageId: string,
    deletedAt: number,
  ): void {
    const seen = new Set(
      this.#database
        .prepare(
          `select message_id from discord_reconciliation_seen
           where scope_id = ? and pass_key = ?`,
        )
        .pluck()
        .all(stateScopeId, passKey) as string[],
    );
    const indexed = this.#database
      .prepare(
        `select discord_message_id from conversation_events
         where guild_id = ? and channel_id = ? and medium = 'text'
           and content_state = 'available'`,
      )
      .pluck()
      .all(this.#guildId, this.#channelId) as string[];
    for (const messageId of indexed) {
      if (
        withinSnowflakeRange(messageId, oldestMessageId, newestMessageId) &&
        !seen.has(messageId)
      ) {
        this.#lifecycle.deleteTextSource({ deletedAt, messageId });
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
      const ids = this.#database
        .prepare(
          `select message_id from discord_reconciliation_seen
           where scope_id = ? and pass_key = ?`,
        )
        .pluck()
        .all(stateScopeId, passKey) as string[];
      for (const id of ids) highWater = maximumSnowflake(highWater, id);
    }
    this.#database.transaction(() => {
      this.#database
        .prepare(
          `update discord_reconciliation_state
           set high_water_message_id = ?, phase = null, pass_key = null,
               cursor_message_id = null, covered_oldest_message_id = null,
               covered_newest_message_id = null, last_complete_at = ?,
               last_full_scan_at = case when ? = 'full' then ?
                                        else last_full_scan_at end,
               updated_at = ? where scope_id = ?`,
        )
        .run(
          highWater,
          completedAt,
          mode,
          completedAt,
          completedAt,
          stateScopeId,
        );
      this.#database
        .prepare(
          `delete from discord_reconciliation_seen
           where scope_id = ? and pass_key like ? and pass_key <> ?`,
        )
        .run(stateScopeId, `${mode}:%`, passKey);
    })();
  }

  #ensureState(scopeId: string, now: number): void {
    this.#database
      .prepare(
        `insert into discord_reconciliation_state (scope_id, updated_at)
         values (?, ?) on conflict(scope_id) do nothing`,
      )
      .run(scopeId, now);
  }

  #state(mode?: DiscordHistoryMode): ReconciliationState {
    const scopeId =
      mode === undefined ? this.#scopeId : this.#stateScopeId(mode);
    const state = this.#database
      .prepare(
        `select high_water_message_id as highWaterMessageId, phase,
                pass_key as passKey, cursor_message_id as cursorMessageId,
                covered_oldest_message_id as coveredOldestMessageId,
                covered_newest_message_id as coveredNewestMessageId,
                last_complete_at as lastCompleteAt,
                last_full_scan_at as lastFullScanAt
         from discord_reconciliation_state where scope_id = ?`,
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
