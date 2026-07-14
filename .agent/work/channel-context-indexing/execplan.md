# Build hierarchical channel context indexing

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. Maintain this file in accordance with `.agent/PLANS.md` from the repository root.

## Purpose / Big Picture

Chief already records eligible unmentioned messages from the configured main Discord channel, but a later request sees only the newest 30 conversation events (about 6,000 tokens) plus facts that automatic durable-memory extraction accepted. After this work, Chief can answer questions about what the group discussed earlier in the hour, yesterday, last week, or over the long term even when nobody mentioned him during the original discussion. He will search a provenance-backed hierarchy of hourly, daily, weekly, and long-term historical context while continuing to distinguish discussion from accepted communal facts.

The implementation must preserve Chief's mention-only behavior, current durable memories, voice/text continuity, usage ceiling, backups, and response availability. Background indexing is silent, lower priority than interaction, and allowed to degrade without making Discord unavailable. A user can observe the result by discussing a topic without mentioning Chief, waiting for the relevant tier to close, then asking him for a recap or source; tests and live acceptance must prove the same behavior at every tier.

The complexity dividend is one deep context assembly seam. Today the orchestrator separately knows how to fetch a recent timeline and ask `MemoryService` for durable memories. It must not grow four tier-specific retrieval branches, embedding calls, budget checks, and prompt formatting rules. The completed system concentrates that policy in `ContextAssembler`, keeps historical lifecycle policy in `ChannelContextService`, and leaves Discord and provider adapters concerned only with normalized inputs and outputs.

## Progress

- [x] (2026-07-14 03:08Z) Inspected the current Discord, conversation, memory, usage, health, CLI, deployment, and test paths from a clean isolated worktree.
- [x] (2026-07-14 03:08Z) Completed the product grill and obtained approval for all design sections.
- [x] (2026-07-14 03:08Z) Created `decision.md`, `meta.json`, `CONTEXT.md`, ADR 0001, and this initial ExecPlan.
- [x] (2026-07-14 03:51Z) Ran two adversarial planning passes, resolved every verified critical/high issue, and incorporated the final medium/low recovery and implementation seams.
- [x] (2026-07-14 04:58Z) Obtained explicit user approval of the adversarially revised written planning packet and activated implementation.
- [x] (2026-07-14 05:08Z) Task 1 created migration 0003, DST-safe context periods, canonical source/FTS writes, hourly job records, retention separation, delivered-snowflake identity, and transactional document invariants; 233 tests and `pnpm verify` passed, and the task review approved the five-commit range with no findings.
- [x] (2026-07-14 06:41Z) Task 2 normalized live Discord creates, edits, partials, single/bulk deletes, and delivered Chief chunks; synchronized edit/delete effects across source, memory, and context state; added resumable gap and weekly identity reconciliation with persisted coverage proof; and passed 267 tests plus a clean final review after three correction loops.
- [x] (2026-07-14 08:05Z) Task 3 added one protected paid-work queue, fair deadline-ordered background scheduling, categorized/month-safe budget accounting, provisional/final hourly plus daily/weekly/topic rollups, strict bounded summarization and segmentation, tiered retention, non-readiness lag diagnostics, and graceful draining; 300 tests and final review passed after two correction loops.
- [x] (2026-07-14 09:39Z) Task 4 assembled one bounded text/Realtime context with one embedding per query, per-tier source and rollup retrieval, recent/history budgeting, provenance links, deterministic replay, privacy/as-of boundaries, and utterance-safe voice recall; 331 tests and final review passed after three correction loops.
- [x] (2026-07-14 11:43Z) Task 5 implemented redacted cross-store candidate discovery, current self/admin authorization, single-use broad confirmation, one synchronous atomic deletion shared by local and authoritative Discord suppression, immutable GCS upload/retry, content-free migration-safe replay, complete revision scrubbing, and stale-job-safe lineage rebuild; 362 tests and final review passed after three correction loops.
- [x] (2026-07-14 12:22Z) Task 6 added an aggregate-only reverse manifest, owner-confirmed activation, GET-only Discord REST history, bounded derived-only expired-history processing, oldest-first resumable segment commits, tombstone/revision guards, and shared queue/budget execution; 388 tests and the repository gate passed.
- [x] (2026-07-14 12:58Z) Task 6 review correction attributed every induced rollup and reservation to its run, kept runs active through their complete hierarchy, enforced hard provider-cost contracts, anchored refetch to exact manifest ranges, made segment identity source-derived, and reduced same-hour aggregation to a bounded rolling pair; 396 tests and coverage passed.
- [x] (2026-07-14 13:19Z) Task 6 re-review correction returned coalesced live work from non-active backfills to live ownership while preserving conservative reservations, and added an append-only lifecycle migration that pauses and attributes ambiguous populated-0006 work before explicit resume; 400 tests and coverage passed.
- [x] (2026-07-14 14:41Z) Task 6 final ownership correction added immutable live/backfill reservation origin, origin-driven migration repair, durable fail-closed holds for irreducibly ambiguous pre-provenance accounting, and reservation-aware run drain; the repository gate passed 417 tests with 91.30% statement, 84.13% branch, 93.88% function, and 92.81% line coverage.
- [x] (2026-07-14 14:53Z) Task 6 final provenance review enforced accounting holds inside atomic ledger reconciliation; the final independent review approved commits `345887d..0289f53` with no findings, and the repository gate passed 417 tests with 91.31% statement, 84.15% branch, 93.88% function, and 92.78% line coverage.
- [x] (2026-07-14 15:22Z) Milestone 7 separated critical readiness from bounded redacted context diagnostics; packaged timezone and indexing-budget configuration; added schema-aware verification, content-free journal replay, image/database-safe deploy and restore paths, fail-closed startup recovery, 30-day artifact pruning, prefix-specific bucket lifecycle policy, and complete operator documentation. The repository gate passed 431 tests; container smoke, fixture restore drill, shell syntax, and Terraform validation passed without live or paid calls.
- [x] (2026-07-14 15:55Z) Task 7 independent review correction made partial migration failure rollback-safe; retained memory-only source scopes in journals; replaced count-only context-index checks with exact FTS/vector verification; bound verified database capability to the target runtime image; and replayed every current and noncurrent GCS journal generation without local overwrite. The repository gate passed 438 tests; container smoke, fixture restore drill, shell syntax, and Terraform validation remained green.
- [x] (2026-07-14 16:20Z) Task 7 re-review correction added append-only migration 0013 to retain valid legacy Discord text source identity through a 0002-to-current upgrade, made memory-source discovery and migration-0002 replay use that stable identity, and made explicit context verification honor the recorded schema prefix so an exact migration-0003 database is runnable. The repository gate passed 440 tests; exact-0003/current capability checks, container smoke, fixture restore drill, shell syntax, and Terraform validation passed.
- [x] (2026-07-14 16:47Z) Task 7 final no-resurrection correction made a valid legacy bare Discord snowflake an exact alias of the terminal component of a composite source scope across live ingestion, backfill, context commits, memory mutation, and deletion. The original transaction now writes the legacy tombstone before mutation and journal upload; repeated memory-index deletion is idempotent without masking missing active indexes. The full repository gate passed 447 tests, focused recovery probes passed, image `sha256:3ab458c50ee206ce6fef4ba0a64c86dc568728959840e44c666edd841c6e1136` advertised migration-0003 capability and returned `READY`, and the restore/journal drill left no source content, jobs, FTS rows, or vectors. Final independent review approved the correction with no findings.
- [x] (2026-07-14 17:11Z) Milestone 8 added a 44-case deterministic quality corpus across every approved category and tier, a shared real `ContextAssembler` replay used by CI and the optional paid evaluator, a dedicated structured grader seam, complete-production-payload safety accounting, exact provenance validation, requested-link recall, and per-class classification gates. The final repository gate passed 451 tests with 91.48% statement, 84.02% branch, 94.39% function, and 92.90% line coverage; independent review approved the final correction with no findings.
- [ ] Owner-only production acceptance: deploy, run the paid pinned-corpus grade, verify live Discord freshness/deletion/restart behavior, run the spend-limited backfill sample, and finish the authorized resumable backfill. These actions remain intentionally unrun.

## Surprises & Discoveries

- Observation: the requested ambient observation already exists in a bounded form. `DiscordTextController.handle` sends allowed unmentioned messages to `ConversationOrchestrator.handleText` with `kind: 'observe'`, which records them without replying.
  Evidence: `src/discord/text-controller.ts` and `test/unit/discord-text-controller.test.ts` include the silent-observation path.
- Observation: immediate context is not relevance-indexed. `ConversationStore.recent` selects at most 30 nonexpired events and stops near 6,000 approximate tokens.
  Evidence: `DEFAULT_MAX_MESSAGES` and `DEFAULT_MAX_APPROX_TOKENS` in `src/conversation/conversation-store.ts`.
- Observation: raw text currently exists in two purposeful forms: the seven-day `conversation_events` timeline and the 30-day `source_events` extraction snapshot. Context retrieval must treat `conversation_events` as the canonical channel ledger while preserving `source_events` as private input to the deployed memory-job schema until those jobs expire.
  Evidence: migrations `0001_initial` and `0002_conversation_events` in `src/memory/database.ts`, plus the two writes in `ConversationOrchestrator.handleText`.
- Observation: the memory worker runs on its own timer outside the orchestrator's serialized paid-generation queue. Adding another independent timer would violate interactive priority.
  Evidence: `ConversationOrchestrator.#queueTail` and the `memoryService.runAutomaticOne` interval in `src/runtime.ts`.
- Observation: the gateway subscribes only to `MessageCreate` and `InteractionCreate`; it cannot currently apply Discord edits or deletions.
  Evidence: `DiscordGateway.start` in `src/discord/gateway.ts`.
- Observation: Node in this workspace does not expose `Temporal`; custom local-time offset arithmetic would be fragile at daylight-saving transitions.
  Evidence: `node -p 'typeof Temporal'` returned `undefined`. Use exact dependency `@js-temporal/polyfill@0.5.1` and test both 2026 New York transitions.
- Observation: Realtime voice currently recalls communal memory dynamically through a model-invoked tool, so preparing historical context only when a voice session opens would miss the user's later spoken query.
  Evidence: `src/agent/openai-voice.ts` defines the current communal-memory recall tool. Voice must use a unified dynamic context-recall tool instead of a session-open snapshot.
- Observation: budget admission currently precedes serialized provider execution. Queue priority by itself therefore cannot keep background reservations from consuming the headroom needed by a later interaction.
  Evidence: `ConversationOrchestrator` reserves before its current queue boundary, while `UsageBudget` includes outstanding reservations in admission.
- Observation: every boolean returned by the current health check factory contributes to readiness. Adding context freshness booleans to that object would incorrectly take Discord offline when indexing is merely degraded.
  Evidence: `src/health/health-server.ts` computes readiness over the complete check map. Critical readiness and diagnostics need distinct shapes.
