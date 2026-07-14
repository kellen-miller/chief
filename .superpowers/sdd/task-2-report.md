# Task 2 report: normalize live Discord source lifecycle

## Status

Complete.

## Delivered

- Added normalized Discord source messages with timestamps, reply lineage,
  safe attachment name/description metadata, requester identity, Chief/human
  classification, revision checksums, and fail-closed moderator snapshots.
- Added partial create/update recovery, immediate single/bulk deletion,
  edit/delete lifecycle handlers, cached channel history access, and redacted
  shard/reconciliation health signals without the Guild Members intent.
- Routed eligible human sources through one synchronous
  `ChannelContextService.apply` transaction for canonical conversation, source
  FTS, context jobs, and memory-extraction snapshots. Edits invalidate old
  source-derived memories and jobs; deletes scrub every local source surface
  and active context descendant.
- Recorded delivered Chief chunks only after Discord returns their real
  snowflakes. Each callback carries the ordered delivered list, records each
  chunk independently with Discord occurrence time and bot identity, repairs
  lineage if reconciliation won a race, and never schedules automatic memory
  extraction for Chief text.
- Added revision/tombstone checks inside memory and context commit
  transactions, plus self-or-current-admin authorization for natural-language
  memory deletion.
- Added `DiscordReconciliationService` with durable high-water, retained, and
  independent full-scan cursors. Complete retained/full ranges may infer
  deletions; failed, incomplete, and rate-limited passes cannot. Runtime retries
  gap scans hourly and schedules the identity-only full scan at least weekly.
- Added migration `0004_discord_source_lifecycle`, setup documentation, direct
  unit tests for normalization/reconciliation, and integration tests for source
  create/edit/delete, reply lineage, stale work, and authorization.

## TDD evidence

- Normalization began with a missing-module failure, then passed four focused
  unit tests.
- Source lifecycle began with the missing `revision_checksum` schema failure;
  stale memory/context commits and deletion synchronization were added from
  focused failing integration tests.
- Gateway controller lifecycle began with missing update/delete methods;
  ordered delivered chunks and reconciliation-won lineage were each observed
  failing before their fixes.
- Reconciliation began with a missing service module; incomplete-range,
  retained-cursor, and independent full-cursor tests were observed failing
  before implementation.
- Natural-language deletion authorization and modal destructive-intent parsing
  were observed failing before enforcement.

## Review

Parallel standards and specification reviews were completed. Their actionable
findings were addressed by:

- using actual Discord delivery timestamps and bot identity;
- making snowflakes the platform event keys;
- preserving callback lineage when reconciliation and delivery race;
- retaining interrupted retained and full-scan cursors independently;
- retrying failed gap reconciliation instead of waiting for a weekly scan;
- bounding completed reconciliation seen sets; and
- keeping the weekly full scan asynchronous from gateway readiness.

The literal ordered-chunk callback requirement is satisfied cumulatively while
still persisting each successful chunk immediately, including before a later
send fails. Full scans remain identity-only; the preceding retained scan is the
content-bearing path that applies eligible revisions inside raw retention.

## Verification

`pnpm verify` passed:

- Prettier, ESLint, and TypeScript checks passed.
- 32 test files passed with 254 tests.
- Coverage: 90.30% statements, 83.00% branches, 91.08% functions, and 91.78%
  lines.
- The production TypeScript build passed.

## Concerns

No known blockers. `src/discord/gateway.ts` remains intentionally excluded by
the project coverage configuration; pagination/deletion proof is in the
directly covered reconciliation service, while the Discord adapter is checked
by lint, typecheck, and build.
