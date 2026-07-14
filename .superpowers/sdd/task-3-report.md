# Task 3 report: run protected context rollups

## Status

Complete.

## Delivered

- Added one process-wide paid-work queue. Interactive work wins the next slot,
  background work is serialized, reservations happen only after admission, and
  shutdown stops new submissions and drains accepted work before SQLite closes.
- Added a unified background scheduler that selects eligible live memory or
  context work by freshness deadline, fairly rotates equal deadlines, and only
  considers historical backfill when no live work is eligible.
- Added provisional and final hourly rollups, daily and weekly hierarchy,
  daily topic proposals, weekly topic consolidation, stable topic keys,
  downstream freshness deadlines, retry/lease recovery, and redacted lag
  status.
- Added strict structured context summarization through the configured memory
  model and memory prices. All returned lineage IDs must be among the supplied
  source IDs.
- Added deterministic source-token segmentation. Internal segment documents
  retain provenance and usage metadata but have no FTS/vector exposure; one
  visible aggregate document is indexed.
- Added atomic document activation, lineage, usage metadata, search/vector
  indexing, downstream scheduling, and stale parent-descendant suppression.
- Added indexing-category and priority accounting, a configurable indexing
  sub-ceiling, conservative interactive headroom, restart reconstruction,
  occurrence-month attribution, and a monotonic lifetime backfill-run ceiling.
- Added tiered retention: raw and expired hourly/daily content and search rows
  are scrubbed while content-free identities, period metadata, reasons, and
  lineage remain. Weekly and long-term content is retained until explicit
  purge.
- Extended branch-local migration `0004_discord_source_lifecycle` for context
  job deadlines/reservations, internal/topic documents, occurrence-month usage,
  and backfill-run attribution. Migrations 0001 and 0002 were not changed.

## TDD evidence

- Queue priority and shutdown began with missing shared-queue behavior, then
  passed focused unit tests proving an interaction runs before queued
  background work and shutdown rejects new work while draining the active job.
- Shared scheduler tests first failed for missing scheduling, fairness, live
  precedence, and pre-deadline eligibility, then passed.
- Budget tests first failed for missing categories, indexing limits, headroom,
  cross-month attribution, restart reconstruction, and lifetime run spend,
  then passed against SQLite.
- Rollup integration tests first failed for missing provider execution,
  deadlines, downstream hierarchy, deferral, retry exhaustion, stale lease
  recovery, segmentation, retention, and parent invalidation, then passed.
- Provider adapter tests first failed for the missing module and unknown-source
  acceptance, then passed with strict Zod and supplied-ID validation.

No test makes a paid provider call; all provider, clock, and embedding behavior
is deterministic and local.

## Verification

`pnpm verify` passed:

- Prettier, ESLint, and TypeScript checks passed.
- 36 test files passed with 293 tests.
- Coverage: 89.87% statements, 82.37% branches, 91.34% functions, and 91.66%
  lines.
- The production TypeScript build passed.

`git diff --check` also passed.

## Concerns

No known blockers. Historical backfill is an optional scheduler source here;
Task 6 owns its producer and will attach it to the already-tested backfill
slot.

## Independent review response

All seven substantiated findings were reproduced and resolved test-first.

1. Closed-hour finality now dominates provisional work. Late reconciled
   activity does not requeue a provisional job, and any stale provisional lease
   completes without provider work once its period has ended or an active final
   revision exists.
   - RED: draining late-source work left the closed hour active as
     `provisional`.
   - GREEN: the drained hierarchy keeps the hourly document `final` and
     completes its rebuilt daily downstream job.
2. Rollup provenance now contains every supplied input, independently of the
   model's cited subset. The commit transaction also requires the exact leased
   job, attempt, checksum, unexpired lease, and reservation to remain current.
   Conditional retry cannot resurrect an invalidated job.
   - RED: a subset response persisted one of two supplied event IDs; deleting
     the omitted input while the provider was pending still committed a
     document.
   - GREEN: successful subset output persists both inputs, while the deletion
     race returns `failed` with no document, FTS row, vector, or downstream job.
3. Successful document activation, job completion, downstream scheduling, and
   usage reconciliation now share one SQLite transaction. Conservative stale
   recovery charges the full persisted reservation, including segmented
   multi-call work.
   - RED: a trigger-injected ledger failure left the document committed, and a
     stale segmented reservation reconciled at the base estimate.
   - GREEN: the injected failure rolls back every context write and leaves the
     reservation recoverable; the segmented stale lease reconciles its full
     stored USD 0.35 before retry.
4. Automatic memory extraction distinguishes temporary interactive headroom
   from monthly capacity exhaustion.
   - RED: headroom pressure deferred the job to the next UTC month.
   - GREEN: it defers for five seconds with attempt count unchanged; the
     existing overall-ceiling test still defers to the next month.
5. Provisional freshness now includes bounded execution allowance.
   - RED: eligibility and freshness were both activity plus five minutes.
   - GREEN: eligibility is activity plus four minutes and the deadline remains
     activity plus five minutes.
6. Runtime health now exposes the exact redacted context status as diagnostics
   without treating ordinary indexing degradation as a readiness failure.
   - RED: `/healthz` omitted the supplied context diagnostic.
   - GREEN: a degraded `indexing-budget` diagnostic is returned with HTTP 200
     while readiness depends only on critical checks.
7. Background selection now occurs inside the acquired queue slot with an
   injectable current clock.
   - RED: backfill selected before an interaction remained first even after
     live context became eligible while waiting.
   - GREEN: the queued slot rechecks and runs context at the current time;
     backfill remains untouched.

Focused review verification passed with 21 integration tests and 54 unit tests.

Final review verification passed with `pnpm verify`: formatting, lint,
typecheck, all 36 test files and 299 tests, coverage thresholds (90.02%
statements, 82.65% branches, 91.63% functions, and 91.69% lines), and the
production build all passed.