- Observation: a better-sqlite3 transaction is synchronous, while the public memory service is asynchronous and may perform provider work. Cross-store forgetting cannot safely call `MemoryService` from inside the deletion transaction.
  Evidence: the current stores use synchronous better-sqlite3 transaction callbacks. Deletion needs synchronous store primitives, with provider work deferred until after commit.
- Observation: encrypted database backups can retain bytes that have since been forgotten until the current 30-day GCS lifecycle removes the backup object.
  Evidence: production backup storage is versioned with a 30-day deletion lifecycle and grants the runtime object create/read rather than broad object-admin access. Restore must replay a content-free forget journal before a backup is runnable.
- Observation: recovery copies are also written to `/var/lib/chief/pre-deploy` and `chief.db.failed.*`; without explicit pruning, those logically plaintext SQLite files can retain forgotten bytes indefinitely on the encrypted persistent disk.
  Evidence: `scripts/deploy.sh` and `scripts/restore.sh` create those files and currently define no age-based cleanup.
- Observation: a restore-side replay command alone cannot enforce the no-resurrection guarantee because an operator could replace `chief.db` and start the service directly, and an image predating migration 0003 cannot interpret the new journal.
  Evidence: `chief.service` starts `/opt/chief/run-container.sh` directly. The host-side start path needs an unconditional recovery preflight that can use a newer recovery image independently of the target runtime image.
- Observation: the restore-resurrection risk applies to authoritative Discord deletion as well as natural-language local forgetting.
  Evidence: an older database backup predates either kind of tombstone. Journal every source deletion and local forget, not only explicit forget commands, before allowing a restored database to serve context.
- Observation: storing Chief replies after a complete multi-chunk send loses canonical history when a later chunk fails.
  Evidence: Task 1 review drove incremental persistence immediately after each successful Discord send, using one logical response ID and stable snowflake per chunk.
- Observation: final-child hierarchy needs both positive and negative constraints: higher tiers require final parents and must reject raw event lineage even when a valid parent is also present.
  Evidence: successive Task 1 review regressions closed parentless and mixed-lineage bypasses before document, FTS, vector, or lineage mutation.
- Observation: a full-channel deletion scan cannot bound coverage by the newest surviving message. The deleted source may itself have been the newest indexed identity, including after raw content expires.
  Evidence: Task 2 review reproduced a retained source `201` missing above surviving source `200`; the final design persists a scan-start snowflake ceiling, begins before that ceiling, and resumes with the same upper bound.
- Observation: durable deletion and self-forget need minimal provenance after raw retention, while the raw content must still be erased.
  Evidence: Task 2 review reproduced loss of authorization and deletion linkage when `source_events` rows were removed; maintenance now retains scope identity with empty content only while a durable memory still depends on it.
- Observation: a model-selected source subset is insufficient lineage for deletion safety. Every supplied rollup input must remain provenance even when the model cites only representative sources.
  Evidence: Task 3 review reproduced an in-flight summary committing after an omitted supplied source was deleted; complete-input lineage plus a current leased-job guard now blocks it.
- Observation: provisional finality must be checked both before paid work and inside the activation transaction.
  Evidence: Task 3 review reproduced final-to-provisional regression from late activity and a second race where provider work crossed the period boundary; closed hours now reject provisional activation at commit time.
- Observation: job success and usage reconciliation share one crash-consistency boundary.
  Evidence: Task 3 trigger injection rolled back document, lineage, search, vector, downstream, job, and ledger state together; expired segmented leases conservatively reconcile their full stored reservation.
- Observation: global vector top-k and chunk-level FTS limits can starve otherwise relevant tiers or logical Chief responses before policy sees them.
  Evidence: Task 4 changed vector retrieval to bounded per-tier searches and source retrieval to group logical responses before the public result limit, with explicit internal scan ceilings.
- Observation: scope, as-of, and exclusion filters must run before candidate limits; applying them afterward can return too few eligible results or leak future/cross-channel evidence into ranking.
  Evidence: Task 4 regressions cover recursive guild/channel lineage, current-turn exclusion, source exclusions, and rollup `beforeEventId` boundaries before rank and limit.
- Observation: lexical relevance needs an absolute query-local anchor, not only normalized FTS rank or a growing generic-word blacklist.
  Evidence: Task 4 paired distant-vector tests preserve named/selective evidence for capitalized and lowercase queries while rejecting modifier-only source and rollup matches.
- Observation: every Realtime context side effect must remain bound to the committed utterance across concurrent tool calls.
  Evidence: Task 4 coalesces concurrent recall, rejects greeting/noise queries, permits one successful call, and prevents stale cross-utterance completion from consuming the next utterance's allowance.
- Observation: authorization at confirmation creation is not sufficient for a delayed destructive action.
  Evidence: a requester could lose administrator authority during the five-minute confirmation window. Task 5 now reevaluates the current permission snapshot before it consumes the confirmation, while ordinary self-authorship remains independently valid.
- Observation: a verified forget journal must carry enough policy identity to suppress rows that do not exist in the restored artifact.
  Evidence: a pre-deletion backup can predate the selected source, document, or memory. Task 5 replay recreates source/document/topic tombstones from the content-free payload before scrubbing whichever referenced rows are present.
- Observation: aggregate-document lineage is provenance, not authorization to delete every contributing raw source.
  Evidence: Task 5 review reproduced a matched mixed-topic rollup deleting an unrelated same-hour message. Candidate selection now requires independently relevant raw sources while suppressing and rebuilding affected derived documents from surviving lineage.
- Observation: recovery journals cannot treat SQLite integer row IDs as stable across snapshots.
  Evidence: Task 5 review reassigned a document ID in a restored database and reproduced unrelated suppression. Replay now uses stable document keys and payload memory identities, including when source rows or lineage are absent.
- Observation: deletion replay payloads must be self-describing across both current emission and append-only migration.
  Evidence: Task 5 upgrade fixtures found invalid legacy payloads and loss of `locally-forgotten` reason. Migration 0005 now backfills content-free payloads, exact known reasons, and recomputed checksums before flush/replay.
- Observation: production acknowledgement semantics require a real outbox uploader and retry loop, not only an injectable service seam.
  Evidence: Task 5 review found runtime would otherwise leave every journal pending. Runtime now writes immutable GCS journal objects and drains pending rows on startup and in the background; host-wide fail-closed replay remains Task 7.
- Observation: an external-content FTS row for a superseded durable memory was already removed when the replacement became active.
  Evidence: deleting that index row again produced `SQLITE_CORRUPT_VTAB`. Task 5 traverses and scrubs the full predecessor chain but removes FTS/vector entries only for active indexed versions.
- Observation: resuming an aggregate-only dry-run cannot reconstruct duplicate identity from the durable manifest without persisting the source inventory.
  Evidence: Task 6 refetches every previously recorded page boundary to rebuild an in-memory seen-ID set before it continues from the durable cursor; overlapping pages remain deduplicated without durable raw IDs or text.
- Observation: a crashed paid backfill can leave a durable unresolved reservation that a newly constructed in-memory budget does not know about.
  Evidence: Task 6 restart tests leave an unresolved ledger row, require conservative reconciliation before admission, and pause against the approved run ceiling without invoking the provider again.
- Observation: page exhaustion is not run completion when backfill has induced daily, weekly, or topic work.
  Evidence: Task 6 review reproduced a run completing after the first page while unattributed downstream jobs continued outside its ceiling. Migration 0007 now carries the run foreign key through every induced job, and finalization waits for the attributed hierarchy.
- Observation: a configured estimate is not a safe reservation when a provider reports cost only after the call.
  Evidence: Task 6 review reproduced reported usage above both the reservation and run maximum. Reservations now cover a hard token-cost bound, and a provider contract violation is conservatively charged, committed nowhere, and pauses the run.
- Observation: reverse pagination must prove the exact persisted manifest interval, including the newest boundary on page zero.
  Evidence: Task 6 review inserted more than one REST page of newer concurrent creates. Processing now starts below the manifest ceiling and follows cursors until it proves coverage through the manifest page's oldest boundary.
- Observation: segment ordinals and all-prior-child aggregation are unstable under refetch changes and grow quadratically.
  Evidence: Task 6 review shifted an old page by removing one source and reproduced a skipped middle source, then split one hour into many segments and reproduced unbounded aggregation input. Segment keys now digest source identity and revision/text checksums; each new private leaf folds with only the active public hourly aggregate.
- Observation: a deterministic context job key can outlive the backfill run that first owned it.
  Evidence: Task 6 re-review reproduced newer live work coalescing into jobs owned by paused, failed, and replaced runs; the due and lease filters then excluded all three. Live conflict upserts now detach any non-active owner while retaining an old reservation for conservative recovery before live-paid work.
- Observation: adding nullable run attribution cannot reconstruct induced-job ownership in a populated legacy database.
  Evidence: a real 0006 fixture with an exhausted active run, pending and leased induced jobs, and an outstanding context reservation upgraded through 0007 with no attribution. Append-only migration 0008 now pauses the ambiguous run, attributes unfinished jobs and linked reservations conservatively, and requires explicit resume; additional ambiguous runs require rebuild.
- Observation: a reservation's mutable current run owner cannot prove whether live work was stolen by a migration or backfill work was detached by later job coalescing.
  Evidence: paired populated fixtures produce the same job and ledger ownership after migration 0008 but require opposite accounting results. Migrations 0011 and 0012 now preserve immutable reservation origin for new work and place genuinely pre-provenance reservations on an unleaseable accounting hold with explicit rebuild diagnostics. Final review also proved that scheduler exclusion alone was insufficient because direct ledger reconciliation could bypass the hold; the ledger transaction now rejects held reservations before any ledger or run mutation.
- Observation: recovery-journal payload row numbers cannot safely identify context documents in another SQLite snapshot.
  Evidence: Task 7 restore regressions created an unrelated document with the same numeric ID in the restored database. Replay now uses stable scope, source, and document keys plus lineage and deliberately ignores snapshot-local numeric IDs.
- Observation: listing only a missing GCS prefix can fail even when the bucket is reachable and contains no retained journals.
  Evidence: the host preflight must distinguish an empty journal set from an unreachable bucket. It now lists the bucket root as the availability proof, filters the exact `forget-journal/` prefix locally, and fails closed on malformed objects or any listing/download error.
- Observation: migration invocation, index row counts, recovery-image capability, and current-only GCS listings are each weaker than the invariant they were intended to prove.
  Evidence: Task 7 independent review reproduced a candidate migration that committed before failing, same-count FTS/vector corruption, a current database paired with an old runtime image, and a journal present only as a noncurrent generation. Rollback is now armed before migration; restore verification compares exact searchable content and identities; startup and restore bind database capability to the target image; and generation-qualified all-version replay is receipt-bound.
- Observation: a memory-only forget still depends on its private extraction source scope after the selected memory row is scrubbed.
  Evidence: replaying the emitted journal into a migration-0002 fixture left `source_events`, its pending job, and memory indexes intact until the deletion payload retained the stable guild/channel/message source identity.
