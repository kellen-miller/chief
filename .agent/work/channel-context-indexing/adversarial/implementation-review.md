I now have a complete picture: my own trace of the deletion/journal/recovery/Terraform surface plus five subagent audits. Let me settle the one remaining severity question (the backfill orphan-reservation) — it's fail-safe and only wedges an un-activated owner path, so LOW — and write up the review.

The evidence is consolidated. Here is my independent adversarial assessment.

---

# Adversarial Implementation Review — Hierarchical Channel Context Indexing

**Method.** Read-only inspection of the full diff `cdcc2e5…HEAD`. I traced the authoritative-deletion/journal ordering, host startup preflight, Terraform retention, and reply path myself, and ran five parallel deep audits (budget/cost, retrieval/lineage, logging privacy, migration/recovery, reply-fallback/reconciliation). I independently re-verified every code-level claim before reporting it; findings below trace to reachable paths with file:line evidence.

I did **not** trust the "formal re-review approved with no findings" conclusion. Four of the five previously-claimed fixes hold under hostile inspection. **One does not.**

## Findings (most severe first)

### 1. HIGH — Ordinary text replies still go fully offline when the embedding provider fails (claim #3 fix is incomplete)

**Evidence:** `src/context/context-assembler.ts:129-134`, `src/app/conversation-orchestrator.ts:327-336`, `src/memory/openai-memory.ts:171-173`.

The prior review found "Ordinary replies failed when live context indexing failed" and the packet claims it fixed. The fix wrapped the **write** path and the **historical rollup read** (`#retrieveHistorical`, `context-assembler.ts:138-154`, which sets `degraded=true` and lets the reply proceed). But the two read-side dependencies immediately above it are unguarded:

```
129  const embedded = await this.#embed(input.prompt);          // NOT wrapped
130  const { memories } = this.#memory.recallPrepared({ ... });  // NOT wrapped
```

`#embed` is the live OpenAI embedder wired at `runtime.ts:84-88,141`. It throws a **plain `Error`** — `openai-memory.ts:172` (`'OpenAI returned an invalid memory embedding'`) on a malformed response, and propagates raw SDK errors (429 on the embedding model, timeout, network, model 404) on any transient embedding-endpoint fault. None of these is a `ContextPersistenceError`, so it escapes `assemble()`. The orchestrator catch at `conversation-orchestrator.ts:329-335` then routes any non-`ContextPersistenceError` to a hard `status:'failed'` — `"I could not complete that request, Mr. President"`.

**Failure scenario:** The embedding model is rate-limited (429) or returns a malformed body while the chat model is healthy. `recent` conversation was already read successfully (`context-assembler.ts:108-115`), so a real degraded answer from recent conversation + durable memory was possible — exactly what decision.md line 76 promises ("A failed or lagging index does not take Discord replies offline. Chief falls back to available recent conversation and durable memory"). Instead Chief refuses to answer.

**This is provably an oversight, not intent:** the parallel voice path handles the identical `assemble()` throw correctly — `openai-voice.ts:648-651` maps a non-`ContextPersistenceError` to a `context-unavailable` tool result and lets the model keep speaking. The text path is the inconsistent one. There is no test exercising an embedding failure on the text path (the covered cases are write-apply failure and `recent`-read failure only).

**Narrow correction:** Wrap `context-assembler.ts:129-130`. On failure, set `degraded=true`, proceed with an empty embedding (skip `#retrieveHistorical`, empty `memories`), and return a `PreparedContext` so `#handlePaidText` still calls `answerText` with `recentConversation`. `degraded` already flows to health telemetry with no content logged.

_Fairness note:_ in a **total** OpenAI outage the answer model is down too, so there is no regression there. The gap is the independent-embedding-failure class (429 on the embedding model, malformed-embedding validation throw, embedding-only timeout). Because it reintroduces the exact regression claimed closed and violates an explicit availability guarantee on a reachable path, I rate it High; a reviewer weighting the shared-provider mitigation heavily could argue Medium.

