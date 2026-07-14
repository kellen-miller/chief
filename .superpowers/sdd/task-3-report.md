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