- Observation: migration 0004 added `source_scope_id` with an empty default, so a real memory created under migration 0002 had no composite scope to retain when later forgotten.
  Evidence: a populated migration-0002 fixture upgraded to current with an empty scope; its memory-only journal omitted the source and migration-0002 replay left source text plus a pending extraction job. Migration 0013 now copies only a valid 17-20 digit Discord text snowflake from `platform_source_id`; prefixed voice/synthetic identities remain empty.
- Observation: explicit migration-0003 restore verification accidentally required columns from migration 0004 and backfill progress tables from migration 0006.
  Evidence: an exact migration-0003 fixture with valid searchable hourly, daily, weekly, and long-term documents returned no database capability and normal startup failed. Verification now applies the public-document predicate and progress checks only when their defining migrations are recorded.
- Observation: retaining a legacy bare Discord snowflake in a recovery journal is insufficient unless every future source-ingestion boundary treats it as the alias of the same composite guild/channel/message scope.
  Evidence: after a successful 0002 replay, live re-ingestion checked only the composite scope and could recreate the forgotten source. A shared exact alias rule now compares only a bare 17-20 digit snowflake with the terminal snowflake of an exact three-part scope; live ingestion, backfill, context commits, memory mutation, and deletion all enforce it with bounded indexed queries.
- Observation: deterministic quality counters can look complete while inspecting only fixture-selected target text instead of every item actually returned to the production prompt.
  Evidence: all history cases also returned a competing durable memory, but the first corpus runner removed it before forbidden-claim and leakage checks. The final safety surface serializes all returned historical context, communal memory, and source links; a distractor-only leak regression proves the complete surface is inspected.

## Decision Log

- Decision: use hierarchical hourly, daily, weekly, and long-term rollups rather than raw query windows or a topic graph.
  Rationale: this bounds retrieval and generation cost while supporting provenance, correction, deletion, and rebuild.
  Date/Author: 2026-07-13, user and Codex.
- Decision: historical context is evidence of discussion, while durable memory remains the accepted-fact mechanism.
  Rationale: casual chat contains jokes, speculation, disagreement, and abandoned plans that must not silently become truth.
  Date/Author: 2026-07-13, user and Codex.
- Decision: use `America/New_York` local hours, local days, and Monday-start local weeks.
  Rationale: human recap periods should match the community's calendar; an explicit timezone makes DST behavior deterministic.
  Date/Author: 2026-07-13, user and Codex.
- Decision: preserve the existing seven-day recent timeline, retain raw text and hourly context for 30 days, daily context for one year, and weekly/long-term context indefinitely.
  Rationale: this retains every requested horizon while limiting permanent raw-chat storage.
  Date/Author: 2026-07-13, user and Codex.
- Decision: use one overall usage budget with an indexing category sub-ceiling, not two independent budget objects.
  Rationale: two budget instances cannot safely coordinate outstanding reservations against one ledger; category accounting inside `UsageBudget` preserves the authoritative total.
  Date/Author: 2026-07-14, Codex from repository evidence.
- Decision: use one `ContextAssembler` interface for recent conversation, historical context, and durable-memory retrieval.
  Rationale: it reuses one embedding within each text or Realtime tool query and hides ranking, tier quotas, deduplication, provenance quality, token limits, and degraded fallback from callers.
  Date/Author: 2026-07-14, Codex using the codebase-design lens.
- Decision: preserve production durable-memory data and the deployed memory extraction tables through append-only migration; do not maintain a dual retrieval or prompt path.
  Rationale: production data is a real compatibility constraint, while legacy interfaces are not.
  Date/Author: 2026-07-14, Codex.
- Decision: synchronize canonical text changes with their private memory-extraction snapshots, and purge source-derived memory on authoritative Discord deletion.
  Rationale: otherwise edited or deleted chat could survive as an accepted fact even after historical indexes were rebuilt.
  Date/Author: 2026-07-14, Codex from adjacent memory-store evidence.
- Decision: backfill from a content-free reverse page manifest and bound staged raw content.
  Rationale: Discord pagination is naturally newest-first, but retaining the entire old channel merely to process it oldest-first would violate the approved raw-retention intent.
  Date/Author: 2026-07-14, Codex.
- Decision: the owner CLI creates, activates, resumes, and inspects backfill runs, but the running Chief process performs every paid backfill step.
  Rationale: a second process would have a stale in-memory view of usage reservations and could overspend or compete with interactive work; the runtime already owns the authoritative queue and budget.
  Date/Author: 2026-07-14, Codex from `UsageBudget` and runtime composition evidence.
- Decision: reserve paid work only after its queue slot is selected, and refuse all background admission that would consume one maximum conservative interactive reservation of overall-budget headroom.
  Rationale: scheduling priority does not protect an interaction if lower-priority work has already reserved the remaining budget.
  Date/Author: 2026-07-14, Codex from adversarial review.
- Decision: use immediate Discord lifecycle events plus a resumable full-channel reconciliation scan, including bulk-delete handling and message partials.
  Rationale: gateway events can be missed while Chief is offline, and Discord exposes no standalone historical delete feed.
  Date/Author: 2026-07-14, Codex from adversarial review.
- Decision: keep Realtime recall model-driven through one unified historical-and-durable context tool.
  Rationale: the voice query does not exist when the session opens, so a session snapshot cannot satisfy substantive turn-level retrieval.
  Date/Author: 2026-07-14, Codex from adversarial review.
- Decision: treat active local forgetting and recovery-artifact byte erasure as separate guarantees. Active state is suppressed and scrubbed before acknowledgement; local and bucket recovery bytes are retained no longer than 30 days, content-free forget journals remain for at least 60 days, and every start replays all retained verified journals first.
  Rationale: this preserves the narrow production storage role and prevents any supported recovery path from resurrecting forgotten data without granting runtime object-admin access.
  Date/Author: 2026-07-14, Codex from adversarial review and infrastructure evidence.
- Decision: make forget-journal reconciliation an unconditional, fail-closed host startup preflight, not an optional restore step. Replay every retained verified journal idempotently, and use a separately recorded recovery image when the target runtime image predates migration 0003.
  Rationale: selection by an unavailable snapshot timestamp and reliance on operator procedure both leave logical-resurrection paths. The privacy gate is critical readiness even though ordinary context lag remains diagnostic-only.
  Date/Author: 2026-07-14, Codex from adversarial resolution review.
- Decision: retain local pre-deploy and failed database artifacts for at most 30 days with owner-only permissions, and subject them to the same mandatory replay preflight before use.
  Rationale: these recovery files have the same forgotten-byte risk as bucket backups and must not persist indefinitely or become a bypass path.
  Date/Author: 2026-07-14, Codex from adversarial resolution review.
- Decision: emit content-free external journal entries for authoritative Discord source deletions as well as explicit local forget operations.
  Rationale: both operations must remain suppressed when Chief starts from an older recovery artifact; reconciliation after startup is too late.
  Date/Author: 2026-07-14, Codex during implementation preflight.
- Decision: reconstruct dry-run duplicate identity by refetching recorded page boundaries rather than persisting message IDs.
  Rationale: page boundaries and aggregate checksums are sufficient durable progress; retaining the full historical source inventory would expand privacy-sensitive state merely to optimize resume.
  Date/Author: 2026-07-14, Codex during Task 6 implementation.
- Decision: represent expired raw sources as scrubbed retention-expired conversation identities only inside the atomic derived-document commit.
  Rationale: existing lineage, tombstone, correction, and rebuild policy requires stable source identity, while the approved retention boundary prohibits durable historical text.
  Date/Author: 2026-07-14, Codex during Task 6 implementation.
- Decision: attach backfill as a separate source on the existing background scheduler and reuse the runtime's single `UsageBudget`.
  Rationale: this preserves live-work priority and one authoritative view of overall, indexing, interactive-headroom, and per-run reservations across restart.
  Date/Author: 2026-07-14, Codex during Task 6 implementation.
- Decision: make the backfill run own its complete induced hierarchy rather than only direct page work.
  Rationale: daily, weekly, and topic rollups are costs caused by the backfill and must remain under its lifetime maximum; page exhaustion can finalize only after every attributed job completes.
  Date/Author: 2026-07-14, Codex from Task 6 implementation review.
- Decision: treat the reservation as a hard provider-cost contract and pause without persistence when reported usage exceeds it.
  Rationale: post-call reconciliation cannot safely expand a reservation past the overall, indexing, or run ceiling. A conservative full-reservation charge bounds accounting while making the provider mismatch operationally explicit.
  Date/Author: 2026-07-14, Codex from Task 6 implementation review.
- Decision: identify backfill segments by their source content and fold same-hour segments through one active aggregate plus one new leaf.
  Rationale: refetched page membership may shift, so ordinal idempotence can skip work; a rolling two-source hierarchy preserves bounded provider input without rereading every prior segment.
  Date/Author: 2026-07-14, Codex from Task 6 implementation review.
- Decision: live work may retain an active backfill owner, but it takes live ownership when the existing owner is no longer active.
  Rationale: charging shared active work to the run is conservative, while preserving ownership by a paused, failed, or replaced run makes newer live work permanently ineligible. Any outstanding old reservation remains attached to its ledger row and is conservatively recovered before a new live reservation.
  Date/Author: 2026-07-14, Codex from Task 6 implementation re-review.
- Decision: preserve migration 0007 and use append-only migration 0008 to guard ambiguous legacy accounting.
  Rationale: old job rows do not prove which pending work was induced by which run. Pausing and conservatively attributing unfinished work prevents false completion or unbounded spend, while the existing resume path provides an explicit operator boundary.
  Date/Author: 2026-07-14, Codex from Task 6 implementation re-review.
- Decision: make reservation origin immutable and fail closed when historical origin cannot be reconstructed.
  Rationale: later job ownership and the ledger's current run foreign key are both mutable, so neither can distinguish an originally live reservation from an originally backfill reservation after migration repair. New reservations record independent provenance; legacy ambiguity becomes a durable accounting hold that the scheduler cannot lease and the ledger cannot reconcile until rebuilt.
  Date/Author: 2026-07-14, Codex from Task 6 final re-review.
- Decision: require confirmation for every broad scope, store only a nonce checksum and stable candidate IDs, and reevaluate authorization when the confirmation is presented.
  Rationale: candidate counts and target text do not belong in an authorization response, a leaked database must not reveal a usable nonce, and administrator authority may change during the confirmation window.
  Date/Author: 2026-07-14, Codex during Task 5 implementation.
- Decision: make replay tombstone-first and artifact-independent.
  Rationale: a supported older backup may lack a referenced row, but the verified journal's stable IDs must still prevent that scope from being reintroduced by ingestion, rebuild, or later restore.
  Date/Author: 2026-07-14, Codex during Task 5 implementation.
