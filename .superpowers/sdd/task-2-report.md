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
- 32 test files passed with 265 tests.
- Coverage: 90.38% statements, 83.37% branches, 90.90% functions, and 91.88%
  lines.
- The production TypeScript build passed.

## Concerns

No known blockers. `src/discord/gateway.ts` remains intentionally excluded by
the project coverage configuration; pagination/deletion proof is in the
directly covered reconciliation service, while the Discord adapter is checked
by lint, typecheck, and build.

## Independent review response

All six substantiated findings from the independent review were resolved
test-first:

1. Durable provenance now survives raw retention without retaining raw source
   text. `SqliteMemoryStore.maintain` scrubs expired source content while a
   durable memory still needs the stable source and author identity; completed
   extraction jobs are removed. The source row is deleted once no durable
   memory or unfinished job references it.
   - RED: the self-forget retention test returned `ambiguous`, and the
     post-retention Discord deletion test left one memory active.
   - GREEN: both focused tests pass and assert the retained source content is
     empty before self-forget or authoritative Discord deletion revokes it.
2. Source-derived context commits now require a source revision checksum and
   reject omission before mutation.
   - RED: `channel-context-service.test.ts -t "without a revision checksum"`
     activated a document.
   - GREEN: the same test throws the missing source revision checksum error;
     the stale-checksum and tombstone tests remain green.
3. Discord request anchoring, cursor direction, coverage, terminal boundaries,
   retention filtering, and rate-limit proofs moved out of excluded
   `gateway.ts` into covered reconciliation code. The gateway now only fetches,
   normalizes transport messages, and delegates page proof construction.
   - RED: four direct pagination tests failed because the covered functions did
     not exist.
   - GREEN: all four pass for after/before cursors, nonterminal ranges,
     incremental/retention terminals, and incomplete rate-limit pages.
4. Chief creates now use recorded-snowflake identity. Recorded callback rows are
   ignored; an unrecorded Chief create is recovered through the lifecycle
   without generation. The callback still repairs authoritative request,
   response, and chunk lineage if reconciliation wins the race.
   - RED: both recorded-ignore and unrecorded-recovery controller tests failed.
   - GREEN: both pass, and the existing reconciliation-won callback race test
     remains green.
5. A newer human edit now suppresses all active context descendants and removes
   their FTS/vector rows before the canonical source and fresh jobs are
   applied. The existing `retention-expired` scrub reason is reused for this
   internal invalidation rather than expanding the public deletion reasons.
   - RED: the edit left the active rollup, summary, FTS row, and vector intact.
   - GREEN: the focused edit test observes a scrubbed/suppressed document, no
     search rows, and fresh pending jobs.
6. Migration `0004_discord_source_lifecycle` now adds a nonnegative nullable
   `response_chunk_index`; its checksum is bumped to `chief-0004-v2`.
   Delivery callbacks persist/repair that ordinal, and prompt grouping orders
   chunk content by ordinal rather than insertion ID.
   - RED: reverse reconciliation failed because `response_chunk_index` did not
     exist.
   - GREEN: the callback repairs ordinals `0, 1`, and recent prompt assembly
     returns the delivered first/second order despite reverse insertion.

Review verification completed with 24 focused Discord unit tests and 61 focused
integration tests, followed by `pnpm verify`: all 32 files and 264 tests passed,
coverage stayed above repository thresholds, and formatting, lint, typecheck,
and the production build all passed.

## Critical re-review response

The remaining retained-identity deletion gap was resolved test-first.

- RED: an end-to-end test created a durable memory, ran both raw-maintenance
  paths, and then omitted the source snowflake from a completed weekly identity
  scan covering that exact range. Reconciliation completed but emitted zero
  deletion callbacks, leaving the durable memory, retained source provenance,
  and missing tombstone/journal unchanged.
- GREEN: deletion inference now includes a scrubbed `retention-expired`
  canonical row only when a text `source_events` identity still matches its
  exact guild/channel/message scope. The completed scan invokes the normal
  authoritative delete lifecycle, which revokes the durable memory and
  content-free provenance and writes the tombstone/journal without restoring
  expired raw content.
- Range checks and the completed-pass gate are unchanged. Existing focused
  tests continue to prove incomplete and rate-limited passes cannot infer
  deletion. Repeating a completed weekly omission after the full-scan interval
  emits no second callback, proving idempotency after the retained identity is
  removed.

Final verification passed with the 12 reconciliation unit tests and 7 source
lifecycle integration tests focused first, then `pnpm verify`: formatting,
lint, typecheck, all 32 test files and 265 tests, coverage thresholds, and the
production build all passed.
