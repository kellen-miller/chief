# Improve Chief Conversation Quality

## Objective

Make Chief follow a fast-moving group conversation across text and voice, persist recent conversational state across restarts, perform truthful explicit memory changes, interpret Discord mentions without corrupting sentences, and respond with a more confident American chief-of-staff personality. Preserve mention-only response gating in group text, existing voice addressing rules, the exact “Mr. President” suffix, the monthly usage ceiling, and automatic merge-to-main deployment.

## Confirmed user decisions

### Working conversation context

- Recent conversation and durable memory are different concepts. Recent conversation preserves transient dialogue; durable memory preserves long-lived communal facts, preferences, plans, recurring jokes, relationships, and decisions.
- Text and voice share one persisted communal timeline containing eligible human text, human voice transcripts, Chief text replies, and Chief voice transcripts.
- Chief silently records ambient human conversation in the allowlisted main channel while continuing to reply only when mentioned or invoked by a command.
- Recent timeline rows are retained for seven days. Each model request receives no more than the newest thirty eligible messages or approximately six thousand input tokens, whichever limit is reached first.
- A newly opened Realtime voice session is seeded from the same bounded timeline. Its live provider session then owns subsequent within-session turn history.
- The new timeline starts empty after deployment. Existing raw memory sources are not backfilled because they omit Chief’s replies and would create a misleading conversation.

### Explicit durable memory

- Any human participant on the allowlisted surface may ask Chief to remember, correct, or forget communal memory. Version one still exposes no memory browser or database dump.
- Explicit memory changes run synchronously in the paid-work FIFO. Chief confirms success only after the SQLite transaction commits.
- The extraction model may canonicalize an explicit memory. Non-sensitive, non-empty explicit proposals use the existing separate `0.75` explicit-confidence floor rather than the automatic extraction threshold of `0.85`. Chief never acknowledges a rejected proposal as saved.
- Sensitive proposals are rejected and Chief says they were not saved. Clear corrections supersede stale memories. Ambiguous conflicts retain both memories and Chief asks for clarification.
- Automatic extraction from ordinary conversation remains asynchronous, silent, conservative, and subject to its existing confidence threshold.

### Input interpretation and personality

- A leading Discord mention is an address and is removed from the request. A mid-sentence or trailing mention is replaced with the literal word “Chief.” A bare mention remains a greeting.
- Use `gpt-5.6-luna` as the text model default at reasoning effort `low`. Standard input/output prices are `$1.00/$6.00` per million tokens, cached reads are `$0.10`, and cache writes are `$1.25`. Keep model identifiers configurable. Voice, transcription, embeddings, and the `gpt-5.4-nano` memory extractor remain unchanged.
- Chief recognizes references to himself, holds an opinion until given a substantive reason to change it, corrects false premises directly, and may answer direct insults with a concise dry roast.
- Chief may mirror ordinary profanity sparingly. He never uses protected-class slurs, threats, or sustained personal harassment. When declining, he states the boundary briefly without a corporate lecture and redirects or jokes when appropriate.

### Failure, observability, validation, and rollout

- A conversation or durable-memory database failure returns a concise “I lost the thread” failure instead of silently calling the model without state.
- Explicit memory failure says the fact was not saved. A failed model call retains the human event but records no Chief reply.
- Structured telemetry records only counts and outcomes: recent-message count, approximate context tokens, durable-memory count, and explicit-memory result. It never logs prompts, messages, transcripts, Discord IDs, provider payloads, or secrets.
- Production data must survive. Add an ordered, additive SQLite migration; preserve existing source events, memory jobs, usage records, and durable memories. Do not reset or destructively rewrite the database.
- Mandatory PR CI uses deterministic, unpaid transcript replays. A separate optional command may run live model comparisons with the owner’s local API key.
- Merge to `main` continues to deploy automatically. Post-deploy acceptance includes a real Discord smoke test. Existing verified pre-migration backup, immutable image digest, database restore, and prior-image restart remain the rollback mechanism. An older image may be restarted after a schema deployment only together with the matching verified pre-deploy database backup.

## Agent-recommended design defaults

- Add a concrete `ConversationStore` module backed by the existing `better-sqlite3` connection. Its small interface records normalized events, selects an as-of bounded context, expires old rows, and hides SQL, retention, ordering, and token estimation. Tests use real in-memory SQLite rather than adding a hypothetical storage interface.
- Add a concrete `MemoryService` module around the existing memory store, embedder, extractor, and budget. It hides explicit-versus-automatic thresholds, proposal application, embeddings, supersession, conflicts, forgetting, and user-facing mutation receipts.
- Deepen `ConversationOrchestrator` rather than adding a parallel coordinator. It owns the FIFO sequence: persist the human event, snapshot context as of that event, apply explicit memory or retrieve durable memories, call the provider, persist Chief’s logical reply, and return delivery content.
- Keep Discord qualification and transport delivery in Discord modules. Keep OpenAI prompt/session construction and tool adaptation in OpenAI modules. Neither adapter owns persistence policy.
- Store a display name with recent human events so context is intelligible to the model; retain the stable Discord ID only in SQLite for provenance and correlation. Provider payloads contain sanitized display labels but never Discord IDs. This is acceptable for the private allowlisted friend server already placed in scope.
- Use an additive `conversation_events` table instead of repurposing `source_events`. The latter remains the canonical input queue for long-term memory extraction; duplicating a small amount of short-lived text buys clean ownership and rollback-safe compatibility with the deployed schema.
- Estimate the history token budget deterministically from character count. Exact provider tokenization is unnecessary because the hard message count and conservative approximation bound the request.