- Decision: record runtime and recovery image digests independently and never start an older runtime against a newly migrated database.
  Rationale: rollback must restore the pre-migration database before selecting the old image, while startup replay may still require the newer schema-capable recovery image. Keeping both digests in mode-0600 state makes that pairing explicit and testable.
  Date/Author: 2026-07-14, Codex during Task 7 implementation.
- Decision: label every runtime image with its maximum database capability and compare that label to the verified database before service stop, secret access, or runtime launch. Treat an unlabeled image as the legacy migration-0002 capability.
  Rationale: the recovery image can inspect or replay a newer schema without proving that the selected target runtime can safely open it; explicit capability binding preserves old-image plus pre-migration-database rollback while refusing an unsafe mixed pair.
  Date/Author: 2026-07-14, Codex during Task 7 independent review correction.
- Decision: enumerate and download every retained journal generation by its immutable generation-qualified GCS URL, and bind each generation plus content checksum into the replay receipt.
  Rationale: bucket versioning retains deletions in noncurrent objects, while a current-only listing or name-only local copy can omit or overwrite a suppression record and resurrect forgotten data.
  Date/Author: 2026-07-14, Codex during Task 7 independent review correction.
- Decision: treat a legacy text `platform_source_id` as a recoverable source identity only when it is a 17-20 digit Discord snowflake, and preserve migrations 0004 through 0012 unchanged while appending migration 0013 for the backfill.
  Rationale: the real pre-context text path stored Discord message IDs, while voice and synthetic sources use prefixed identities that are not channel source scopes. The journal can carry the snowflake directly, and recovery already matches migration-0002 `platform_source_id` without inventing unavailable guild/channel data.
  Date/Author: 2026-07-14, Codex during Task 7 re-review correction.
- Decision: verify restore invariants against the schema prefix actually recorded in the artifact.
  Rationale: context documents, FTS, vectors, tombstones, and all four tiers exist at migration 0003, but internal-document policy begins at 0004 and retained page/segment progress begins at 0006. Requiring later tables rejects an otherwise supported exact-0003 rollback artifact.
  Date/Author: 2026-07-14, Codex during Task 7 re-review correction.
- Decision: treat a valid legacy bare Discord snowflake as an alias only for an exact source scope whose terminal component is the same snowflake.
  Rationale: Discord snowflakes are the stable pre-context identity, but substring or positional matching would suppress unrelated guilds, channels, voice sources, or synthetic IDs. The bounded exact rule closes recovery resurrection without widening deletion scope.
  Date/Author: 2026-07-14, Codex during Task 7 final review correction.
- Decision: use one real deterministic corpus replay for CI and paid quality evaluation, while grading through a separate structured-output agent rather than Chief's answer agent.
  Rationale: sharing `ContextAssembler` output prevents evaluator-only retrieval behavior, and a dedicated grader instruction keeps candidate/context data untrusted while making the four quality scores machine-validated. CI inspects the complete returned safety surface without making paid calls.
  Date/Author: 2026-07-14, Codex during Task 8 review correction.

## Outcomes & Retrospective

Milestones 1 through 8 are implemented for repository acceptance. Task 6 can inventory accessible channel history without persisting message content, obtain explicit owner activation and a per-run ceiling, then use the running process's existing protected queue and budget to process oldest-first history. Recent sources follow normal ingestion; expired sources become only scrubbed identities plus derived, provenance-backed documents. The complete induced rollup hierarchy remains run-attributed and ceiling-bound; immutable reservation origin returns stolen live work to live accounting while retaining detached backfill charges on their original run and preventing completion before those charges reconcile. Pre-provenance ambiguity fails closed on a durable rebuild-required hold enforced by both scheduler admission and atomic ledger reconciliation. Tombstones, live revisions, exact manifest ranges, restart reservations, rate limits, shifting segments, duplicates, and page/segment replay remain safe.

Task 7 exposes context lag, counts, reconciliation age, backfill state, and bounded reason codes without making ordinary indexing degradation a readiness failure. Recovery verification validates migration/checksum integrity, SQLite/foreign-key consistency, exact FTS token positions and vector document identities, a joined four-tier query, tombstones, and schema-prefix-available backfill progress. Every supported startup replays every retained current and noncurrent content-free journal generation through an independently recorded recovery image before Discord secrets or the target runtime are available; download, shape, checksum, migration, capability, or replay failure stops startup. Append-only migration 0013 preserves valid legacy Discord text identity, and exact bare/composite source aliases prevent the same forgotten message from returning through live ingestion or backfill after a migration-0002 restore. Deploy and restore preserve image/database compatibility through an immutable image capability label, mode-0600 artifacts, and at-most-30-day local recovery retention, while bucket policy retains database artifacts for 30 days and journals for 60 days without widening runtime permissions. Container smoke, exact-0003/current capability checks, explicit backup verification, restore drill, shell syntax, and Terraform initialization/validation passed.

Task 8 exercises real source FTS, context vectors, durable-memory vectors, tier/lineage deduplication, temporal correction ordering, summary-only provenance, suppression, and production payload serialization across 44 pinned cases. CI requires zero forbidden claims, zero complete-surface leakage, exact returned provenance allowlists, complete requested-link recall, and correct target history-versus-memory classification. The optional owner-run evaluator uses the same assembled payload, a dedicated structured grader, per-class and macro classification thresholds, and numeric-only logs with model/timestamp evidence. The final repository gate passes 451 deterministic tests with 91.48% statement, 84.02% branch, 94.39% function, and 92.90% line coverage. Repository implementation is complete; production acceptance remains pending explicit authorization for deployment, paid grading/backfill, and live Discord verification. No live Discord, provider, deployment, backfill, or production-data call is claimed.

## Context and Orientation

Chief is a single Node.js/TypeScript process using `discord.js`, the OpenAI Agents SDK, and SQLite with FTS5 plus sqlite-vec. `src/runtime.ts` wires the process. `src/discord/gateway.ts` owns Discord transport, and `src/discord/text-controller.ts` applies the configured guild/channel/mention policy. `src/app/conversation-orchestrator.ts` records normalized text and voice events, serializes interactive provider work, and calls `src/agent/openai-chief-agent.ts`. `src/conversation/conversation-store.ts` owns the recent cross-text/voice timeline. `src/memory/memory-service.ts`, `src/memory/memory-store.ts`, and `src/memory/openai-memory.ts` own durable-memory extraction, mutation, hybrid retrieval, and jobs. `src/memory/database.ts` owns append-only migrations. `src/usage/usage-budget.ts` and `src/usage/sqlite-usage-ledger.ts` enforce the monthly ceiling. `src/health/health-server.ts` exposes loopback health used by deployment.

The domain glossary is `CONTEXT.md`. A source event is an eligible human or Chief message. Recent conversation is the short chronological timeline. Historical context is a time-bounded report of discussion and is not truth. A rollup is a derived report with source lineage. A context tier is hourly, daily, weekly, or long-term. A durable memory is an accepted fact or preference. A suppression tombstone is a content-free record that prevents deleted material from returning.

The existing `conversation_events.retention_deadline` performs two jobs: it decides both whether an event may appear in recent conversation and when raw content is deleted. Split those concerns. New text events need `recent_until` seven days after occurrence and `retention_deadline` 30 days after occurrence. Voice remains seven days unless a later decision explicitly brings it into channel indexing. The existing `source_events` table remains the memory extractor's private snapshot because active production memory jobs and memories reference it; context indexing does not search that table.

Long-term topics are historical documents keyed by a stable opaque topic identifier, with a human-readable label and aliases inside document metadata. They are not entities or facts. Daily rollups may propose new topics or updates to existing topics; the store resolves exact aliases and high-confidence semantic matches, leaving ambiguous proposals separate rather than merging them destructively.

## Interfaces and Dependencies

Add exact dependency `@js-temporal/polyfill@0.5.1` to `package.json` and `pnpm-lock.yaml`. Use it only in `src/context/context-period.ts` to convert instants to `America/New_York` hourly, daily, and Monday-start weekly half-open periods. A half-open period includes its start instant and excludes its end instant, which removes ambiguity at adjacent buckets and repeated DST clock hours.

Create `src/context/context-types.ts` with the shared discriminated types. The provider-facing historical evidence must have this shape or an equally narrow equivalent:

    export type ContextTier = 'hourly' | 'daily' | 'weekly' | 'long-term';

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
      | HistoricalSourceContext
      | HistoricalRollupContext;

    export interface PreparedContext {
      readonly approximateTokens: number;
      readonly historicalContext: readonly HistoricalContext[];
      readonly memories: readonly string[];
      readonly recentConversation: readonly ChiefConversationMessage[];
      readonly usageUsd: number;
    }

Create `src/context/context-assembler.ts` as the deep retrieval module. Its public interface is one method:

    export interface ContextAssembler {
      assemble(input: {
        readonly beforeEventId?: number;
        readonly now: number;
        readonly prompt: string;
      }): Promise<PreparedContext>;
    }

The implementation owns one embedding per retrieval query, recent-timeline selection, source-event lexical retrieval, durable-memory retrieval, per-tier hybrid retrieval, score normalization, recency adjustment, tier quotas, lineage/semantic deduplication, source-link construction, total token enforcement, usage reporting, and degraded fallback. A text request is one retrieval query. Each model-invoked Realtime recall is a new retrieval query because that is when the spoken query becomes known. Callers must not know table names, ranking formulas, or per-tier limits. Keep durable-memory retrieval behind `MemoryService`: add an internal prepared-query method that accepts query text and the assembler's embedding. This preserves `MemoryService` as the durable-memory authority without paying for a second embedding inside one query. Remove the old durable-memory-only string recall path after text and voice use the assembler.

Create `src/context/channel-context-service.ts` as the deep historical lifecycle module. Its interface accepts normalized source changes, runs one bounded background job, applies authorized deletion, performs retention, and reports freshness. Do not expose separate public methods for each tier. A suitable interface is:

    export interface ChannelContextService {
      apply(change: ChannelSourceChange): ContextApplyResult;
      forget(request: ContextForgetRequest): Promise<ContextForgetReceipt>;
      maintain(now: number): ContextMaintenanceResult;
      runNext(now: number): Promise<ContextJobResult>;
      status(now: number): ContextStatus;
    }

`apply` owns the synchronous text source transaction and hides `ConversationStore.record`, create/update/delete idempotence, memory-source synchronization, provisional/final job scheduling, lexical indexing, and tombstone checks. `ConversationOrchestrator` calls it once for eligible text instead of sequencing a conversation write, memory observation, and context write itself. Voice events remain direct recent-conversation writes because ambient voice indexing is out of scope. `runNext` hides leases, tier ordering, summarizer calls, embeddings, document revisions, lineage, retries, and budget deferral. `forget` is an asynchronous policy wrapper for candidate discovery, live authorization, confirmation, and acknowledgement, but it delegates the actual cross-store mutation to a synchronous `ContextDeletionStore` primitive on the shared connection. Provider calls and budget mutations happen only after that transaction commits. Tests cross these interfaces rather than calling tier-specific SQL helpers.

