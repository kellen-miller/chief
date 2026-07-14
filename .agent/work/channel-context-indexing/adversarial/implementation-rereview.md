I have completed a thorough independent verification. Let me compile the adversarial re-review.

---

# Adversarial Implementation Re-Review — Hierarchical Channel Context Indexing (correction pass)

**Method.** Read-only inspection of the committed range `cdcc2e5…HEAD` plus the uncommitted correction diff. I independently traced each of the three claimed corrections through live code (not the packet), then ran a narrow deterministic check: `pnpm typecheck` (clean) and the four focused suites (`context-assembler`, `usage-budget`, `context-rollup`, `context-backfill`) — **73/73 passed** on my own run. I did not trust the reported evidence; every verdict below traces to file:line I re-read.

## Correction verdicts

### 1. Embedding-only failure no longer takes text replies offline — **HOLDS**

`context-assembler.ts:133-176`. The embed call and both recall calls are now inside guards:

- `#embed` throw → `embedded` stays `undefined`, `degraded=true`, and the fallback calls `this.#memory.recallLexical(input.prompt)` (`memory-service.ts:114-129` → `memory-store.ts:462-473`), which is a pure FTS query (`memory_fts match ? and m.state = 'active'`) with **no provider call**.
- Historical vector retrieval is gated on `if (embedded !== undefined)` (`:158`), so it is **skipped** on embed failure.
- `usageUsd: embedded?.usageUsd ?? 0` (`:190`) → **zero** for the failed embedding.
- `recent` is read before the embed block (`:107-121`) and is always returned.

Because `assemble()` now only throws `ContextPersistenceError` (from the recent-read at `:117`), the orchestrator's non-`ContextPersistenceError` hard-fail branch (`conversation-orchestrator.ts:331-335`) is no longer reachable from an embedding fault; the degraded context flows to `answerText` (`:346-352`). All four required behaviors confirmed. The new test `falls back to recent and lexical memory when embedding fails` asserts exactly `{degraded:true, historicalContext:[], memories:[…], usageUsd:0}`.

### 2. Context writes + durable reconciliation in one transaction; in-memory state changes only after commit — **HOLDS**

`sqlite-usage-ledger.ts:74-121` opens a single `transaction()`, runs `work()` (the context-write function, entered as a nested SQLite **savepoint**) first, then the held-check and ledger/run updates — one real `BEGIN…COMMIT`. `usage-budget.ts:201-227` performs all in-memory mutation (`#reservations.delete`, `#actualUsd +=`, threshold eval) **after** `this.#ledger.reconcileWith(...)` returns, i.e. after commit. Both callers pass the transaction fn _un-invoked_ and call `reconcileWith` outside any transaction (`channel-context-service.ts:943-1052`, `context-backfill.ts:316-413`). If the outer commit or the reconcile rolls back, `work()`'s writes and the ledger row roll back together and the in-memory delete never runs; the catch then conservatively reconciles the still-present reservation (`channel-context-service.ts:1060-1061`, `context-backfill.ts:415-417`). Verified by the new `usage-budget` test (rollback leaves `reservedUsd:0.1`, ledger `actual_usd` null) and the `reconcileTransactionStates` spies asserting `database.inTransaction === false` at call time.

### 3. Outstanding reservations recovered before finalizing, incl. final page and cross-month — **HOLDS**

`context-backfill.ts:222-227` moves `#recoverOutstandingReservations` **above** the `nextPageIndex === null` finalize check. `#recoverOutstandingReservations` (`:1286-1306`) reconciles every `backfill_run_id` row with `actual_usd is null` (page _and_ induced-job orphans) conservatively; `#finalizeRun` (`:1256-1265`) then sees zero outstanding and completes. The cross-month case works because `UsageBudget.#loadMonth` re-hydrates all outstanding rows regardless of month (`usage-budget.ts:343-352`), and reconciling a prior-month reservation updates the ledger row and the run's lifetime `actual_usage_usd` while correctly _not_ inflating the new month's actual (`:218`). The new test reserves at Jul-31 23:59, restarts at Aug-01 00:01, and reaches `status:'completed'` with ledger `actual_usd = 0.05`. I also confirmed the `--replace` outstanding-guard (`:486-489`) is only ever transient, since the active run's next `runNext` now settles the orphan.

## No weakening of the other guarantees

- **Accounting holds:** ledger `reconcileWith` still rejects held reservations inside the transaction before any mutation (`sqlite-usage-ledger.ts:97-99`); a held reservation still rolls back the bundled context write.
- **Run ceilings / retry:** admission, the hard `usageUsd > reservedUsd` contract-pause (`channel-context-service.ts:920`, `context-backfill.ts:311`), and conservative-reconcile-then-defer/retry are unchanged.
- **Reply privacy:** `recallLexical` returns only `state='active'` canonical text — identical suppression filtering to `retrieve` (`memory-store.ts:422` vs `:469`), so forgotten/superseded memories cannot leak; `degraded` reaches telemetry as a boolean with counts only (`conversation-orchestrator.ts:338-345`).
- **Deletion/recovery:** untouched by these diffs; the lexical fallback respects the same active-state gate.

## Reassessment of the two relevance observations

- **Vector-only rollup admission** (`context-assembler.ts` `#retrieveHistorical`, unchanged by this diff): gating vector rollups on lexical overlap would defeat the approved single-embedding **semantic recall** (decision.md §Retrieval; execplan Decision Log). Deliberate, not a correctness defect — **not reported**.
- **Weekly single-common-word topic fan-in:** respects the approved "complete topic-label anchor" policy (execplan Decision Log 2026-07-14) and fails safe on an empty relevance set. Deliberate topic policy — **not reported**.

## Bottom line

All three targeted corrections are correctly and minimally implemented and survive hostile inspection; the first review's one HIGH (embedding offline) and its two accounting LOWs (COMMIT-time in-memory divergence, cross-month finalize wedge) are resolved. No new reachable correctness defect. The remaining two observations are deliberate, decision-approved behavior. I inspected the durable-memory reconcile path (`memory-service.ts:221,240`) as well; its separate-transaction reconcile is pre-existing, fail-safe, and outside both the correction scope and the "context writes" requirement.

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 0
CRITICAL_COUNT: 0
HIGH_COUNT: 0
MEDIUM_COUNT: 0
LOW_COUNT: 0
CONFIDENCE: high
BLOCKING: no
SUMMARY: All three corrections verified correct (embedding-degrade fallback, single-transaction reconcile with post-commit in-memory mutation, pre-finalize cross-month reservation recovery); no weakening of holds/ceilings/retry/privacy/deletion; relevance observations are decision-approved and not defects.
---END_ADVERSARIAL_REVIEW_STATUS---
