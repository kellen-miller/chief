# Task 5 report: authorize and coordinate forgetting

## Status

Complete.

## Delivered

- Routed text forget and confirmation intent through
  `ChannelContextService.forget` before any provider call, embedding, or budget
  reservation. Remember and correction intent retain the existing durable-memory
  path, so corrections remain later historical evidence and may supersede an
  accepted memory under the existing policy.
- Added redacted candidate discovery across retained source FTS, active context
  documents, and active durable memory. Authorization receives stable source,
  document, and memory identifiers rather than matched content.
- Enforced self-only deletion for ordinary members and current administrator or
  owner authority for cross-member, topic, and provenance-free memory deletion.
  Missing authority fails closed, including when permission disappears between
  the initial request and confirmation.
- Made ambiguous narrow requests clarify without mutation. Broad requests always
  create a five-minute confirmation, while a narrow unambiguous self-authored
  source may execute directly. Confirmation nonces are random, stored only as a
  checksum, scoped to the requester, consumed once in the deletion transaction,
  and removed after expiry.
- Added one synchronous `ContextDeletionStore` transaction on the shared
  better-sqlite3 connection. It consumes confirmation, scrubs selected raw text
  and attachment metadata, removes source FTS, suppresses every active descendant
  document, removes document FTS/vector rows, writes source/document/topic
  tombstones, supersedes affected durable-memory history, scrubs private memory
  snapshots, invalidates stale extraction work, schedules rollup rebuilds, and
  inserts the content-free journal outbox.
- Added synchronous, transaction-neutral `SqliteMemoryStore` deletion primitives.
  Supersession traversal includes predecessor memory versions without attempting
  a second FTS delete for versions whose index was already removed.
- Added migration `0005_context_forgetting` for stable candidate IDs, the original
  request source identity, and the content-free journal payload. Existing
  migrations remain unchanged and schema verification requires the new checksum.
- Added post-commit journal upload semantics. Completion is acknowledged only
  after upload; failure leaves local suppression active, marks a retryable row,
  degrades diagnostics with `forget-journal`, and returns a pending rather than a
  success receipt. Restart retry uses the same checksum-verified payload.
- Added idempotent checksum-verified replay for restored databases. Replay
  recreates tombstones from the journal even when an older backup predates the
  referenced raw source, document, or durable memory, then scrubs any rows that
  are present and records the journal as uploaded.
- Extended authoritative Discord suppression journals with a valid content-free
  payload so the same recovery guarantee can be used for local and external
  deletion.
- Preserved the user-facing recovery caveat: active local context is absent at
  acknowledgement, while older encrypted recovery copies may remain for up to
  the separately governed 30-day retention window.

## TDD evidence

The implementation followed focused RED-GREEN cycles:

- `ChannelContextService.forget` did not exist, then narrow self deletion removed
  raw SQL, attachments, source FTS, descendant summaries, document FTS/vectors,
  durable memory FTS/vectors, and private source snapshots.
- A broad administrator request deleted immediately, then persisted redacted
  stable IDs and required a random, expiring, requester-bound confirmation.
- A consumed nonce could run twice, then confirmation consumption moved inside
  the deletion transaction and replay returned `confirmation-invalid`.
- Cross-member and missing-permission requests revealed behavior inconsistently,
  then both candidate-present and no-match broad requests returned the same
  content-free refusal. Current permission is rechecked at confirmation time.
- A one-result broad self request bypassed confirmation, then every broad scope
  required confirmation while narrow self deletion remained direct.
- Ambiguous narrow lexical matches offered destructive action, then returned
  clarification with no request row or mutation.
- Provenance-free durable memory had no source tombstone, then a topic tombstone
  made the purge durable and replayable.
- Forgetting an active correction left its superseded predecessor and private
  source snapshot intact, then recursive predecessor traversal scrubbed both.
- An injected journal insertion failure left partially scrubbed stores, then the
  single outer transaction rolled back raw SQL, FTS, tombstones, documents, and
  memory together.
- Failed upload incorrectly implied completion, then it retained active local
  suppression, a retryable journal, degraded diagnostics, and a non-success
  acknowledgement until restart upload succeeded.
- Raw evidence past retention could not be selected by member identity, then
  content-free authorship identity remained discoverable and authorized without
  restoring raw text.
- A stale leased rollup completed after local forgetting, then the commit guard
  rejected it and a rebuild used only remaining active lineage.
- Restore replay assumed every journal source still existed, then it recreated
  source and topic tombstones from the verified payload even when the backup
  lacked the referenced source or memory. Replay is idempotent.
- The natural-language forget command remained in recent context, then the
  request's stable source identity joined the same local scrub and journal.
- Authoritative Discord deletion wrote a legacy empty journal payload, then it
  emitted the same checksum-verified content-free shape.
- The orchestrator sent forget intent through the older paid memory mutation
  path, then it bypassed the agent, embedding, extractor, and budget entirely.

No test calls a paid provider. Provider functions, embeddings, clocks, upload,
backup files, and concurrent job completion are deterministic local fixtures.

## Verification

