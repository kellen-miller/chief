# Index the main channel across time horizons

## Objective

Give Chief relevant context from unmentioned discussion in the configured main Discord text channel across immediate, hourly, daily, weekly, and long-term horizons. Chief must remain mention-only, distinguish historical discussion from accepted fact, preserve provenance, respect deletion and budget boundaries, and continue answering when background indexing is degraded.

## Worktree

- Path: `/Users/kellen/development/github/kellen-miller/chief/.worktrees/channel-context-indexing`
- Branch: `codex/channel-context-indexing`
- Base ref: `main` at `cdcc2e5e92c60bfab08406a1ec7dcc952f1e6969`
- Upstream: none
- In-place exception: none; the primary checkout's untracked Terraform backend files remain untouched.

## Confirmed user decisions

### Product behavior

- Index eligible unmentioned main-channel discussion across hourly, daily, weekly, and long-term horizons.
- Every substantive `@Chief` request automatically searches every tier while retaining the immediate chronological conversation window. Greetings and local commands do not perform retrieval.
- Rollups are always silent. Chief does not post scheduled digests and continues replying only when addressed or explicitly invoked.
- Historical context records what the group discussed; it is not authoritative truth. Stable facts and preferences continue through the durable-memory acceptance rules.
- Ordinary answers use natural temporal attribution. Chief provides Discord jump links on request and proactively when sources conflict or a correction matters.
- Chief says when evidence is incomplete, expired, or represented only by a derived summary.

### Calendar and retention

- The configured context timezone is `America/New_York`.
- Hourly buckets begin on local clock hours, daily buckets at local midnight, and weekly buckets on Monday. Empty periods create no rollup.
- Recent chronological conversation remains available for seven days.
- Raw text source events and hourly rollups remain for 30 days.
- Daily rollups remain for one year.
- Weekly rollups, long-term topic history, and durable memories remain until corrected or forgotten.

### Source boundary

- Include human messages and Chief replies in the configured main text channel.
- Preserve speaker identity, timestamps, reply relationships, mentions, URLs, and attachment names or captions.
- Apply message edits to the source and rebuild affected descendants.
- Treat Discord message deletion as an immediate local deletion request.
- Journal authoritative Discord deletions externally, just like explicit local forget operations, so an older recovery artifact cannot expose the source before reconciliation.
- Handle single and bulk gateway deletions immediately, and reconcile edits/deletions missed during downtime through a resumable full-channel identity scan. Never infer deletion from an incomplete scan.
- Do not crawl or interpret attachment content.
- Exclude reactions, threads, other channels, other bots, and webhooks.

### Correction, deletion, and authorization

- A long-term correction becomes newer historical evidence and supersedes conflicting durable memory where the existing memory rules accept it.
- `Chief, forget X` purges matched local raw copies, affected rollups, long-term topics, and durable memories. The original Discord messages remain outside Chief's control.
- Suppress matched material from retrieval before asynchronous rebuild begins. Content-free tombstones prevent backfill or stale jobs from recreating it.
- Scrub active local/searchable state before deletion acknowledgement. Bucket backups and mode-0600 local recovery copies created earlier may retain bytes for at most 30 days on encrypted-at-rest storage, but a durable content-free outbox and external forget journal retained for at least 60 days must be replayed before any restored snapshot can run.
- Ambiguous or broad deletion requires clarification.
- Any member may purge material derived from their own messages and may add correction evidence.
- Only the Discord guild owner or a current administrator may purge another member's material or an entire topic. Broad administrative deletion requires confirmation.

### Retrieval and architecture

- Use hierarchical rollups: source events feed hourly rollups; hourly feed daily; daily feed weekly; daily and weekly changes update long-term topics.
- Store each tier as logically distinct documents in one FTS5 and sqlite-vec retrieval framework.
- Search retained source-message FTS synchronously as immediate historical evidence; label source matches separately from derived rollups and deduplicate them against recent conversation and shared rollup lineage.
- Record complete source lineage and version derived documents so edits, deletion, retry, and backfill are idempotent.
- Keep `ChannelContextService` responsible for historical context and `MemoryService` responsible for durable facts and preferences.
- Assemble one typed prompt context containing recent conversation, historical context, and durable memory. Reuse one query embedding for historical and durable retrieval, normalize scores per tier, cap tokens per tier, and deduplicate repeated information.
- Text assembles context before generation. Realtime voice keeps a model-invoked `recall_context` tool so the spoken query is known; each tool query shares one embedding across historical and durable retrieval.
- Backfill passes through the same normalized ingestion and job path as live Discord events.