Create `src/context/context-store.ts` as package-internal SQLite implementation used by the two deep modules. Do not add a public repository interface merely to mock it; integration tests should use an in-memory SQLite database, matching the existing memory tests. Create `src/context/openai-context.ts` with the one real provider adapter and a small `ContextSummarizer` interface because tests need a fake adapter. Structured output must distinguish topics, decisions under discussion, disagreement, correction, unresolved uncertainty, and source references without promoting them to facts. Treat all message and rollup content as untrusted data, never instructions.

Create `src/usage/paid-work-queue.ts` with `interactive` and `background` scheduling. Replace `ConversationOrchestrator.#queueTail` with the shared queue from `src/runtime.ts`. A job obtains its queue slot before making a budget reservation. Pending interactive jobs run before pending background jobs; a running job completes normally. The runtime's memory and context workers submit one bounded job at a time through the background path. The background coordinator orders live work by its freshness deadline and uses fair rotation for equal deadlines; full-history backfill is always last. This is a real seam because the production queue and deterministic fake-clock tests exercise different scheduling adapters.

Extend `UsageBudget` with work category and priority on every reservation. `reserve` must enforce the total ceiling, the indexing category ceiling, actual persisted usage, and all outstanding reservations inside the same budget instance. A background reservation is additionally rejected when it would leave less than `max(textUsd, transcriptionUsd, voiceUsd)` from `calculateConservativeReservations` under the overall ceiling; interactive admission may consume that protected headroom. Do not create a second `UsageBudget` against the same ledger. Add `CHIEF_USAGE_INDEXING_CEILING_USD`, default `3`, and reject values greater than the overall ceiling. Backfill admission uses the minimum of remaining lifetime run spend, current UTC-month indexing capacity, current UTC-month overall capacity, and protected background capacity. Its actual spend and outstanding reservations count against the per-run ceiling across month resets.

Extend `ChiefTextRequest` with the typed prepared context. Update `formatTextInput` to label `historicalContext` separately from `communalMemory`. Replace the Realtime `recall_communal_memory` tool with `recall_context(query)`, which calls `ContextAssembler` for the spoken query and returns historical context and communal memory as separate structured fields. Tell both models that history is not authority, preserve timestamps, tier, confidence, and source links, and treat every returned summary, label, and source field as untrusted data. Do not concatenate historical summaries into memory strings.

## Plan of Work

### Task 1: establish canonical source, context schema, and calendar behavior

Add migration `0003_channel_context` in `src/memory/database.ts`. Never edit the two deployed migrations. Extend `conversation_events` with `recent_until`, configured guild/channel identity, reply-to message identity, edit and deletion timestamps, attachment metadata JSON, a nullable logical response ID, and the stable Discord message identity needed to build jump links. Each delivered Discord chunk is one source row keyed by its own unique snowflake; chunks share the logical response ID and are grouped back into one Chief response only when assembling recent or historical evidence. This preserves the existing single-key uniqueness rule while making every chunk independently idempotent during live ingest, reconciliation, and backfill. SQLite cannot safely add all desired non-null columns to populated rows in one step: add nullable staging columns, backfill every existing row, validate the backfill, then rebuild and rename the table with final constraints and recreated indexes inside the migration transaction. Populate `recent_until` from the existing retention deadline for migrated rows. New eligible text and Chief events use a seven-day `recent_until` and 30-day raw `retention_deadline`; voice continues using seven days for both. Deleted rows keep non-content identity and lineage fields but replace raw content and attachment metadata with empty values immediately. Store a content-state reason that distinguishes retained, retention-expired, Discord-deleted, and locally-forgotten sources.

Add `context_documents`, `context_document_events`, `context_document_parents`, `context_jobs`, `context_tombstones`, `context_deletion_requests`, `context_forget_journal`, and `context_backfills`. A context document has a stable key, tier, half-open period, timezone, optional topic key, monotonic revision, provisional/final completeness, active/superseded/suppressed state, content state and reason, summary, confidence, retention deadline or null, creation/update time, and generation-cost metadata. Separate event and parent lineage tables avoid a polymorphic foreign key. Jobs have a deterministic key, target tier/period/topic, source-revision checksum, not-before time, attempts, lease expiry, status, and last redacted error category. The forget-journal outbox stores only stable scope/tombstone IDs, occurrence time, checksum, upload status, and retry metadata; it contains no deleted content. Extend `usage_ledger` through the same safe nullable-backfill-rebuild sequence with persisted work category and priority so outstanding indexing/background reservations reconstruct correctly after restart. Add 1,536-dimension sqlite-vec tables and contentless FTS5 tables with `contentless_delete=1`, keyed to document ID and updated transactionally with the active revision. Add a startup/migration feature test that proves the bundled SQLite supports those delete semantics before accepting the schema.

Use source-event FTS5 with `contentless_delete=1` for immediate lexical visibility. `ChannelContextService.apply` updates it synchronously in the same hot-path transaction as the source row, so queue or provider backlog cannot violate the one-second lexical target. It indexes only nondeleted eligible text in `conversation_events` and is removed during source deletion or retention. Do not create source embeddings for every message. Instead, the first eligible message after the latest hourly revision schedules one activity-triggered provisional hourly job no later than five minutes later. That job creates a searchable provisional revision from the open hour; further activity may replace it with another bounded revision, and the period-close job creates the final revision. Daily and higher tiers consume only final children. This satisfies semantic visibility without one embedding charge per casual message.

Implement `src/context/context-period.ts` with `@js-temporal/polyfill`. Unit tests must cover ordinary hours, midnight, Monday boundaries, the missing 02:00 hour on 2026-03-08, and both distinct 01:00 hours on 2026-11-01 in `America/New_York`. A deterministic period key includes tier, timezone, start instant, and end instant, so repeated local labels cannot collide.

Update `ConversationStore.recent` to filter each row by `recent_until` while maintenance acts only at `retention_deadline`; a Chief/human response pair does not extend either row past its own boundary. Replace the existing shared-deadline deletion assertions in `test/integration/conversation-store.test.ts` with explicit recent-expiry versus content-scrub cases, including a reply pair straddling the seven-day edge, and update affected database/memory maintenance fixtures. Update the bounded, read-only context portion of database health and restore verification to require migration 0003 and query every new FTS/vector table without adding periodic writes; update the hard-coded `0002` runtime checksum assertion. Add a production-shaped migration fixture containing active memories, source jobs, outstanding categorized usage reservations, human/Chief conversation pairs, and vector rows; migration must preserve exact counts and known hybrid memory retrieval.

At milestone end, targeted migration/calendar tests pass and a migrated fixture reports the same durable memory plus the new empty context indexes.

### Task 2: normalize live Discord source lifecycle

Extend the Discord normalized message type to carry occurred/edited time, reply target, attachment name/description metadata, bot identity classification, requester identity, and a `canModerateContext` permission snapshot. Accept humans and this application's own Chief messages; continue rejecting other bots, webhooks, threads, other channels, and other guilds. Derive moderator authority only when destructive intent is submitted, using `message.guild.ownerId` or the request author's current `message.member.permissions` `Administrator` flag. If current member permissions are unavailable, fail closed for cross-member/topic deletion; do not add the privileged `GuildMembers` intent merely for this feature. Self-deletion compares the authenticated Discord author ID with stored source authorship.

Configure `Partials.Message` and `Partials.Channel`, keep the configured main guild channel cached, and subscribe `DiscordGateway` to `MessageUpdate`, `MessageDelete`, and `MessageBulkDelete`. Handle partial create/update payloads by fetching the message when permitted; if updated content cannot be fetched, retain the last revision and emit a redacted retryable event rather than blanking content. Single and bulk delete events need only stable guild/channel/message identity and must suppress local sources immediately. Duplicate and out-of-order creates/updates compare Discord edit timestamps and a normalized revision checksum and do not overwrite a newer revision. Memory-extraction and context jobs record that checksum and recheck it with tombstones inside their commit transaction, so an edit cannot be undone by stale provider work.

Gateway events alone cannot cover downtime. Add redacted shard error/reconnect/resume health signals plus a content-free, rate-limited reconciliation cursor. Put pagination coverage, complete-pass proof, and deletion inference in a new covered `DiscordReconciliationService` that consumes the `DiscordHistorySource` seam; keep excluded `src/discord/gateway.ts` as a thin event/fetch adapter. After startup or reconnect the service first fetches every eligible create/edit since the persisted high-water snowflake and scans the retained 30-day raw window, then continues a low-priority full-channel identity scan at least weekly. A successfully completed paginated pass applies newer edits and treats a previously indexed message missing from the explicitly covered range as deleted; an interrupted, failed, or rate-limited pass never emits deletion changes. The scan stores only cursors, seen stable IDs, timestamps, and checksums outside the approved retention window, uses the same normalized lifecycle path, and never invokes a provider merely to compare identity. Reconciliation lag is diagnostic and direct tests of the covered service prove complete/incomplete range behavior plus a create, delete, and edit that happened while Chief was offline.

Refactor source recording so `ConversationOrchestrator` passes every eligible text create through `ChannelContextService.apply`, which owns the synchronous database transaction that records recent conversation, synchronizes the memory extraction source for human messages, updates lexical search, and schedules context jobs. Do not enqueue automatic memory extraction for Chief's own replies; otherwise Chief's generated text could reinforce itself as communal fact. The gateway's chunked reply delivery returns the actual Discord message snowflakes, then calls a covered `recordDeliveredReply` application seam with the logical response ID and ordered delivered chunks. Only that callback records Chief source rows and reply lineage; failure before Discord delivery records no phantom reply. Insert one row per chunk under its own snowflake and the shared logical response ID, so retry and later reconciliation/backfill deduplicate every chunk independently while prompt assembly groups the ordered rows into one response. Ignore the gateway's later self-authored `MessageCreate` by the already-recorded snowflake, not by dropping all Chief-authored history. Historical and reconciliation eligibility receives the configured `botUserId`: it accepts bot-authored messages only when the author equals Chief and rejects every other bot/webhook. Actual snowflakes are the sole platform source keys, so no synthetic-key twins exist.

An eligible human edit updates both the canonical conversation source and the private memory-extraction snapshot. Invalidate durable memories whose sole provenance is the old source revision and enqueue fresh extraction; do not leave a fact active after its supporting message changed. A Discord delete is authoritative regardless of the deleted author's current permissions: scrub the canonical event, its memory-extraction snapshot, durable memories sourced only from it, and all active context descendants immediately. Natural-language deletion retains the separate self/admin authorization rules.

An unmentioned create still returns `null` and never types or replies. Edits and deletes never trigger generation. Unit and integration tests prove source availability within one second using a fake clock, exact allowlist behavior, reply lineage, safe attachment metadata, and immediate deletion.

### Task 3: generate rollups under one protected background scheduler

