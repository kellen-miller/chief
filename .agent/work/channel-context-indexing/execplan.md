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
- [ ] Milestone 5: implement authorized correction, confirmation, forgetting, and lineage rebuild.
- [ ] Milestone 6: add dry-run and resumable full-history backfill.
- [ ] Milestone 7: expose degraded health, document operations, and validate rollback.
- [ ] Milestone 8: complete deterministic, quality, container, and live acceptance evidence.

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

## Outcomes & Retrospective

Planning is complete but implementation has not started. Update this section after each milestone with user-visible behavior, measured freshness, validation evidence, remaining owner actions, and any divergence from the approved design.

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