### Cost, scheduling, and failure

- The overall monthly hard ceiling remains USD 10 by default.
- Background indexing has a configurable USD 3 monthly sub-ceiling under the overall ceiling.
- Interactive work takes priority over queued background work. A running provider call is not forcibly interrupted, but background work yields between jobs.
- Select a queue slot before budget reservation, and refuse background admission that would consume the overall-budget headroom for one maximum conservative interaction.
- Historical backfill requires an explicit per-run maximum spend and may resume later.
- Track backfill spend for the lifetime of the run; its maximum does not reset with monthly overall or indexing budgets.
- Paid indexing pauses without consuming retry attempts when its sub-budget is unavailable. Existing indexes remain searchable.
- A failed or lagging index does not take Discord replies offline. Chief falls back to available recent conversation and durable memory while health reports degraded context freshness without logging content.

### Freshness targets

- New eligible messages reach immediate context and lexical search within one second.
- Semantic indexing completes within five minutes.
- Hourly rollups complete within ten minutes after the hour closes.
- Daily rollups complete within thirty minutes after local midnight.
- Weekly rollups complete within two hours after the local week closes.
- Long-term topics refresh after each daily rollup.
- Missed jobs catch up after restart without delaying interactive work behind queued background jobs.
- Provider-dependent targets apply while Chief is running, provider service is available, and applicable budget/run capacity remains; otherwise redacted health reports the lag reason and catch-up resumes by deadline.

### Backfill and rollout

- Provide an explicit owner-run, resumable full-history backfill for the configured main channel.
- Dry-run backfill fetches metadata, reports eligible message count, and estimates paid processing cost before generation.
- Backfill respects Discord rate limits, checkpoints progress, ingests oldest to newest, coexists with live ingestion, pauses at its spend limit, and resumes idempotently.
- Deployment takes and verifies a pre-migration database backup. An older image is restored only with that matching database backup after a separately retained recovery image replays all verified forget journals.
- Every systemd start runs the journal recovery preflight, including after manual database replacement. Missing/unreadable journal storage, a malformed entry, or failed replay blocks Discord startup; ordinary indexing lag remains noncritical.
- Local `pre-deploy` and `.failed.*` database artifacts use owner-only permissions and are pruned after at most 30 days.
- Full paid production backfill remains a separately authorized owner action even after implementation and deployment code are ready.

## Non-goals

- Indexing the whole guild, other channels, or threads.
- Proactive hourly, daily, or weekly Discord posts.
- Attachment download, OCR, image understanding, audio transcription, link crawling, or reaction analysis during indexing.
- Treating ambient claims, jokes, plans, or speculation as accepted truth.
- A user-facing memory or index browser.
- A general knowledge graph or entity graph.
- Preserving an old dual retrieval path after the new context assembler is validated.

## Domain language and documentation

- Root `CONTEXT.md` defines source event, recent conversation, historical context, context tier, rollup, long-term topic, durable memory, provenance, and suppression tombstone.
- `docs/adr/0001-use-hierarchical-context-rollups.md` records the hard-to-reverse choice of hierarchical rollups over raw query windows or a living topic graph.
- The repository's README, Discord setup, operations, and manual-acceptance guides must be updated with the final behavior and owner actions.

## Accepted risks and failure modes