Create the shared paid-work queue and pass it from `src/runtime.ts` to `ConversationOrchestrator` and the background worker. Consolidate the memory timer and context timer behind one `runBackgroundOne` loop that chooses due live work by freshness deadline, fairly rotates equal-deadline memory/context work, and selects historical backfill only when no due live job exists. Submit one bounded provider job at a time. Pending interaction always wins the next slot. The selected job then attempts its reservation; rejected background admission defers without consuming attempts. Preserve the current provider timeouts and ensure shutdown stops accepting jobs, waits for or safely abandons the active lease, and then closes SQLite.

When source changes arrive, ensure both a provisional hourly job due within five minutes and a deterministic final hourly job exist. Provisional jobs run only after new activity and replace the active provisional revision for the open hour. A final period job becomes eligible after its calendar end and must finish within the agreed ten-minute bound. Hourly jobs summarize active raw events; daily jobs summarize final hourly documents; weekly jobs summarize final daily documents. Daily completion proposes changes to long-term topics using recent daily evidence and relevant active topic documents; weekly completion also schedules topic consolidation so week-scale changes are not omitted. Each successful transaction writes the new document revision, lineage, FTS row, vector row, usage metadata, parent invalidations, and downstream jobs atomically.

Use the configured memory model and existing memory input/output prices through `ContextSummarizer`; add no second model knob initially. Bound source tokens per job and split oversized busy periods into deterministic segments before producing the tier rollup. Segments are internal documents with the same retention as their tier and are never separately exposed to the prompt. A model response must pass a strict Zod schema and reference only supplied source IDs. Invalid output is retryable; after the existing five-attempt pattern it becomes failed and health exposes lag without content.

Implement category and priority accounting in `UsageBudget` and `SqliteUsageLedger`. Context summary and embedding operations reserve category `indexing`; memory extraction stays in the overall budget but outside the indexing sub-ceiling, while both are background work subject to interactive headroom. Persist operation, category, priority, reserved amount, occurrence month, actual amount, and reconciliation time so startup reconstructs both total and category reservations conservatively. Reconciliation attributes actual usage to the reservation's occurrence month even when the provider call crosses a UTC-month boundary, while the separate backfill-run ledger updates lifetime spend. When indexing is paused, defer the job until all applicable capacity is available without incrementing attempts; a UTC-month reset does not reset a backfill run's lifetime ceiling. Update long-term topics after each completed daily period and consolidate them after each completed week. At normal retention, scrub text and attachment content from eligible source rows and scrub expired hourly/daily summary content and search rows, but keep content-free identities, period metadata, reason, and lineage edges required for provenance quality and later deletion. Voice rows that never participate in context lineage may still be deleted. Weekly and long-term content remains until explicit purge.

At milestone end, fake-clock tests prove all freshness deadlines, retry/lease recovery, background admission headroom, month rollover versus monotonic per-run spend, interactive priority, oversized bucket segmentation, and restart catch-up. No test makes a paid call. Provider-dependent freshness deadlines apply while Chief is running, the provider is available, and the applicable overall/category/run capacity exists; when any condition is absent, health must report the exact redacted lag reason and catch-up resumes in deadline order.

### Task 4: assemble one bounded context per retrieval query

Implement `ContextAssembler.assemble`. Embed each retrieval query once, then use that vector and lexical query against active durable memories and every active rollup tier; also query the paid-call-free source-event FTS for retained messages outside or inside the recent window. Query recent conversation chronologically before the current event. Return source matches as `evidenceForm: 'source'` with their actual occurrence instant and rollup matches as `evidenceForm: 'rollup'` with tier/period metadata. Normalize lexical/vector scores within each evidence class and tier so raw score scales do not compete directly. Apply a recency adjustment within tiers, not across them. Reserve tier budgets inside one historical-context allowance, deduplicate source matches already present in recent chronology, group Chief reply chunks by logical response ID, and suppress source/rollup duplicates that share lineage or convey the same normalized statement. Include only relevant results. Querying every tier and the source index does not mean forcing an irrelevant result from each.

Start with an 8,000 approximate-token total for recent plus historical context, preserving the existing maximum 30 recent events and giving recent conversation at least half of the allowance when available. Treat these as implementation defaults owned by the assembler, not environment knobs. Durable memory remains separately limited to six accepted items. Record measured quality and prompt size in `Surprises & Discoveries`; revise the constants in this plan if replay evidence supports a better fixed allocation.

Build Discord jump links from configured guild/channel and source message IDs. A rollup may expose at most three representative links selected from its lineage. Content-free source metadata may retain a message ID after normal local retention expiry, so a real Discord link can remain available while provenance is marked summary-only. Never expose a link when the content-state reason is Discord-deleted or locally-forgotten. Natural temporal labels use the configured timezone.

Update text input JSON and the Realtime `recall_context` tool result so `recentConversation`, `historicalContext`, `communalMemory`, and `userRequest` remain structurally separate and untrusted. Text invokes the assembler before generation. Realtime invokes it from the tool only after the model has a substantive spoken query; permit at most one successful context-recall call per committed user utterance, reset that allowance on the next committed utterance, and embed the tool query once. Instructions say historical context reports discussion, newer corrections win, disagreements remain unresolved, and summary-only evidence cannot support verbatim claims. Validate every provider-returned source ID against the exact supplied source set before storage or prompt inclusion. If historical retrieval fails, return recent conversation and durable memory; if durable-memory persistence fails, preserve the current lost-thread behavior rather than pretending memory is available.

Extend `context-prepared` telemetry with per-tier counts, total approximate tokens, and a degraded flag only. Never log prompts, summaries, speaker IDs, message IDs, topic labels, source links, or model payloads.

At milestone end, conversation replay proves questions spanning each horizon, mixed-tier deduplication, temporal attribution, conflicts, source requests, summary-only uncertainty, text/voice parity, and unchanged current answer behavior when no indexed context exists.

### Task 5: coordinate correction, authorization, forgetting, and rebuild

Extend explicit intent handling so a forget request searches both durable memory and historical context. Candidate discovery returns only redacted counts and stable IDs to the authorization layer. A member may select sources they authored. Guild owner/admin requests may select other authors or whole topics. An unauthorized broad request returns an honest refusal without revealing whether hidden candidates exist.

For ambiguous matches, return clarification and take no action. For broad authorized matches, create a short-lived `context_deletion_requests` row containing requester ID, matched source/document IDs, scope, expiry, and a random confirmation nonce, but not the target text. The next matching confirmation by that requester consumes the row once. Expired confirmations are deleted. Self-deletion of a narrow unambiguous source may execute without the administrative confirmation step.

The deletion planner performs candidate search and any model-assisted interpretation before mutation. Its synchronous `ContextDeletionStore` transaction then marks selected source events locally forgotten, scrubs raw content/attachments, removes source FTS rows, suppresses active descendant context documents, removes their FTS/vector rows, creates source/document tombstones, supersedes every selected or source-derived durable memory through synchronous `SqliteMemoryStore` primitives, scrubs matching private memory-source snapshots, consumes confirmation, enqueues rebuilds from remaining active lineage, and inserts a content-free forget-journal outbox row. The stores share the same better-sqlite3 connection and one outer transaction; no Promise, provider call, budget reservation, or nested independent commit may occur inside it. After commit, the async service uploads the outbox entry, marks it delivered, schedules optional re-extraction, and only then acknowledges the completed local deletion and backup-retention caveat. A failed upload leaves active state suppressed, keeps a retryable outbox row, degrades diagnostics, and withholds a success acknowledgement. Rebuild uses no suppressed input. A stale leased job checks source revision and tombstones again inside its commit transaction and cannot resurrect deleted content.

Corrections remain historical events rather than rewriting the past. Context ranking prefers later correction evidence, and durable-memory extraction may supersede an accepted memory under current confidence/sensitivity rules. Tests cover self purge, administrator purge, missing-permission fail-closed behavior, unauthorized purge, confirmation expiry/replay, partial-topic rebuild, expired raw evidence, concurrent job completion, restart, and verified absence from active raw SQL, FTS, vectors, prompts, backups created after purge, and any restored database after journal replay.

### Task 6: backfill the full accessible channel history

Add CLI command `context-backfill` in `src/cli.ts`. It loads the normal configuration and production database. `--dry-run` uses Discord REST to paginate the configured channel newest-to-oldest, filters the approved source surface, persists only a content-free manifest of page-boundary message IDs plus aggregate byte/token counts, and prints eligible message count, oldest/newest timestamps, already-ingested count, estimated summary/embedding spend, and no secrets. `--activate --max-usd <positive amount> --confirm-guild <id>` records the owner-approved ceiling and makes the manifest eligible for the running background worker; it performs no paid model call itself. `--status` and `--resume <run-id>` inspect or reactivate the durable run. Refuse activation when no completed dry-run manifest exists.

Create a `DiscordHistorySource` seam with a discord.js REST adapter and deterministic fake. Respect Discord pagination and rate-limit responses through discord.js rather than implementing sleeps. `ChannelContextService.runNext` selects activated backfill work through the same `background` queue and `UsageBudget` instance as live rollups. It re-fetches the dry-run manifest from its oldest page toward the newest and reverses messages within each page.

For sources newer than the 30-day raw-retention boundary, use normal idempotent ingestion. For older sources, keep message content only in the worker's bounded in-memory segment, summarize it, then atomically store the derived document plus content-free source identities and lineage; never persist expired raw text to SQLite, temporary files, logs, or backups. A crash before commit simply refetches that page/segment. Persist manifest cursors, committed segment checksums, actual lifetime per-run spend, and outstanding run reservations. Process oldest periods first so daily and weekly parents become available in order. Existing tombstones and externally replayed forget-journal entries win over backfill content. Concurrent live create/edit/delete events use revision time and cannot be replaced by an older fetched revision.

The runtime may stop at any point. Its durable run and segment checksums resume safely at startup. Starting another dry run reports the incomplete run and requires an explicit replacement choice. Reaching the per-run, indexing-category, or overall ceiling pauses without failure; `--status` prints the exact safe resume command. Backfill never posts, reacts, edits, or deletes Discord content.

Tests use fake pages containing humans, Chief, other bots, webhooks, threads, edits, deletes, replies, attachments, duplicates, out-of-order pages, rate limits, restart, budget pause, and concurrent live events. Assert that dry-run persists no message text, CLI activation performs no paid call, old raw text never reaches SQLite or a backup, in-memory segments remain bounded, and Chief replies never enter durable-memory extraction. A local fixture backfill must produce the same active documents and retrieval results as feeding the same normalized events live.

### Task 7: expose operations, package configuration, and preserve rollback

Add `CHIEF_CONTEXT_TIME_ZONE=America/New_York` and `CHIEF_USAGE_INDEXING_CEILING_USD=3` to config parsing, `.env.example`, Terraform variables, the VM startup environment template, and documentation. Validate the IANA timezone through Temporal and require `0 < indexing ceiling <= overall ceiling`. Do not expose tier token limits or retention periods as configuration; they are product policy and tests should pin them.