## Assumptions

- There is one configured text channel and one configured voice channel, so the communal timeline does not need multi-channel partitioning in this version.
- Discord display names may change; stored names describe who spoke at that time and are not identity authority.
- Realtime function tools can call the same memory service used by text. Text explicit-memory intent is detected deterministically before generation; voice uses narrowly described memory tools because the audio transcript is produced inside the Realtime session in solo mode.
- The current deployment transaction and backup contain the database migration risk without changes to cloud topology.

## Open questions or user judgments

No product or architecture decisions remain open. Exact phrasing of deterministic success/failure replies may be refined during transcript testing while preserving truthful outcomes and the required suffix.

## Accepted risks and failure modes

- Persisting ambient dialogue increases local database contents and model input. Seven-day deletion, thirty-message selection, and an approximate six-thousand-token cap bound that cost.
- A Realtime model may fail to call an explicit memory tool. Voice instructions and deterministic tool-result tests reduce this risk, but real voice acceptance remains necessary.
- Model personality is probabilistic. Deterministic prompt-shape tests cannot prove tone; the checked-in replay scorecard and optional live evaluation provide the realistic evidence.
- Concurrent Discord requests can arrive before earlier answers are generated. Context snapshots must use the persisted event ID as an upper bound so later human events never leak backward into an earlier model request. The FIFO records each Chief reply before releasing the next paid turn.
- Recent messages and mutable Discord display names are untrusted model input. Provider adapters structurally label them, strip control characters and mention markup from display labels, and never treat seeded history as a fresh request. Deterministic injection fixtures test that hostile prior content cannot alter suffix, safety, or response-gating policy.
- Recording a Chief reply before Discord delivery can preserve a reply the transport later fails to deliver. This is accepted because it preserves deterministic FIFO context; delivery failure remains observable in existing gateway logs.

## Validation expectations

- A replay of the supplied Teddy Roosevelt/JFK/Polk conversation proves that “those outcomes” and “pick one for Polk” receive the relevant prior turns, while later concurrent messages do not leak into earlier requests.
- Unit tests prove leading, middle, trailing, repeated, and bare mentions; self-reference preservation; greeting behavior; and response gating.
- Integration tests prove migration from the deployed `0001_initial` database, restart persistence, seven-day expiry, thirty-message selection, approximate token bounding, human/Chief ordering, and no historical backfill.
- Memory tests prove synchronous explicit creation, sensitive rejection, correction, conflict, forgetting, truthful receipts, automatic threshold preservation, and budget failure.
- Text-adapter tests prove bounded conversation plus durable memory serialization, reasoning effort `low`, confident personality instructions, and non-content telemetry.
- Voice tests prove new-session context seeding, human and Chief transcript persistence, memory-tool wiring, and unchanged solo/group addressing and interruption.
- `pnpm verify`, `actionlint`, `shellcheck scripts/*.sh`, `terraform fmt -check -recursive infra`, and `terraform -chdir=infra/app validate -no-color` pass. Mandatory CI performs no paid OpenAI calls.
- Optional live evaluation with `OPENAI_API_KEY` proves the configured text model obeys the no-military-academy constraint and handles self-reference, while the configured memory model accepts the harmless preference and rejects a synthetic credential without model-family replacement.

## Source notes

- Decisions were confirmed through the July 12, 2026 `grill-plan-build` conversation following diagnosis of `/Users/kellen/.codex/attachments/2fdc5af3-8510-47e2-b4b9-0d0ec88ccf7c/pasted-text.txt`.
- Production evidence before planning showed thirty-six completed memory jobs, zero failed jobs, and zero durable memories. A deterministic orchestrator replay showed that a follow-up reached the text model with only the current prompt and an empty memory list.
- Live diagnostic probes showed `gpt-5.4-mini` at reasoning `none` violated the supplied military-academy exclusion, while the same model at `low` and `gpt-5.6-luna` at `low` selected an allowed team. GPT-5.4 Mini was the initial low-cost baseline. After the conversation-quality rollout, the user explicitly selected GPT-5.6 Luna at `low`; a fresh three-case text replay and a content-redacted native web-search probe passed before publication. Formal review then required the same explicit `low` setting for both text and voice research plus cache-aware pricing so the usage ceiling remains conservative.

## Workflow records

- Worktree: `/Users/kellen/development/github/kellen-miller/chief/.worktrees/conversation-quality`
- Branch: `codex/improve-conversation-quality`
- Model-upgrade follow-up branch: `codex/use-gpt-5-6-luna`
- Base ref and initial commit: `origin/main` at `999b190a0d65e89cc2351d53b49c5c21e3f2add3`
- Upstream at planning time: `origin/main`
- `CONTEXT.md`: intentionally skipped because the recent-conversation and durable-memory terms are local to this feature and are fully recorded here and in the executable plan.
- ADRs: intentionally skipped because no public protocol, cloud topology, or hard-to-reverse provider decision changes; the additive schema and internal module seams are covered by migration tests and this decision record.