- Summaries can omit nuance or preserve a mistaken interpretation. Structured prompts, provenance, corrections, conflicts, quality replay, and source-link disclosure mitigate but cannot eliminate this risk.
- A long-running summary call can delay a newly arrived interactive request until that call returns. Small bounded jobs and priority between jobs constrain the delay.
- Backfilling a large history may take multiple budget periods. Progress is durable and partial indexes remain usable.
- Raw content can expire before a later dispute. Chief must label summary-only evidence and cannot claim verbatim recovery.
- Cross-tier deletion is destructive. Immediate suppression, scoped authorization, confirmation, lineage, verified backup, and idempotent rebuild limit accidental loss.
- Discord events may arrive late, duplicated, partial, out of order, or be missed during downtime. Stable message IDs, revision checks, partial/bulk handlers, and successful-pass reconciliation are required.
- Active forgetting is immediate, but encrypted-at-rest bucket or local recovery bytes can persist for the bounded age-30 window, and GCS enforcement is asynchronous. The unconditional startup forget-journal preflight prevents logical resurrection during that window.
- Weekly and long-term material is retained indefinitely, increasing the importance of deletion correctness and restore drills.

## Validation expectations

- Unit tests cover New York bucket boundaries and daylight-saving transitions, retention, scoring, deduplication, evidence formatting, fail-closed authorization, confirmation, interactive budget headroom, indexing sub-budget enforcement, and monotonic per-run spend.
- SQLite integration tests cover migrations over a production-shaped fixture, FTS5/vector search, lineage, invalidation, immediate suppression, rebuild, leases, retry, retention, and backup/restore.
- Discord adapter/application tests cover creates, partial edits, single/bulk deletes, complete-versus-incomplete offline reconciliation, one independently keyed source row per delivered Chief reply chunk, reply grouping/lineage, attachment metadata, permission snapshots, pagination, rate limits, duplicate pages, restart, and concurrent live ingestion. Safety-critical reconciliation and delivered-reply logic lives in covered modules outside the excluded gateway adapter.
- Conversation-quality replay covers at least 40 pinned cases for jokes, speculation, disagreement, correction, summary-only evidence, source requests, and answers spanning every tier.
- CI uses fakes and makes no paid API calls. It requires zero forbidden claims or suppressed-source leakage and valid provenance IDs. Before production activation, the owner-run paid evaluator requires at least 90% supported-claim precision and 90% history/memory classification accuracy.
- Live acceptance measures the agreed freshness bounds and verifies silent observation, source-FTS retrieval outside the newest 30 rows, temporal attribution, source links, restart catch-up, self/admin deletion, and a spend-limited production backfill sample.
- Recovery acceptance proves every-start replay, fail-closed journal unavailability/corruption, migration-0002 compatibility replay through the recovery image, and age-30 pruning of local recovery artifacts.
- Full repository validation is `pnpm verify`; container, migration, backup, restore, deployment rollback, and Terraform checks remain required where affected.

## Compatibility constraints

Chief already has production conversation and durable-memory data. Migrations must preserve those records and their lexical/vector indexes. This is a production-data constraint, not a request for legacy names, aliases, dual paths, or old prompt shapes. Once migrated, the code uses the new context path only.

## Assumptions

- One configured private guild and one configured main text channel remain the entire indexing scope.
- English is the summarization and retrieval language for this server.
- Guild owner/administrator status is evaluated from the live Discord message context when destructive intent is submitted; missing current permission data fails closed without adding the privileged `GuildMembers` intent.
- The existing memory model and price configuration can also generate structured context rollups; no separate context model is required initially.
- The bot already has `Read Message History`, which is sufficient for the owner-run backfill.

## Open questions

None. Paid production deployment and the maximum spend for the full historical backfill require explicit authorization at execution time, but do not change the implementation design.

## Source notes

- Primary provenance: the completed user/agent grill in the current Codex task on 2026-07-13 and 2026-07-14 UTC.
- Repository evidence: `src/discord/text-controller.ts` already observes eligible unmentioned messages; `src/conversation/conversation-store.ts` supplies at most 30 recent messages and approximately 6,000 tokens; `src/memory/memory-service.ts` separately extracts and retrieves durable memory; `src/runtime.ts` runs the existing memory worker and health lifecycle; `src/memory/database.ts` currently ends at migration `0002_conversation_events`.
- Worktree baseline: `pnpm test` passed 27 files and 203 tests before artifact creation.