Change the health contract to return `criticalChecks` and `diagnostics` as separate typed objects. Only `criticalChecks` participates in the HTTP readiness boolean. A redacted `diagnostics.context` reports degraded state, per-tier age seconds, reconciliation age, pending/failed counts, backfill counts, and a bounded reason enum such as provider, overall-budget, indexing-budget, run-budget, or backlog. A stale context index must not return HTTP 503 by itself. Update the deploy readiness test so it accepts context degradation but still requires database, Discord, disk, and maintenance readiness.

Update `README.md`, `docs/discord-setup.md`, `docs/operations.md`, and `docs/manual-acceptance.md`. Document Message Content and Read Message History, silent context behavior, source exclusions, retention, budgets, health diagnostics, backfill dry-run/execute/resume, delete permissions, freshness, backup inspection, and summary-only limitations. Add only redacted operational SQL queries.

Existing SQLite online backup automatically contains the new tables. Extend `verify-restore` with schema-aware modes: its default validates the backup's recorded migration set and checksums, while `--require-migration 0003_channel_context` additionally requires the new schema, FTS/vector consistency, known cross-tier retrieval, tombstones, and retained backfill progress. Add a recovery command that can replay the content-free journal into either migration 0003 or a migration-0002 snapshot: the compatibility handler uses stable Discord source IDs and affected durable-memory/source IDs from the journal to scrub the older conversation, source, memory, FTS, and vector tables without requiring the old runtime to understand context tables. The deploy verifies its pre-migration rollback backup in compatible mode, migrates the candidate, then verifies the candidate database with the explicit 0003 requirement. Rollback restores the pre-migration backup and previous digest together, uses the candidate/current recovery image to replay the journal into that snapshot, and verifies compatible mode before starting the previous digest; never run the old digest against the new database.

Every completed local forget also uploads a uniquely named, content-free `forget-journal/` object containing stable source/scope IDs, affected durable-memory IDs, tombstone IDs, occurrence time, schema version, and integrity checksum to the existing backup bucket. It contains no deleted text or summary. Put SQLite backups under `backups/` while retaining lifecycle coverage for legacy root `.db` objects. Replace the undifferentiated bucket rule with tested prefix/suffix rules that keep backup objects age-30 and journal objects for at least 60 days, including noncurrent versions. The current objectCreator/objectViewer role is sufficient and must not be widened.

Make journal reconciliation an unconditional host-side preflight in `/opt/chief/run-container.sh`, so it runs on every service start even after a manual database replacement. Store both `IMAGE` and `RECOVERY_IMAGE` in `deploy.env`: normal deployment sets both to the capable candidate, while rollback changes only `IMAGE` and retains the newer recovery digest. Before the target container starts, the host downloads every retained journal object to a mode-0700 runtime directory, verifies every checksum, and runs the recovery image against the mounted database. Replay all verified entries idempotently instead of selecting by a snapshot timestamp; the at-least-60-day journal retention exceeds the maximum 30-day lifetime of every database recovery artifact. Record a content-free database/manifest replay receipt so repeat boots are cheap, but recompute and replay when either checksum changes. If the bucket cannot be listed/read, a journal is malformed, or replay/verification fails, fail closed before Discord connects and report a redacted critical recovery reason. This privacy-integrity gate is the narrow exception to the rule that ordinary context lag is diagnostic-only.

Treat `/var/lib/chief/pre-deploy/*.db`, `chief.db.failed.*`, and bucket backups as recovery artifacts that may contain logically plaintext forgotten bytes on encrypted-at-rest storage. Create them mode 0600, prune local artifacts after at most 30 days on successful deploy, restore, and every startup, and never use one without the same journal preflight. Active local/searchable state is purged immediately, backups created afterward exclude it, and older recovery bytes become deletion-eligible by age 30; GCS deletion enforcement is asynchronous. Document this bounded accepted risk in deletion acknowledgements and operations.

At milestone end, config, health, documentation, Terraform validation, container smoke, backup/restore, and fake failed-deploy rollback tests pass.

### Task 8: close quality and live acceptance

Expand `test/fixtures/conversation-quality.json` and `test/integration/conversation-quality-replay.test.ts` to at least 40 deterministic cases covering jokes, speculation, conflicting speakers, corrections, topic evolution, repeated facts across tiers, expired sources, summary-only evidence, and requested source links. Each case pins required/forbidden claims, allowed provenance IDs, expected history-versus-memory classification, and retrieval tier. CI requires zero forbidden claims, zero suppressed-source leakage, and 100% returned provenance-ID validity. Extend `scripts/evaluate-conversation-quality.ts` with optional paid grades for rollup faithfulness, supported-claim precision, cross-tier retrieval relevance, and classification. Before production activation, an owner-run evaluation over the pinned corpus must reach at least 90% supported-claim precision and 90% history/memory classification accuracy, with zero suppressed-source leakage and 100% provenance-ID validity. Record model and timestamp; the paid evaluator remains outside CI.

Run all deterministic gates and review the final diff against `decision.md` and this plan. Every new included `src/**/*.ts` module must meet the repository's 80% branch/function/line/statement coverage gate. Keep provider SDK calls behind injected functions so `src/context/openai-context.ts` mapping, validation, and errors are covered with fakes; `src/cli.ts` remains under its existing adapter exclusion while its backfill application seams receive direct tests. Keep complete-scan proof, deletion inference, reply-chunk identity, and `recordDeliveredReply` behavior in covered application/domain modules; excluded `src/discord/gateway.ts` may only translate Discord events and execute injected fetch/send operations. Do not add broad exclusions for context domain logic. Then perform the normal implementation review, formal code review against `main`, and adversarial implementation review. Resolve every verified critical/high issue and record lower findings.

Live rollout is a separate approval boundary. When authorized, deploy with the normal production workflow, verify critical readiness and context diagnostics, allow local catch-up, run `context-backfill --dry-run`, obtain a maximum-spend confirmation, then run a limited paid sample before the full resumable backfill. In the real server, discuss content without mentioning Chief and verify immediate, hourly, daily, weekly, and long-term questions, source links, edit/delete, restart catch-up, self purge, admin confirmation, and silence. Record exact timestamps and measured freshness without copying private content into logs or the work item.

Repository implementation is complete when deterministic validation and reviews pass and owner-run actions are documented. Production acceptance requires the authorized deploy, live freshness checks, deletion checks, backup/restore evidence, and at least a spend-limited backfill sample. A full multi-period backfill may remain actively resumable if its authorized spend ceiling is reached; do not call full history accepted until it finishes.

## Concrete Steps

All commands run from `/Users/kellen/development/github/kellen-miller/chief/.worktrees/channel-context-indexing` unless stated otherwise.

Install the DST-safe time dependency before the first implementation slice:

    pnpm add --save-exact @js-temporal/polyfill@0.5.1

Use tight red-green loops for each agreed seam:

    pnpm exec vitest run --project unit test/unit/context-period.test.ts
    pnpm exec vitest run --project integration test/integration/context-store.test.ts
    pnpm exec vitest run --project unit test/unit/paid-work-queue.test.ts
    pnpm exec vitest run --project unit test/unit/context-assembler.test.ts
    pnpm exec vitest run --project integration test/integration/context-service.test.ts
    pnpm exec vitest run --project unit test/unit/discord-text-controller.test.ts
    pnpm exec vitest run --project integration test/integration/context-backfill.test.ts

After each milestone, run the affected existing suites as well as the new tests:

    pnpm test:unit
    pnpm test:integration
    pnpm typecheck
    pnpm lint

Before review, run the complete repository gate:

    pnpm verify

Validate the production-shaped package and infrastructure where those files change:

    docker build --tag chief:channel-context-test .
    docker run --rm chief:channel-context-test smoke
    terraform -chdir=infra/app fmt -check -recursive
    terraform -chdir=infra/app init -backend=false
    terraform -chdir=infra/app validate
    pnpm exec vitest run --project unit test/unit/repository-policy.test.ts

Exercise local migration, backup, and restore using a fixture database, never the live database:

    pnpm chief -- migrate --database .tmp/context-acceptance/chief.db
    pnpm chief -- backup --database .tmp/context-acceptance/chief.db --destination .tmp/context-acceptance/backups
    pnpm chief -- verify-restore --backup .tmp/context-acceptance/backups/latest.db --require-migration 0003_channel_context
    bash scripts/restore-drill.sh chief:channel-context-test .tmp/context-acceptance/backups/latest.db .tmp/context-acceptance/restore-drill

The live backfill commands are owner-only and must not run without deployment and spend authorization:

    pnpm chief -- context-backfill --dry-run
    pnpm chief -- context-backfill --activate --confirm-guild "$DISCORD_GUILD_ID" --max-usd 1.00
    pnpm chief -- context-backfill --status

Update this plan with concise outputs: test counts, migration counts, context freshness ages, backfill counts/spend, image digest, and restore result. Never record private message or summary content.

## Validation and Acceptance

The schema gate passes when a database at migration 0002 with active/superseded memories, pending jobs, FTS rows, vectors, and conversation events migrates once to 0003, a second migrate is a no-op, every old count and known memory query is preserved, the new context indexes are consistent, and the old image is never started against it.

Calendar acceptance requires exact half-open UTC instants for New York hours/days/weeks, including the spring-forward missing hour and both fall-back repeated hours. No two real instants share a deterministic period key.

Live-ingestion acceptance requires eligible human and delivered Chief messages to become lexically searchable and retrievable within one second without an indexing reply; other surfaces remain absent; every actual Discord reply-chunk ID is recorded once under a shared logical response and is grouped once in prompts; edits replace older revisions; single/bulk deletes disappear from raw, FTS, vector, and active derived retrieval before acknowledgement; restart reconciliation detects offline edits/deletes only after a complete covered scan; and duplicated or late events do not regress state.

Rollup acceptance requires activity-triggered semantic visibility within five minutes plus the agreed ten-minute final hourly, thirty-minute daily, two-hour weekly, and daily long-term deadlines under fake time. Closed periods with no eligible messages create no document. Higher tiers never consume provisional children. Crash after lease, provider timeout, invalid structured output, category-budget exhaustion, and process restart each produce the specified retry, failure, or deferral state without double charging or duplicate active revisions. Normal retention removes content and searchability while leaving only the content-free lineage needed for policy enforcement.

Retrieval acceptance requires one embedding call per text retrieval query and per Realtime `recall_context` tool invocation, paid-call-free lexical search of retained source events, a search of all active rollup tiers and durable memory with the shared query embedding, at most the configured internal token allowance, recent chronology, relevant cross-tier results, source/recent/rollup lineage deduplication, newer-correction preference, disagreement preservation, temporal attribution, and no promotion of history into durable memory. A message outside the newest 30 recent rows but present in source FTS must be retrievable inside one second. Text greetings and local commands make no retrieval call; voice opens no historical snapshot and recalls dynamically when the turn supplies a query. A context-index failure leaves replies available with degraded telemetry; a durable-memory database failure retains the current honest lost-thread response.