`pnpm verify` passed before this report update and is rerun after all plan/report
edits:

- Prettier, ESLint, and both TypeScript builds passed.
- 40 test files passed with 345 tests: 231 unit and 114 integration.
- Coverage: 91.07% statements, 83.25% branches, 93.71% functions, and 92.57%
  lines.
- `ContextDeletionStore`: 92.73% statements, 79.27% branches, 98.33% functions,
  and 93.26% lines.
- Focused forgetting passed 31 integration tests. Focused orchestrator passed 30
  unit tests, and focused rollup/rebuild passed 14 integration tests.
- `git diff --check` passed before commit.

The tests verify absence from raw SQL, source/document/memory FTS, document and
memory vectors, assembled prompt context, private extraction snapshots, and an
offline-consistent backup created after purge. A separate pre-purge backup is
restored and journal-replayed twice; a second restored fixture omits the raw
source entirely. All remain suppressed.

## Design notes

- Candidate interpretation and authorization stay outside the mutation. The
  mutation accepts only stable IDs and synchronous store primitives.
- A confirmation is authorization state, not permanent authority. The service
  reevaluates the current permission snapshot before consuming it.
- The outbox payload is intentionally sufficient to enforce deletion against an
  older artifact that may not contain all referenced rows. Tombstones therefore
  derive from the verified payload, while row scrubbing is conditional on what
  the restored database contains.
- Superseded external-content FTS rows have already been removed. Deletion scrubs
  predecessor table content but deletes indexes only for currently active
  versions, avoiding invalid repeated FTS deletes.

## Concerns

No Task 5 blocker. Production GCS adapter wiring, unconditional host startup
preflight, bucket lifecycle policy, and operational health exposure remain in
the planned operational milestone. Task 5 provides the content-free upload,
retry, degradation, and replay seams those integrations consume. No live data,
Discord messages, paid API, deployment, push, or backfill was touched.

## Correction review response

Status: all requested changes resolved. This section supersedes the earlier
production-uploader concern: the immutable GCS adapter and runtime drain are now
part of Task 5.

1. Broad discovery now uses the same shared lexical normalization as retrieval
   and requires every relevance anchor to occur in each candidate. Discovery is
   paginated across sources, documents, and memories, has no per-store top-20
   truncation, and refuses rather than acknowledges when the complete stable-ID
   set exceeds 1,000 entries. Project Marigold no longer captures Project
   Juniper; 21 exact matches cross a page boundary; 1,001 matches fail closed
   without a request or mutation.
2. Deletion expands from every stable document key to all revisions, then walks
   every descendant. It scrubs superseded and internal summaries, clears
   document and matching job topic labels, removes active indexes, and leaves no
   sensitive summary or label in a post-purge SQLite backup.
3. Migration `0005_context_forgetting` now translates pre-0005 pending
   authoritative journals into the content-free payload and recomputes their
   checksum in the migration transaction. A database stopped after migration
   0004 upgrades, flushes the old row, and replays it into a restored database.
4. Production constructs a real create-only GCS uploader from the required
   `CHIEF_BACKUP_BUCKET`, provisioned from the existing Terraform backup bucket.
   Runtime drains once before optional paid startup work and before ordinary
   background work. Immutable-object retries compare bytes, so a persisted write
   followed by a lost acknowledgement succeeds safely after process restart.
5. Forgetting requeues hourly, daily, weekly, and long-term topic work using
   checksums recomputed from remaining active lineage. An end-to-end regression
   removes an entire hour, then rebuilds every completed parent tier from the
   surviving sibling hour without reintroducing the forgotten marker.
6. Rebuild invalidation no longer clears a leased usage reservation. A
   crash-shaped regression forgets while summarization is in flight, restarts
   the service, conservatively reconciles the durable ledger reservation, and
   only then clears the job reference.
7. Hidden and absent narrow matches now return the same clarification response;
   hidden and absent broad matches retain the same refusal response. Neither
   path persists a deletion request.
8. Member lookup groups exact display-name matches by stable Discord speaker ID
   and refuses when one display name maps to multiple identities.

Document tombstones now store the stable `documentKey` used by activation
guards, not a revision row ID. The direct-delete regression rejects a later
revision with the same key, while restore replay recreates that same stable key.
The shared synchronous document scrubber is used by both delete and replay.

Focused RED-GREEN evidence included the original unrelated Juniper deletion,
the 20-row truncation, active-only revision leakage, stranded downstream jobs,
an empty migration payload checksum failure, a missing production uploader, and
an orphaned leased reservation. The correction suite uses only local SQLite,
fake provider functions, and an in-memory GCS protocol fake; it performs no paid
or network calls.

Final correction verification passed with `pnpm verify`:

- Prettier, ESLint, both TypeScript builds, and all 41 test files passed.
- 356 tests passed.
- Coverage was 91.78% statements, 84.36% branches, 94.28% functions, and
  93.25% lines.
- `ContextDeletionStore` coverage was 93.33% statements, 83.54% branches,
  97.43% functions, and 93.93% lines.

`git diff --check` is run again immediately before the correction commit.