### 2. LOW — Backfill run can wedge (never `completed`, `--replace` refused) via an orphaned cross-month reservation

**Evidence:** `src/usage/usage-budget.ts:275-286` + `:325-334`; `src/context/context-backfill.ts:1254-1263` + `:1284-1304`.

`#reservedTotal()` filters reservations by `monthStart(occurredAt) === this.#monthStart` (`usage-budget.ts:278-279`), but `#loadMonth` re-hydrates **all** outstanding reservations regardless of month from `listOutstanding()` (`:325-334`). `#recoverOutstandingReservations` only reconciles a run's outstanding rows when that run's `runNext` executes (`context-backfill.ts:238`), which happens only for an **active** run. If a backfill reservation survives a crash, the month rolls over, and its owning run is subsequently failed/replaced, the durable `usage_ledger` row stays `actual_usd is null` forever. `#finalizeRun` counts that row (`:1254-1263`) so the run can never reach `completed`, and `dryRun --replace` rejects the outstanding row.

**Why Low, not the Medium a first pass suggested:** direction is fail-safe (over-reservation, never a bypass), it affects only the owner-only backfill that is _intentionally unactivated_, and the design already exposes a rebuild/resume escape hatch. No overspend, data loss, or privacy impact. **Correction:** in `#loadMonth`, reconcile-or-drop prior-month outstanding reservations whose owning run is no longer active rather than resurrecting them into `#reservations`.

### 3. LOW — Backfill in-memory budget can diverge from the ledger on a COMMIT failure

**Evidence:** `src/context/context-backfill.ts:410-416` (mirrored at `channel-context-service.ts:948`).

`budget.reconcile(...)` runs as the last statement _inside_ the outer `this.#database.transaction(...)`. It mutates in-memory `#reservations`/`#actualUsd` (`usage-budget.ts:199-206`) via a nested savepoint. If the **outer** COMMIT fails (disk full/lock), SQLite rolls the ledger back but the in-memory mutation is not reverted; the `catch` then throws `'unknown usage reservation'` out of `runNext`. It self-heals on the next restart (`#loadMonth` re-reads the still-outstanding row), so Low. **Correction:** move `budget.reconcile` to after `transaction()()` returns.

### 4. LOW — Vector-only rollups are admitted without the query-local lexical anchor

**Evidence:** `src/context/context-assembler.ts:404-415`. The `hasSufficientLexicalOverlap` anchor gates only the lexical rows (`:357-359`); a rollup found solely via the vector path is admitted on `MAX_VECTOR_DISTANCE` (1.2) alone. A semantically adjacent but topically unrelated rollup within that L2 radius can surface. Scope/as-of are still enforced in SQL before the limit, so this is a relevance-precision edge, not a leak, and appears deliberate (semantic recall is meant to work without lexical overlap — see the test titled "…lexical-only evidence"). Flagging because the execplan phrasing ("reject modifier-only source _and rollup_ matches") reads stricter than the code. **Correction (optional):** gate vector rollups on `hasSufficientLexicalOverlap(...)` when a lexical query exists, or tighten the distance floor.

### 5. LOW — Weekly topic fan-in can over-broaden a topic whose distinctive label is a single common word

**Evidence:** `src/context/channel-context-service.ts:1431-1462` via `hasCompleteLexicalAnchor` (`src/context/lexical-relevance.ts:94-101`). Weekly consolidation fans a weekly document into every active long-term topic whose full relevance-term set appears in the weekly summary. Multi-word labels ("Project Juniper") are safe and tested. The residual: a label whose distinctive set reduces to one common token (e.g. "The Project" → `["project"]`) will absorb any weekly summary mentioning "project," slowly mixing unrelated discussion. It respects the letter of the "complete topic-label anchor" rule and fails safe on an empty relevance set. **Correction (optional):** require ≥2 relevance terms (or a semantic gate) before weekly fan-in.