Deletion acceptance requires self-only scope for ordinary members, fail-closed current-permission evaluation, cross-member/topic scope for owner/admin, broad confirmation that cannot be replayed, one synchronous cross-store mutation, immediate suppression, content scrubbing, content-free tombstones and durable forget-journal outbox entries, rebuild from remaining inputs, and absence after any backup/restore plus mandatory journal replay. Discord source messages remain untouched. Active local state is absent before acknowledgement; bucket and local recovery artifacts are mode 0600, retained no longer than 30 days, and may contain older bytes during that bounded encrypted-at-rest window. Starting from a migration-0002 or migration-0003 recovery artifact must replay all retained verified journals before Discord connects.

Backfill acceptance requires dry-run count/cost with no persisted message content, a paid-call-free activation CLI, runtime-owned oldest-first idempotent processing, safe pause/resume at every budget, monotonic lifetime run spend across UTC-month resets, no persistent raw text older than 30 days, preserved live revisions, no resurrection through tombstones or restored forget journals, and no Discord writes. Feeding the same fixture live and through backfill produces equivalent active context and retrieval.

Operational acceptance requires critical health to remain ready when ordinary context is degraded, redacted per-tier lag/count/reason diagnostics, read-only bounded context probes, no private content or IDs in logs, preserved monthly overall ceiling, crash/restart recovery of categorized reservations, one-interaction background headroom, enforced USD 3 indexing sub-ceiling, container health, schema-aware verified backup/restore, and fake rollback of image plus database. Separate recovery tests replace the database outside `restore.sh`, start through the normal systemd path, and prove fail-closed behavior for unreachable GCS, malformed journal, checksum mismatch, migration-0002 replay through `RECOVERY_IMAGE`, and local-artifact pruning.

The deterministic final gate is `pnpm verify` plus container, Terraform, restore, and rollback checks. Live production acceptance follows `docs/manual-acceptance.md` and is clearly labeled pending until authorized and observed.

## Idempotence and Recovery

All migrations run once in a transaction and retain checksums. Never edit migrations 0001 or 0002. A failed 0003 leaves no migration record. A deploy takes and verifies an offline-consistent pre-migration backup before applying 0003. Restore the prior image only with that database; preserve the failed database for investigation for at most 30 days.

Source ingestion is idempotent by configured guild/channel plus Discord message ID, revision time, and normalized checksum. Delivered Chief replies are idempotent by their actual Discord snowflakes. Context and memory jobs carry source checksums and are idempotent by tier, timezone, half-open period, optional topic key, and revision input checksum. A successful write rechecks source revisions/tombstones and replaces active FTS/vector rows in the same transaction. Leases expire safely after crashes. Budget deferral does not consume attempts.

Deletion makes content unavailable before rebuilding. Every context or memory job rechecks source revision and source/document tombstones inside its commit transaction. Confirmation records are single-use and expire. On every service start, the host preflight uses `RECOVERY_IMAGE` to verify and idempotently replay all retained journal entries before it launches `IMAGE`; inability to prove replay fails closed. The recovery handler supports both migration 0002 and 0003, and journal retention is longer than the maximum lifetime of every recovery database. Backfill and reconciliation use durable cursors and stable source identity, so interruption, rate limiting, or a process crash can resume without duplicate active data or false deletion inference.

If a summary prompt or ranking policy changes, bump a stored generation-policy version and enqueue explicit rebuilds; do not silently reinterpret old rows. If a rebuild cannot reproduce an old summary because raw inputs expired, keep the current summary unless deletion requires suppression, mark its provenance summary-only, and record the limitation.

## Artifacts and Notes

The intent/provenance source is `.agent/work/channel-context-indexing/decision.md`. Lifecycle state is `.agent/work/channel-context-indexing/meta.json`. Domain language is `CONTEXT.md`; ADR 0001 records the rollup choice. Planning and implementation adversarial reviews live under `.agent/work/channel-context-indexing/adversarial/`.

The baseline before implementation was 27 test files and 203 tests passing. The branch started at `cdcc2e5e92c60bfab08406a1ec7dcc952f1e6969` with no upstream. The primary checkout's untracked `infra/app/backend.hcl` and `infra/bootstrap/backend.hcl` are user-owned and must remain untouched.

Current relevant dependencies are `discord.js` 14.26.5, `openai` 6.46.0, `@openai/agents` 0.13.2, `better-sqlite3` 12.11.1, and `sqlite-vec` 0.1.9. `@js-temporal/polyfill` 0.5.1 is the exact planned addition because runtime `Temporal` is unavailable and the accepted calendar must handle New York DST correctly.

## Plan Revision Notes

- 2026-07-14: Created the initial self-contained plan from the approved grill and current repository evidence.
- 2026-07-14: Improvement pass 1 added activity-triggered provisional hourly revisions to make the approved five-minute semantic target achievable, ensured daily/weekly rollups consume only final children, and changed retention from row deletion to content scrubbing so deletion lineage survives. Usefulness score: 9/10 because it resolved a direct freshness contradiction and a future privacy/rebuild failure.
- 2026-07-14: Improvement pass 2 synchronized edit/delete behavior with durable-memory provenance, moved text-source sequencing behind the context module, prevented Chief self-reinforcement, and replaced unbounded historical staging with a content-free reverse page manifest. Usefulness score: 9/10 because it closed stale-memory and retention violations across real adjacent code paths.
- 2026-07-14: Improvement pass 3 moved paid backfill into the running process so one queue and budget remain authoritative, prohibited persistent expired raw text during backfill, retained real source links without retaining local content, and corrected concrete container/policy/restore commands against repository scripts. Usefulness score: 10/10 because it prevented cross-process overspend and made the operational instructions executable.
- 2026-07-14: Improvement pass 4 resolved adversarial findings across the real repository: dynamic Realtime recall, budget admission headroom, partial/bulk/offline Discord lifecycle handling, synchronous atomic deletion, actual delivered reply IDs, schema-aware restore checks, backup forget-journal replay, safe SQLite migration/FTS semantics, and measurable quality gates. Usefulness score: 10/10 because each change closed a concrete correctness, privacy, availability, or release-decision gap that queue priority or broad acceptance prose had hidden.
- 2026-07-14: Improvement pass 5 closed the resolution review's remaining recovery and identity seams: unconditional fail-closed journal replay on every host start, migration-0002 recovery through a separate image, bounded local recovery artifacts, one source row per Chief reply chunk, covered deletion-inference logic, and explicit source-FTS retrieval. Usefulness score: 10/10 because it removed operator bypass, old-image, forgotten-byte, coverage, duplicate-chunk, and one-second retrieval ambiguities before implementation.
- 2026-07-14: Task 5 implemented the planned synchronous deletion seam and refined confirmation-time permission checks, broad no-match redaction, supersession-chain scrubbing, and artifact-independent tombstone replay from executable regressions. These changes preserve the approved policy while closing concrete permission-loss, FTS, and older-backup failure modes.
- 2026-07-14: Task 6 implemented the content-free reverse manifest and runtime-owned backfill seam. Resume refetches prior page boundaries to preserve privacy, expired raw content exists only in bounded memory before an atomic derived commit, and restart admission conservatively charges unresolved reservations before any new provider call.
- 2026-07-14: Task 6 review correction extended run attribution through every induced rollup, enforced hard cost and exact manifest-range contracts, replaced ordinal segment idempotence with source-derived identity, and made same-hour aggregation a bounded rolling fold.
- 2026-07-14: Task 6 re-review correction detached live conflicts from non-active runs without losing old reservation accounting, and added append-only migration 0008 to pause and conservatively attribute ambiguous populated-0006 lifecycle state before resume.
- 2026-07-14: Task 6 final correction added append-only migration 0009 to replace null-only legacy attribution with pre-0007 reservation timing and backfill segment lineage. It detaches post-0007 live work stolen by 0008, reopens falsely completed legacy runs, and directly covers derived/topic conflicts across paused, failed, and replaced owners while retaining old-run reservation accounting.
- 2026-07-14: Task 6 final migration repair added append-only migration 0010. Ownership now requires the job's exact current input checksum plus persisted document lineage to a run segment, or an exact recent-hourly source checksum with a source snowflake inside that run's content-free manifest bounds and matching scope. The repair ignores reservation timestamps, period overlap, and mutable pause reasons; it detaches unproven jobs and outstanding reservations, reopens exactly proven obligations, and preserves run drain and ceiling enforcement.
- 2026-07-14: Task 6 0010 re-review aligned future daily backfill checksums with the canonical period-and-ID input order while retaining recognition of legacy ID-ordered jobs. A detached live job now leaves its independently old-run-attributed outstanding reservation intact for conservative reconciliation, and exact proof no longer resurrects intentionally failed or replaced runs; recovery is limited to active, paused, falsely completed, or migration-marked lifecycle state.
- 2026-07-14: Task 6 final ownership correction added append-only migrations 0011 and 0012. Every new reservation records immutable live or backfill origin independently of mutable job and ledger ownership; repair restores accounting from that origin. Pre-provenance ambiguity records an unleaseable accounting hold, fails the affected job and run with rebuild-required diagnostics, and rejects unsafe resume without charging or releasing the reservation.
- 2026-07-14: Task 6 final provenance review moved hold enforcement into `SqliteUsageLedger.reconcile` as well as scheduler selection. A real 0012 migration fixture now calls the public conservative-reconciliation API, receives an explicit held error, and proves the ledger actual, run actual, in-memory reservation, and durable hold all remain unchanged.
- 2026-07-14: Task 7 separated diagnostic context health from critical readiness, packaged the approved timezone and indexing ceiling, and made recovery an unconditional host preflight. Restore verification and journal replay use stable cross-snapshot identity; deploy/rollback state records runtime and recovery images independently; local and bucket retention now enforce the bounded recovery-artifact risk. Operator documentation and deterministic container, restore, and Terraform evidence complete Milestone 7 without claiming live acceptance.
- 2026-07-14: Task 7 independent review correction armed rollback before candidate migration, retained private memory-source scope in journals, made 0003 index verification exact, bound database and runtime-image capabilities, and replayed all generation-qualified GCS journals. These executable regressions close the remaining partial-commit, migration-0002 resurrection, same-count corruption, mixed-image, and noncurrent-version recovery gaps.
- 2026-07-14: Task 7 re-review correction appended migration 0013 without changing prior checksums, retained only valid legacy Discord text identity, matched journal recovery to migration-0002 platform identity, and made explicit verification schema-prefix aware. Exact-0003 startup and a real 0002-to-current memory-only forget/replay now have executable coverage.
- 2026-07-14: Task 7 final correction made the legacy snowflake tombstone an exact bounded alias at every ingestion and mutation boundary, wrote it atomically before local suppression, and proved both live reapply and backfill remain suppressed after recovery.
- 2026-07-14: Task 8 added the shared 44-case real-retrieval corpus and dedicated optional grader. Independent review replaced target-filtered and vacuous acceptance with active distractors, ordered corrections/evolution, per-class thresholds, requested-link recall, normalized leakage markers, and complete-production-payload safety inspection.