## Previously-claimed fixes — independent verdicts

1. **Journal-before-mutation for authoritative deletion — HOLDS.** `applyAuthoritativeSuppression` (`channel-context-service.ts:370-384`) computes a minimal content-free journal, `await`s the GCS upload, and only then enters the atomic scrub transaction recording that exact journal as `uploaded`. An upload throw mutates nothing (source stays available); a crash after upload is re-scrubbed by the startup GCS replay. The minimal journal is replay-sufficient because `replayForgetJournal` re-derives affected documents/memories from `sourceScopeIds`.
2. **GCS soft delete — HOLDS.** `soft_delete_policy.retention_duration_seconds = 0` (`infra/app/main.tf`), with explicit version lifecycle rules retained.
3. **Reply fallback — PARTIALLY HOLDS → Finding #1.** Write path and rollup-read degrade correctly; the embedding read does not.
4. **Topic lineage — HOLDS.** Daily proposals carry only cited `parseSourceLineage` parents; no whole-daily substitution, no unqualified weekly all-topic fanout (only the single-common-term edge, Finding #5).
5. **Log privacy — HOLDS.** Every reachable log/health/error sink emits only event names, `error.name`, numeric fields, and bounded reason enums; provider/GCS/Discord payloads are dropped or attached as un-serialized `cause`. The paid evaluator logs numeric grades + model/timestamp only.
6. **Recovery-artifact retention — HOLDS.** Bucket `.db` transitions at age 28 + 1-day noncurrent (~29d ≤ 30d), journals at 60d; local `pre-deploy/*.db` and `chief.db.failed.*` pruned at `-mmin +43199` (~30d) and written mode-0600 (`run-container.sh:27-33`, `deploy.sh`, `restore.sh`). Journals (60d) always outlive any restore-capable backup (≤29d).

**Also verified sound:** the host preflight is genuinely fail-closed (receipt keyed on _both_ database and journal-manifest checksums, so a restored old DB or a grown journal set always forces replay; capability binding refuses an old runtime on a 0003 DB); migrations 0003–0013 are append-only and rollback-armed with exact-content (FTS token-position + vector-identity) restore verification; migration 0013 copies only 17–20-digit snowflakes; retrieval enforces scope/as-of/exclusion before limits with one shared embedding and no cross-scope or suppressed-content leak; reconciliation never infers deletion from an incomplete scan and pins the full-scan ceiling above the newest survivor.

## Non-blocking observations

- **INFO:** legacy `conversation_events` are not back-indexed into the new `conversation_event_fts` by migration 0003; lexical source search over pre-upgrade history depends on a reconciliation pass. Confirm this matches product intent.
- **Coverage:** no dedicated test for the unlabeled-image → `0002` capability fallback (`run-container.sh:131-133`), though the behavior is correct.
- Some commit bodies predate the current wrapping standard (already noted, cosmetic).

## Bottom line

The safety-critical surface — deletion durability, restore no-resurrection, retention bounds, migration compatibility, privacy, cost ceilings, cross-scope isolation — is well-built and the four hardest claimed fixes survive hostile inspection. The one material defect is Finding #1: the reply-fallback fix is incompletely wired, so an independent embedding-provider fault still takes text replies offline, contradicting a specific claimed fix and an explicit availability guarantee. That should block sign-off until the ~2-line degrade is added (or the guarantee is re-scoped). The remaining items are Low and largely fail-safe or by-design.

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 5
CRITICAL_COUNT: 0
HIGH_COUNT: 1
MEDIUM_COUNT: 0
LOW_COUNT: 4
CONFIDENCE: high
BLOCKING: yes
SUMMARY: Deletion/restore/retention/privacy/migration claims hold, but the reply-fallback fix is incomplete — an embedding-provider fault still takes text replies fully offline (High), contradicting claim #3.
---END_ADVERSARIAL_REVIEW_STATUS---
