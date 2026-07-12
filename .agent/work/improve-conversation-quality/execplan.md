# Give Chief coherent communal conversation and memory

This ExecPlan is a living document. Maintain it in accordance with `.agent/PLANS.md`, including the required `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` sections. The intent and provenance record is `.agent/work/improve-conversation-quality/decision.md`; this plan repeats every implementation-critical decision so a new contributor can execute it without the earlier conversation.

## Purpose / Big Picture

Before the first five milestones, Chief answered each Discord text mention as an isolated request. Ambient messages were queued for long-term memory extraction, but no recent dialogue or Chief reply was supplied to the text model. Production had thirty-six completed memory jobs and zero durable memories, so follow-ups such as “those outcomes” and “pick one for Polk” had neither working conversation nor durable recall. Milestones 1 through 7 are now merged and deployed. Live use proves recent conversation recall, but production still has zero durable memories because no post-fix explicit remember command has received the deterministic commit receipt. The current follow-up upgrades only the text model from GPT-5.4 Mini to GPT-5.6 Luna at the existing `low` reasoning effort, with matching standard token prices.

After this work, members of the private allowlisted server can carry one conversation across ambient text, addressed text, and voice. Recent dialogue survives process restarts for seven days, while durable communal memory remains a separate long-lived store. Explicit remember, correct, and forget requests report success only after SQLite commits. Chief understands references to himself, retains a confident dry personality, and still responds only when the existing text or voice addressing policy says he should. The behavior is visible through a deterministic replay of the reported Teddy Roosevelt/JFK/Polk conversation and an optional live-model evaluation.

The design reduces complexity by deepening three existing concepts instead of adding another agent framework. A concrete `ConversationStore` hides recent-history SQL, ordering, retention, and request bounds. A concrete `MemoryService` hides durable-memory extraction, thresholds, embeddings, mutations, conflicts, and receipts. `ConversationOrchestrator` hides sequencing across both stores, the paid FIFO, providers, and reply recording. Discord adapters translate Discord; OpenAI adapters translate OpenAI. Callers no longer coordinate observation, retrieval, generation, and persistence themselves.

## Progress

- [x] (2026-07-12 17:24Z) Completed the grill, isolated the worktree, confirmed `origin/main` at `999b190`, and ran the 137-test baseline successfully.
- [x] (2026-07-12 17:24Z) Drafted `decision.md`, `meta.json`, and this initial ExecPlan.
- [x] (2026-07-12 17:31Z) Ran three code-grounded ExecPlan improvement passes covering arrival/FIFO ordering, deep durable-memory ownership, and typed Realtime history seeding.
- [x] (2026-07-12 17:42Z) Resolved the independent review's four high-severity and eight lower-severity findings in the plan; a focused re-review remains before implementation.
- [x] (2026-07-12 17:47Z) Passed focused independent re-review with zero remaining critical, high, medium, or low findings.
- [x] (2026-07-12 18:20Z) Milestone 1 added the ordered `0002` migration and concrete bounded `ConversationStore`; migration, restart, idempotency, causal as-of, retention, message, and token tests pass.
- [x] (2026-07-12 18:20Z) Milestone 2 normalized leading/middle/trailing/repeated mentions and moved synchronous text observation, FIFO generation, and reply recording behind `ConversationOrchestrator` with replay coverage.
- [x] (2026-07-12 18:20Z) Milestone 3 replaced worker/context modules with `MemoryService`, preserved automatic work, added synchronous explicit receipts, and proved `0.74`/`0.75` plus whole-batch rollback.
- [x] (2026-07-12 18:20Z) Milestone 4 supplied separate recent/durable context at low reasoning, seeded acknowledged typed Realtime history, correlated voice transcripts, persisted cross-medium turns, and added voice memory tools.
- [x] (2026-07-12 18:20Z) Milestone 5 added the sanitized Teddy/Polk replay, optional paid aggregate evaluation, non-content telemetry, startup maintenance, health checks, and operational documentation.
- [x] (2026-07-12 18:22Z) Ran the owner-authorized paid evaluation against `gpt-5.4-mini` at reasoning `low`: `polk-no-military` passed with 595 input/117 output tokens in 2832 ms; `chief-self-reference` passed with 552 input/65 output tokens in 1333 ms.
- [x] (2026-07-12 18:26Z) Recent-work review found and fixed cross-speaker Realtime-session provenance by rotating the cached session when the speaker changes; the regression test proves the second session receives the second President's identity. It also removed raw review/account artifacts and restored build isolation for the optional evaluation script. Usefulness score: 9/10 - caught a real group-voice attribution bug before publication.
- [x] (2026-07-12 19:19Z) Completed recent-work and formal Standards/Spec review, resolved every verified finding, and passed focused re-review with no remaining findings. Three bounded Claude implementation-review attempts emitted no result; `adversarial/implementation-review.md` records the external reviewer as unavailable rather than approved.
- [x] (2026-07-12 19:20Z) Passed the fresh pre-publication gate: formatting, ESLint, typecheck, 180 tests, 81.44% branch coverage, build, Actionlint, ShellCheck, Terraform formatting/validation, and `git diff --check`.
- [x] (2026-07-12 19:20Z) Re-ran the owner-authorized paid evaluation against `gpt-5.4-mini` at reasoning `low`: `polk-no-military` passed with 595 input/98 output tokens in 2330 ms; `chief-self-reference` passed with 552 input/67 output tokens in 1332 ms; `those-outcomes-follow-up` passed with 572 input/142 output tokens in 1980 ms.
- [x] (2026-07-12 20:00Z) Production text acceptance proved shared follow-up context and constraint preservation: Chief explained the prior outcomes and selected Oregon rather than a military academy. A corrected explicit remember invocation reached the synchronous memory path but was falsely rejected as sensitive.
- [x] (2026-07-12 20:00Z) Systematic debugging localized the false rejection to under-specified model input. Exact live probes produced nondeterministic `sensitive`, `no-op`, and `0.42-0.72` confidence results from the raw conversational sentence. The corrected sensitivity/calibration contract removed false sensitivity, while deterministic framing as `Explicit communal memory request: <payload>` produced five of five `create`, `sensitivity: none`, `0.90-0.95` results. Two focused tests were observed red before the prompt and framing fixes, then passed with typechecking.
- [x] (2026-07-12 20:21Z) Adversarial and formal review exposed multiline truncation, lossy same-message references, malformed separators, a tautological prompt test, shared-prompt behavior drift, and the lack of a paid memory-model evaluation. Red-green tests now preserve multiline and referential content, reject empty framing, and isolate the calibrated contract to remember requests.
- [x] (2026-07-12 20:21Z) Extended the optional paid evaluation to the configured `gpt-5.4-nano` memory extractor. Three of three harmless-preference trials and three of three synthetic-credential rejection trials passed; the three existing `gpt-5.4-mini` text cases also passed. Output contained only aggregate case metadata.
- [x] (2026-07-12 20:34Z) Focused re-review found that stripping a leading `that` still lost common back-references and that syntactically empty requests still reached the model. Seven focused framing cases were observed red; the parser now preserves bare/qualified `that`, `both`, and counted referents, while `Chief remember that`, `Chief remember that.`, and repeated separators return `ambiguous` without extraction, embedding, or mutation.
- [x] (2026-07-12 20:46Z) Final Standards and Spec re-reviews returned zero findings. Final external re-review returned zero critical/high/medium and one non-blocking low finding for contextless plural references; four additional cases were observed red and then passed after `both`, `that game`, `those teams`, and `the two cities` were short-circuited without a model call.
- [x] (2026-07-12 20:47Z) Passed the fresh pre-publication gate: formatting, ESLint, typecheck, 195 tests, 81.79% branch coverage, build, Actionlint, ShellCheck, Terraform formatting/validation, `git diff --check`, and a hardcoded OpenAI-key scan. All `.agent` work-item changes remain tracked for publication.
- [x] (2026-07-12 20:57Z) PR #13 merged as `a4ddbdb`; the `main` deployment completed, the container became healthy on immutable digest `sha256:4af5800c...`, readiness reported every check true, and migrations `0001_initial` plus `0002_conversation_events` remained applied.
- [x] (2026-07-12 21:30Z) Post-deploy smoke reproduced a second explicit-intent defect with “remember @Chief, no military academies.” Invocation normalized it to `remember Chief, no military academies`; the recognizer returned no intent because it required Chief before the verb, the text model emitted a non-committed promise, and read-only production counts remained zero durable memories.
- [x] (2026-07-12 21:35Z) Milestone 7 red-green implementation added the exact remember form plus imperative correction and forget forms. Four focused tests failed against the deployed matcher, then 38 unit tests, 20 memory-service integration tests, typechecking, and focused ESLint passed after one shared matcher gained the verb-before-address grammar.
- [x] (2026-07-12 21:35Z) Fresh-eyes recent-work review found no additional correctness or complexity issue: mention qualification remains the addressing authority, both address orders converge on one parser/mutation path, and the general text agent is bypassed. Usefulness score: 8/10 - verified the fix at the Discord-normalized/orchestrator boundary rather than only testing the regular expression.
- [x] (2026-07-12 21:43Z) Formal review found possessive and payload-bearing question ambiguity, missing correction/forget mutation coverage, a missing raw Discord boundary proof, duplicated grammar fragments, stale plan wording, and one formatting failure. Seven ambiguity cases were added red-first; the parser now requires a valid delimiter after `Chief` and rejects terminal questions in the imperative form, shared grammar fragments prevent drift, and 40 focused unit plus 20 memory-service integration tests, typechecking, focused ESLint, and the formatting gate pass.
- [x] (2026-07-12 21:45Z) Final Standards and Spec re-reviews returned zero findings. The fresh repository gate passed formatting, ESLint, typechecking, 201 tests, 82.20% branch coverage, build, Actionlint, ShellCheck, Terraform formatting/validation, and `git diff --check`.
- [x] (2026-07-12 21:45Z) The optional paid evaluation passed all three text cases and all three sensitive-rejection trials on both runs. One harmless-preference trial failed on the first run; the immediate fresh rerun passed three of three, so the required passing aggregate was obtained while the observed model nondeterminism remains recorded.
- [x] (2026-07-12 21:57Z) The external adversarial reviewer remained alive for more than eleven minutes without emitting a result and was stopped at the announced ceiling. `adversarial/memory-intent-review.md` records it as unavailable, not approved; the two independent formal reviews and fresh deterministic gate remain the available review evidence.
- [x] (2026-07-12 22:00Z) PR #14 passed Format, Lint, Test, and Build, merged as `d7dabaa`, and deployed successfully in run `29210592019` on immutable digest `sha256:cef645a5...`; the service was active, the container matched that digest, readiness reported every check true, and migrations `0001_initial` plus `0002_conversation_events` remained applied.
- [x] (2026-07-12 22:38Z) Read-only production evidence separated apparent memory from durable memory: Chief had 55 recent conversation events and answered follow-ups coherently, while 76 completed automatic jobs had produced zero durable memories and no post-deploy deterministic commit receipt was present.
- [x] (2026-07-12 22:39Z) Milestone 8 began on `codex/use-gpt-5-6-luna`. The config-default test failed red with GPT-5.4 Mini and `$0.75/$4.50`, then passed with GPT-5.6 Luna and `$1.00/$6.00`; the text agent's existing explicit `low` reasoning setting and all non-text model defaults remain unchanged.
- [x] (2026-07-12 22:40Z) The owner-authorized paid Luna replay passed `polk-no-military`, `chief-self-reference`, and `those-outcomes-follow-up`; the unchanged memory extractor passed all three harmless and all three synthetic-sensitive trials. A content-redacted Responses API probe also returned reasoning, native `web_search_call`, a cited message, and successful usage accounting.
- [ ] Review, publish, deploy, and verify Milestone 8 on `codex/use-gpt-5-6-luna`.
- [ ] Repeat durable-memory and Polk-selection acceptance for deployed Milestone 7.
- [ ] Complete the documented two-human voice acceptance and record final production evidence.

## Surprises & Discoveries

- Observation: The failure is not a crashed memory worker. Production had thirty-six completed jobs, no worker errors, and zero durable memories.
  Evidence: Read-only production SQLite counts gathered during diagnosis.
- Observation: The same `gpt-5.4-mini` model that violated “no military academies” at reasoning `none` selected an allowed team at reasoning `low` when supplied the same context.
  Evidence: An owner-authorized local live probe returned Air Force at `none` and New Mexico at `low`.
- Observation: Current voice has provider-session history only while the Realtime WebSocket remains open; persisted source events contain human transcripts but not Chief’s completed transcript.
  Evidence: `src/app/conversation-orchestrator.ts`, `src/voice/discord-voice-controller.ts`, and `src/agent/openai-voice.ts`.
- Observation: The only retention sweep is a 24-hour in-process timer whose epoch and health timestamp reset on every process start.
  Evidence: `src/runtime.ts` initializes `maintenanceAt` before any sweep and calls `memory.maintain` only from the interval.
- Observation: A raw `event.id < currentHumanId` boundary drops a causally earlier Chief reply when a second human message arrives while the first request is generating.
  Evidence: The red causal-as-of test inserted first human, second human, then first Chief reply and initially returned only the first human.
- Observation: Discord role mentions and bot-user mentions render similarly. The first live remember attempt used a role mention and was later edited to the bot mention; MessageCreate correctly treated the original role mention as ambient and does not process edits.
  Evidence: Read-only Discord metadata showed one original role mention, a later edit, and no original bot-user mention; no IDs or content were emitted.
- Observation: The memory extractor's `confidence` was under-specified and the raw conversational wrapper obscured explicit intent from `gpt-5.4-nano`.
  Evidence: Bounded owner-authorized probes varied between false-sensitive, no-op, and sub-threshold create results until the explicit payload was deterministically framed; five framed calls were stable above the `0.75` floor.
- Observation: Adding the prefix “This list” as same-message context made the complete no-military request unstable again, while meaningful context is necessary for a request such as “remember those teams.”
  Evidence: Three live calls with the irrelevant prefix returned confidence `0.78`, `0.90`, and `0.74`; the final referent-aware framing omits that prefix for a complete request and the paid evaluation then passed three of three trials.
- Observation: The existing paid evaluation exercised only the text agent on `gpt-5.4-mini`; it never called the memory extractor or `gpt-5.4-nano`.
  Evidence: Adversarial review traced `scripts/evaluate-conversation-quality.ts` to `createExecution` and the text model. The script now directly evaluates the memory adapter on both safe and sensitive synthetic cases.
- Observation: Removing a leading `that` before referent detection converted “We are switching to decaf. Chief remember that.” into a punctuation-only request and dropped the fact.
  Evidence: Focused adversarial re-review reproduced the loss. New integration cases retain bare and qualified back-references and short-circuit the same forms when no preceding fact exists.
- Observation: Discord mention normalization correctly preserves a non-leading mention as the literal word `Chief`, but explicit-memory recognition encoded only one address order.
  Evidence: The live message placed the mention after `remember`; `qualifyTextMessage` produced `remember Chief, no military academies`, while `explicitMemoryMatch` required `Chief` before `(remember|correct|forget)`. The regular text path replied and production still contained zero memories.
- Observation: A word boundary alone after the normalized address treats the apostrophe in `Remember Chief's last answer?` as a valid command boundary.
  Evidence: The new ambiguity test failed red with intent `remember`; requiring punctuation, whitespace, or end-of-input after `Chief` rejects possessive and question forms while retaining the reported command.
- Observation: A valid whitespace delimiter is still insufficient to distinguish an imperative from an elliptical question such as “Remember Chief from college?”
  Evidence: Three payload-bearing terminal-question cases failed red; the imperative grammar now rejects a terminal question mark while address-first requests such as “Chief, can you remember ...?” retain their existing semantics.
- Observation: The optional `gpt-5.4-nano` harmless-preference evaluation remains probabilistic despite unchanged framing and prompt code.
  Evidence: The first final run passed two of three harmless trials; an immediate fresh rerun passed three of three. Both runs passed every text and synthetic-sensitive case, and the deterministic 201-test gate remained green.
- Observation: Coherent follow-ups in production prove recent conversation retrieval but do not prove durable memory.
  Evidence: Read-only counts showed 55 seven-day conversation events, 76 completed automatic memory jobs, and zero durable memories; no deterministic explicit commit receipt appeared after the Milestone 7 deployment.
- Observation: GPT-5.6 Luna supports Chief's existing Responses API and native web-search path without an adapter change.
  Evidence: The paid replay passed all three text cases at `low`, and a content-redacted probe returned `reasoning`, `web_search_call`, and a message containing a URL citation.

## Decision Log

- Decision: Use one persisted recent timeline across text and voice, retained seven days and bounded to thirty messages or about six thousand tokens per request.
  Rationale: This matches the communal single-channel product while bounding cost and avoiding misuse of long-term vector memory for transient lists.
  Date/Author: 2026-07-12 / user and Codex.
- Decision: Keep recent conversation and durable memory as separate modules and concepts.
  Rationale: They have different retention, retrieval, mutation, and truthfulness rules. Combining them would make transient dialogue depend on asynchronous extraction.
  Date/Author: 2026-07-12 / user and Codex.
- Decision: Keep `gpt-5.4-mini` and set reasoning effort to `low` before considering a model upgrade.
  Rationale: This was the initial rollout baseline because a direct differential probe showed the existing model succeeded under the improved setting while preserving the cost goal.
  Date/Author: 2026-07-12 / user and Codex.
- Decision: Supersede the initial text baseline with `gpt-5.6-luna` at reasoning effort `low`, priced at `$1.00` input and `$6.00` output per million standard tokens.
  Rationale: The user explicitly chose Luna after reviewing current quality and cost options. OpenAI positions Luna for efficient high-volume workloads, the existing `low` setting is supported, and the Chief-specific replay plus native web-search probe passed. Voice and memory models remain independent and unchanged.
  Date/Author: 2026-07-12 / user and Codex.
- Decision: Use additive migration `0002` and a new `conversation_events` table without historical backfill.
  Rationale: Production data and rollback are explicit compatibility constraints; existing source rows omit Chief replies and are not trustworthy history.
  Date/Author: 2026-07-12 / Codex from confirmed rollout constraints.
- Decision: Test concrete SQLite modules using an in-memory database rather than defining storage interfaces with only one real adapter.
  Rationale: SQLite is local-substitutable and fast. The concrete module interface is the seam; an extra port would be shallow test-only indirection.
  Date/Author: 2026-07-12 / Codex using the codebase-design lens.
- Decision: Preserve the existing `0.75` explicit-memory confidence floor and the `0.85` automatic floor as separate policies.
  Rationale: Explicit user intent warrants a lower bar, not accepting empty or near-zero-confidence model output. Boundary tests and truthful receipts remove ambiguity.
  Date/Author: 2026-07-12 / Codex resolving independent review.
- Decision: Define as-of context by the addressed human turn, not only physical insertion ID.
  Rationale: Human arrival IDs still exclude later humans, while a Chief reply associated with an earlier human remains causally prior even when it is inserted after the current human row.
  Date/Author: 2026-07-12 / Codex from red concurrency evidence.
- Decision: Preserve the `0.75` explicit-memory floor and frame the parsed remember payload instead of clamping model confidence or upgrading the memory model.
  Rationale: The framing produced five stable, non-sensitive results at `0.90-0.95` while keeping the agreed threshold, inexpensive model, original provenance, and sensitive-data rejection intact.
  Date/Author: 2026-07-12 / Codex from production and differential probe evidence.
- Decision: Use a dedicated calibrated extractor prompt only when the explicit intent is `remember`; retain the original prompt for automatic extraction and corrections.
  Rationale: This fixes the reported remember behavior without changing the meaning of confidence or sensitivity for the automatic `0.85` path and correction flow.
  Date/Author: 2026-07-12 / Codex resolving adversarial review.
- Decision: Preserve text before `Chief remember` only when the parsed request contains a same-message referent such as “those” or “them.”
  Rationale: Complete requests remain concise and stable, while requests such as “Oregon and Syracuse — Chief, remember those teams” retain the words needed to resolve the referent.
  Date/Author: 2026-07-12 / Codex resolving formal Spec review and live model evidence.
- Decision: Preserve referential `that` rather than treating it as a removable filler word, and short-circuit unresolved or punctuation-only payloads before extraction.
  Rationale: “Remember that” is meaningful only with preceding same-message context; without that context it cannot truthfully create a durable memory and should return `ambiguous` without spending model budget.
  Date/Author: 2026-07-12 / Codex resolving focused formal and adversarial re-review.
- Decision: Recognize explicit memory verbs on either side of the normalized `Chief` address while keeping Discord's real bot-mention qualification as the authority for whether a message is addressed.
  Rationale: Mention placement is presentation syntax, not memory intent. The orchestrator calls intent detection only for an allowlisted request containing the actual bot mention, so supporting `Chief remember ...` and `remember Chief, ...` does not broaden ambient response gating.
  Date/Author: 2026-07-12 / Codex from post-deploy root-cause evidence.

## Outcomes & Retrospective

Milestones 1 through 7 are merged and deployed. Shared recent context, constraint preservation, model calibration, safe/sensitive evaluation, and both address orders for explicit memory are locally proven. Live recent-context behavior is working, but durable-memory acceptance still requires a real explicit command and production count increase. Milestone 8's Luna configuration and paid compatibility evidence are complete locally; review, publication, deployment, repeated durable-memory/Polk smoke, and the documented voice gate remain before final closeout.

## Context and Orientation

The repository is a Node 24, TypeScript, pnpm application. `src/discord/gateway.ts` receives Discord events, `src/discord/invocation-policy.ts` qualifies and normalizes allowed text, and `src/discord/text-controller.ts` delegates one normalized turn to `ConversationOrchestrator`. `src/app/conversation-orchestrator.ts` now owns synchronous conversation recording, the paid FIFO, recent-context selection, durable recall or explicit mutation, provider calls, and Chief reply persistence. `src/agent/openai-chief-agent.ts` receives recent conversation and communal memory as separate labeled inputs and runs the configured text model at reasoning `low`; Milestone 8 changes its default to `gpt-5.6-luna`. `src/agent/openai-voice.ts` seeds typed persisted history into each new Realtime session and exposes the same durable-memory receipts through narrow tools.

`src/memory/database.ts` now runs immutable migrations `0001_initial` and `0002_conversation_events`. `src/conversation/conversation-store.ts` owns the seven-day bounded recent timeline. `src/memory/memory-store.ts` persists raw sources, restart-safe jobs, durable memories, FTS5 rows, and sqlite-vec embeddings. `src/memory/memory-service.ts` is the single public durable-memory boundary: it owns automatic work, explicit remember/correct/forget sequencing, confidence floors, sensitivity rejection, embeddings, atomic mutations, and truthful receipts. The former `memory-worker.ts` and `memory-context.ts` modules no longer exist.

Milestone 6 is deployed: `MemoryService` deterministically converts a syntactically valid remember command into a concise extraction payload while preserving multiline content and same-message referents, and the OpenAI adapter isolates calibrated remember behavior from automatic extraction and corrections. Active Milestone 7 changes only the shared explicit-intent matcher and its tests so the existing parser and truthful receipt path also receive imperative forms in which the normalized `Chief` address follows the memory verb.

In this plan, a conversation event is one normalized human or Chief message stored for short-term dialogue. A durable memory is a long-lived canonical fact stored in the existing `memories` table. An as-of context contains only conversation events with IDs earlier than the current human request, preventing later concurrently received messages from leaking into an earlier model call. Approximate tokens are a deterministic conservative character-based estimate used only to bound recent history.

## Plan of Work

### Milestone 1: Persist and bound recent conversation

First make the database capable of representing the product before changing any provider call. In `src/memory/database.ts`, replace the single special-case migration flow with an ordered immutable migration list. Keep the migrations bookkeeping table lazy and outside the migration bodies, preserve `0001_initial`, checksum `chief-0001-v3`, and its effective SQL byte-for-byte, and reject checksum drift. Add `0002_conversation_events` with its own stable checksum. The new table stores a unique platform event key, request correlation key, role (`human` or `chief`), nullable stable speaker ID, nullable display name, medium (`text` or `voice`), normalized content, occurrence time, and retention deadline. Add two explicit indexes: one on `retention_deadline` for expiry and one on descending event ID for newest-before-ID retrieval. Do not copy from `source_events`.

Create `src/conversation/conversation-store.ts` with a concrete `ConversationStore` class over the existing `better-sqlite3` connection. Its interface records a normalized event idempotently, returns recent events causally before an optional human-event boundary, limits results to thirty messages and approximately six thousand tokens, reverses database-descending rows into chronological order, and deletes expired rows during maintenance. A Chief reply associated with an earlier human turn remains eligible even when inserted after the boundary; later human turns and their replies remain excluded. Selection must always retain the newest eligible event that fits; a single oversize event is truncated or omitted according to one documented deterministic rule rather than exceeding the model bound. The module hides SQL, time-window policy, role representation, ordering, and token estimation.

Add `test/integration/conversation-store.test.ts` and extend `test/integration/database.test.ts`. Start from a database with only `0001_initial`, run migration twice, and prove `0002` is applied once without changing existing source, memory, or usage rows. Prove restart persistence, idempotent platform keys, no backfill, seven-day expiry, chronological ordering, as-of exclusion, thirty-message limiting, and approximate-token limiting through the public `ConversationStore` interface.

Run `pnpm vitest run --project integration test/integration/database.test.ts test/integration/conversation-store.test.ts`, then `pnpm typecheck`.

### Milestone 2: Put text sequencing behind the orchestrator

Start with failing replay tests. Add a compact checked-in fixture under `test/fixtures/conversation-quality.json` containing the relevant non-sensitive transcript turns: the presidential debate, Teddy team list, no-military constraint, “those outcomes,” “pick one from the list,” mid-sentence self-reference, and the Polk follow-up. Do not copy protected-class slurs. Add tests that fail against the current implementation because no recent context is present and mid-sentence mentions are deleted.

In `src/discord/invocation-policy.ts`, normalize every matching mention. Remove a leading mention plus adjacent address punctuation. Replace mentions elsewhere with `Chief`. Preserve a bare mention as `greeting`, and make repeated mentions deterministic. Return the normalized full human content needed for persistence as well as the request prompt. Extend `DiscordTextMessage` in `src/discord/text-controller.ts` and the gateway mapping in `src/discord/gateway.ts` with the member display name, falling back to the Discord user’s display name or username.

Deepen `ConversationOrchestrator.handleText` so one normalized turn contains qualification kind, prompt when applicable, platform source ID, speaker ID, display name, and occurrence time. Recording the human conversation event and raw memory source is the first synchronous operation, with no preceding `await`, before budget reservation or entry into the paid FIFO. This gives every message a stable event ID in Discord arrival order and lets ambient observations return immediately without waiting behind paid work. A concurrent interleave test makes the no-await-before-record rule an invariant. A database failure at this point returns the agreed “lost the thread” result and never calls the agent. For a paid request, enqueue the event ID, snapshot recent context strictly before it when the request reaches the head, then perform explicit memory or durable recall, generation, and logical Chief reply persistence before releasing the next queued turn. A model failure records no Chief event. Budget-paused replies and deterministic greetings are real Chief events, but greetings stay on the existing local fast path rather than waiting for paid work.

Remove direct `SqliteMemoryStore` knowledge and the separate `observe` callback from `DiscordTextController` and `DiscordGateway`. They should qualify/map input, call the orchestrator once, and deliver any returned logical reply. Preserve chunking, citations, suffix enforcement, allowlisting, and mention-only response gating.

Update `test/unit/invocation-policy.test.ts`, `test/unit/discord-text-controller.test.ts`, and `test/unit/conversation-orchestrator.test.ts` to use the real in-memory `ConversationStore` where state matters. Test leading/middle/trailing/repeated/bare mentions, self-reference, ambient recording without reply, cross-user recent context, Chief reply inclusion, as-of concurrency, restart reconstruction, model failure, and database failure. The replay must show that “those outcomes” and the Polk follow-up receive the required prior list and constraints.

Run the three focused unit test files, then the new integration test and `pnpm typecheck`.

### Milestone 3: Make explicit durable memory synchronous and truthful

Create `src/memory/memory-service.ts` as the deep durable-memory module. It receives the existing `SqliteMemoryStore`, embedder, extractor, `UsageBudget`, and clock. It exposes bounded recall for a prompt, automatic source observation, one restart-safe automatic work method, and one explicit mutation operation returning a discriminated receipt such as `created`, `superseded`, `forgotten`, `conflict`, `rejected-sensitive`, `ambiguous`, `budget-paused`, or `failed`. The implementation owns candidate lookup, extraction, explicit-versus-automatic thresholds, sensitivity rejection, embedding, transaction application, supersession, conflict recording, forgetting, leases/retries, usage reservation/reconciliation, and completed extraction status. Do not expose proposal arrays or database sequencing to the orchestrator.

Move the useful behavior and result types from `MemoryWorker` and `MemoryContext` behind `MemoryService`; move `EmbeddingResult`, `ExtractionResult`, and proposal types to the service-owned module used by `src/memory/openai-memory.ts`; update runtime, orchestrator, extractor, and every importing test; then delete `src/memory/memory-worker.ts` and `src/memory/memory-context.ts`. This is a replacement, not a compatibility layer. Retain automatic confidence `0.85`, the distinct explicit floor `0.75`, restart-safe leases, retries, and next-month budget deferral. Extend `SqliteMemoryStore` with `applyPreparedMutationBatch(sourceId, mutations, completedAt)`, where every proposal already has its embedding or resolved forget targets. That single synchronous transaction applies source status, memory rows, FTS/vector rows, supersessions, conflicts, and forgets in proposal order and returns the committed receipt used for acknowledgement; any failure rolls back the whole batch. Extraction and embedding occur before this transaction, as they already do today. Do not add a generic repository interface or a test-only adapter.

Add deterministic explicit-intent recognition after Discord mention normalization. Recognize a `Chief … remember`, `Chief … correction`, or `Chief … forget` phrase even when the address occurs mid-sentence. Execute explicit mutations inside the paid FIFO. Return deterministic truthful replies: confirm only committed outcomes, state when sensitive or failed content was not saved, and ask for clarification on ambiguity or unresolved conflict. Every reply still passes through the existing suffix enforcer.

Replace the old worker/context-focused tests with interface-level `MemoryService` tests for explicit proposals at confidence `0.74` and `0.75`, sensitive rejection, correction supersession, unresolved conflict, lexical forgetting, no-op ambiguity, budget pause, retry/lease recovery, whole-batch rollback, and preservation of the automatic `0.85` threshold. Keep lower-level `SqliteMemoryStore` integration tests only for SQL/index/backup behavior that is not observable through `MemoryService`. Add the exact “This list @Chief remember no military academy” normalized case to the transcript replay and prove a memory row exists before the acknowledgement is returned.

Run `pnpm vitest run --project integration test/integration/memory-service-automatic.test.ts test/integration/memory-service.test.ts test/integration/memory-store.test.ts` plus focused orchestrator/controller tests, then `pnpm typecheck`.

### Milestone 4: Supply context to OpenAI text and voice with the agreed personality

Extend normalized types in `src/agent/chief-agent.ts` so text requests carry recent chronological conversation separately from durable communal memories. Extend `VoiceSessionRequest` with the bounded recent context used only when a new Realtime session opens. Keep provider-specific messages and SDK types inside adapters.

In `src/agent/openai-chief-agent.ts`, serialize `recentConversation`, `communalMemory`, and `userRequest` as clearly labeled untrusted data. Update the Chief instructions to preserve user constraints, resolve references from recent dialogue, recognize himself, maintain a defensible position instead of reflexively agreeing, use concise dry clapbacks, mirror ordinary profanity sparingly, avoid protected-class slurs/threats/harassment, and decline briefly without moralizing. Change text reasoning effort from `none` to `low`. Do not change the default text model.

In `src/agent/openai-voice.ts`, keep behavioral policy in the Realtime agent instructions and seed bounded communal dialogue as typed Realtime history after the `@openai/agents/realtime` session reports `session.created` and before accepting audio. `RealtimeSession.updateHistory(...)` calls the transport’s `resetHistory`, so map human events to completed `user` message items and Chief events to completed `assistant` message items with deterministic synthetic item IDs and text-only content. Wait for matching history acknowledgements, or fail closed on a bounded timeout, before emitting Chief's normalized `ready` event. Do not concatenate raw conversation into system instructions. State in the fixed instructions that seeded history is past untrusted context, not a new request or authority to alter Chief’s rules. Add narrowly described Realtime tools backed by `MemoryService` for durable recall and explicit remember/correct/forget. Tool results must say whether a database mutation committed; voice instructions prohibit claiming success without a successful receipt. Existing research-tool budgets, suffix handling, and read-only web restrictions remain unchanged.

Change `DiscordVoiceController` and `ConversationOrchestrator.handleVoice` so the normalized turn includes speaker ID, display name, and any group transcript. For solo turns, `NormalizedRealtimeSession` correlates the separate `input-transcript` and assistant-completion events and emits one normalized completion containing both transcripts only after both arrive; a bounded missing-transcript timeout fails closed instead of writing reordered or partial history. Persist the human transcript followed by the Chief transcript in one synchronous conversation-store batch with seven-day retention. Seed only a newly created Realtime session; do not resend the timeline on every audio turn. Preserve solo/group qualification, input transcription, immediate interruption, FIFO behavior, idle close, and source posting.

Add adapter tests proving exact structured text input, reasoning `low`, required instruction clauses, `session.created` readiness, voice bootstrap mapping into `RealtimeItem[]`, history acknowledgement before normalized ready, memory-tool receipts, and no prompt content in logs. Test the installed SDK contract through an injected fake transport whose `resetHistory` captures old and new history; do not assert only against a helper that production might bypass. Extend voice tests to prove out-of-order input/assistant event coordination, missing-input timeout, human and Chief transcript persistence, and that an already-open session is not reseeded. Include hostile prior content and a hostile display name, and prove provider input is structurally labeled, display labels are sanitized, Discord IDs are absent, and fixed policy is unchanged. Use fakes for providers and no paid calls.

Run focused OpenAI, orchestrator, voice-controller, and voice-session tests, then `pnpm test:unit`, `pnpm test:integration`, and `pnpm typecheck`.

### Milestone 5: Make quality measurable and operationally safe

Add a deterministic replay runner or test helper that reads `test/fixtures/conversation-quality.json` and scores structural outcomes: necessary prior turns are present, selected teams come from the supplied list, military academies are excluded, references to Chief survive mention normalization, explicit memory acknowledgement follows a committed receipt, and later concurrent messages do not leak backward. Mandatory tests must use fake agents and no network.

Add an optional `scripts/evaluate-conversation-quality.ts` and package script that require `OPENAI_API_KEY`, replay a small representative subset against the configured text model, print inputs only when an explicit local debug flag is set, and otherwise report a pass/fail score without secrets. Its primary acceptance cases are the no-military Polk selection, “those outcomes,” and self-reference. Document that this command is paid and is not run by GitHub Actions.

Add redacted structured logs in the orchestrator or runtime for context message count, approximate context tokens, durable memory count, and explicit mutation outcome. Extend the database health check so it verifies the latest migration and a harmless `conversation_events` query in addition to current read/write and sqlite-vec checks. Run maintenance synchronously once after migration during startup, derive health freshness only from a successful sweep, and retain the 24-hour timer for subsequent sweeps. Both paths expire recent conversation rows without changing durable memory, so restarts cannot starve seven-day retention.

Update `docs/operations.md` with timeline counts/expiry and explicit-memory outcome inspection queries that reveal no content. Update `docs/manual-acceptance.md` with cross-user follow-up, mid-sentence mention, explicit remember/correct/forget, restart persistence, text-to-voice and voice-to-text continuity, dry pushback, and real-server post-deploy smoke checks. Update `README.md` only where current memory/context behavior would otherwise be inaccurate. Record `CONTEXT.md` and ADRs as intentionally skipped in the work item rather than adding broad documents.

Run the optional live evaluation once with the owner-provided local `.env` key and record only aggregate outcomes in this plan. Then run the full local gate from the worktree:

    pnpm verify
    actionlint
    shellcheck scripts/*.sh
    terraform fmt -check -recursive infra
    terraform -chdir=infra/app validate -no-color
    git diff --check

Expect all commands to exit zero. Run the migration/backup/restore and deploy rollback integration tests to prove the new table survives the existing transaction. No local validation may print or commit `.env` values.

### Milestone 6: Calibrate explicit remember extraction without weakening other memory flows

Treat the production false-sensitive reply as a follow-up repair on `codex/fix-memory-sensitivity`. In `src/memory/memory-service.ts`, parse only the explicit remember payload before extraction, preserve embedded newlines and referential words such as `that`, and strip only address separators. Return `ambiguous` before extraction when no durable payload or resolvable back-reference remains. Prefix a valid model input with `Explicit communal memory request:`. Preserve text before the Chief trigger only when the payload contains a same-message referent such as “those teams”; a complete payload such as “no military academy” must not receive the irrelevant “This list” prefix. The source event, provenance, and stored content remain the original Discord message.

In `src/memory/openai-memory.ts`, replace the ambiguous boolean with the explicit intent or `null`. Select a dedicated calibrated prompt only for `remember`; automatic extraction and correction continue using the original prompt verbatim. The remember prompt defines sensitivity as private personal data rather than topic vocabulary, defines confidence as paraphrase clarity, requires clear safe memories to use at least `0.90`, and requires a clear sensitive request to emit a sensitive proposal so Chief can truthfully decline. Keep `gpt-5.4-nano`, reasoning `none`, the `0.75` and `0.85` service floors, and all commit-before-acknowledgement sequencing.

Extend `test/integration/memory-service.test.ts` with the production sentence, a same-message referent, a multiline list, separator punctuation, and an empty “remember that” case. Replace the old instruction-dependent fake in `test/unit/openai-memory.test.ts` with a wiring contract that proves only remember selects the calibrated agent. Extend `scripts/evaluate-conversation-quality.ts` rather than adding a second harness: retain the text cases and add three trials each for a harmless group preference and a synthetic credential on the configured memory model. The optional command remains outside CI and emits no prompts or secrets.

Run the focused tests and typecheck, then the optional paid evaluation from the owner-controlled `.env`. Acceptance is three of three safe creations at `sensitivity: none` and confidence at least `0.90`, three of three sensitive classifications for the synthetic credential, and all text cases passing. Then run formal and adversarial focused re-review before the full repository gate and production rollout.

### Milestone 7: Make explicit intent independent of mention order

Treat the post-deploy reply “I’ll use that rule in this chat” as a false acknowledgement because production still had zero durable memories. Add the exact normalized message `remember Chief, no military academies` to `test/unit/memory-intent.test.ts` and to the existing `ConversationOrchestrator` explicit-memory test. The vertical test must prove that the extractor receives only `Explicit communal memory request: no military academies`, SQLite commits the proposal before the deterministic receipt, no automatic memory job is created, and the general text agent is never called. Observe both tests fail against the deployed matcher before editing production code.

In `src/memory/memory-service.ts`, deepen `explicitMemoryMatch` rather than adding a Discord-specific special case. Preserve the current address-first grammar and add the imperative grammar in which `remember`, `correct`, or `forget` immediately precedes the normalized `Chief` address and optional punctuation. Both grammars must return the same intent and payload capture so remember framing, lexical forget targeting, correction extraction, confidence floors, atomic commits, and receipts remain one path. Do not weaken allowlisting or mention-only response policy: `ConversationOrchestrator` still invokes this matcher only for a request that `qualifyTextMessage` proved contains the actual bot-user mention.

Run focused intent, invocation-policy, orchestrator, and memory-service tests plus typechecking. Review the diff formally and adversarially for command/question ambiguity, correction/forget regressions, payload loss, and false acknowledgement. Run the full repository and optional paid gates, publish with the explicit branch ref `codex/fix-imperative-memory-intent`, merge only after Format/Lint/Test/Build pass, watch `main` deploy, and repeat the exact Discord command. Acceptance requires the deterministic committed receipt and a durable-memory count increase from zero without reading memory content; the subsequent Polk selection must come from the supplied list and exclude Navy and Air Force.

### Milestone 8: Upgrade text generation to GPT-5.6 Luna

Change only the configurable text-model default from `gpt-5.4-mini` to `gpt-5.6-luna`. Preserve the existing explicit reasoning effort `low`, Responses API, Agents SDK orchestration, native web search, guarded fetch tool, recent/durable context separation, usage ceiling, and every voice, transcription, embedding, and memory-model default. Update the standard text prices from `$0.75/$4.50` to `$1.00/$6.00` per million input/output tokens so reservation and reconciliation remain conservative and accurate.

Drive the change from `test/unit/config.test.ts`: first require the Luna model and prices and observe the old defaults fail, then update `src/config/config.ts` and the optional evaluation default. Run the focused config and text-agent tests plus typechecking. Use the owner-controlled API key to run the three aggregate text replays on Luna at `low` and a content-redacted native web-search compatibility probe. Record only model, aggregate pass/fail, latency, token usage, output item types, and citation presence.

Review the narrow diff, run the complete deterministic gate, publish with `git push origin HEAD:refs/heads/codex/use-gpt-5-6-luna`, and merge only after Format, Lint, Test, and Build pass. Watch the `main` deploy, then verify non-content health and runtime configuration from inside the container. Acceptance requires the container to report `gpt-5.6-luna`, text prices `1` and `6`, readiness true, and one live Discord response with the exact suffix.

## Concrete Steps

All commands run from `/Users/kellen/development/github/kellen-miller/chief/.worktrees/conversation-quality` unless a command says otherwise.

During each implementation slice, use the red-green loop:

    pnpm vitest run --project unit <focused-test-file>
    pnpm vitest run --project integration <focused-test-file>
    pnpm typecheck

The first test invocation must demonstrate the relevant transcript failure before implementation. After the smallest passing change, rerun the same command and update `Progress` and `Surprises & Discoveries` with concise evidence.

Before review, run:

    pnpm verify
    actionlint
    shellcheck scripts/*.sh
    terraform fmt -check -recursive infra
    terraform -chdir=infra/app validate -no-color
    git diff --check
    git status --short

Run the optional live evaluation only when `.env` contains the current owner-controlled API key:

    node --env-file=../../.env --import tsx scripts/evaluate-conversation-quality.ts

The command must not be added to required CI. Record only case names, pass/fail outcomes, model name, reasoning level, latency, and token usage; never record prompts or the key.

When implementation and review are complete, commit with Conventional Commits, push explicitly, and create a PR:

    git push origin HEAD:refs/heads/codex/use-gpt-5-6-luna

Watch Format, Lint, Test, Build, and any triggered Terraform Plan job. Merge only when required checks pass and review findings are resolved. Then watch the `main` deploy job through completion and run the non-content VM health/database checks plus the manual Discord scenarios in `docs/manual-acceptance.md` before declaring production acceptance.

## Validation and Acceptance

The feature is accepted locally only when the transcript replay passes through the same `ConversationOrchestrator` interface used by Discord and demonstrates all agreed behaviors without a paid call. Passing tests must show that a human message is persisted in arrival order before budget reservation or queueing, ambient observations do not wait behind paid work, context excludes events at or after the current event boundary, a Chief reply is persisted before the next FIFO item begins, greetings stay local, and provider failure leaves no false Chief reply.

Mention acceptance requires exact cases for a leading mention, middle mention, trailing mention, multiple mentions, and a bare mention. Middle and trailing cases must preserve the literal word `Chief` in the normalized prompt. Unmentioned allowed-channel text remains ambient observation with no reply. Every disallowed surface remains ignored and unpersisted.

Recent-context acceptance requires restart-safe text and voice events, display-name attribution, chronological order, seven-day expiry, at most thirty messages, and the approximate six-thousand-token bound. The Teddy/Polk follow-up must receive the prior list and no-military constraint. Text-to-voice and voice-to-text tests must include both human and Chief turns. No request may receive an event that arrived later than its as-of boundary.

Durable-memory acceptance requires a non-sensitive explicit proposal at `0.75` to commit and acknowledge, one at `0.74` to be truthfully rejected, a sensitive proposal to reject without a row, a correction to supersede, ambiguity to retain conflict and request clarification, forgetting to remove indexes, and automatic extraction below `0.85` to remain rejected. Remember framing must retain multiline payloads and same-message referents without adding irrelevant prefix text to complete requests. The optional real-model evaluation must pass three harmless-preference and three synthetic-sensitive trials on `gpt-5.4-nano`. A multi-proposal transaction failure must leave no partial memory or index rows. A database, budget, extraction, or embedding failure must never produce “I’ll remember.” There is still no list/dump command.

Provider acceptance requires `gpt-5.6-luna` as the text default at reasoning `low`, with standard prices `$1.00/$6.00` per million input/output tokens, recent conversation and durable memory as separate labeled inputs, personality instructions matching `decision.md`, and no content-bearing logs. Voice must receive text-only typed history through the Realtime transport exactly once per new session, must not embed raw dialogue in fixed instructions, and must not claim a memory mutation succeeded unless its tool receipt committed.

Operational acceptance requires the additive migration to preserve a fixture representing the deployed `0001_initial` schema, database backup and restore to retain the new table, and failed deployment rollback tests to pass. The optional live evaluation and post-deploy Discord smoke are realistic evidence; deterministic CI is the mandatory regression gate. GitHub Actions remains free of paid API calls and repository secrets on pull requests.

## Idempotence and Recovery

Migration `0002_conversation_events` runs once in a transaction and has a stable checksum. Never edit `0001_initial` or an applied migration. Running migration, maintenance, event recording with the same platform key, and all validation commands repeatedly is safe. Timeline cleanup affects only expired `conversation_events`; it never deletes durable memories or raw memory sources.

The deploy script already stops Chief, creates and verifies a pre-migration backup, runs the candidate migration, and restores the backup plus prior image if readiness fails. Preserve that flow. If migration or startup fails locally, restore the scratch database from the test backup and rerun; never repair production state manually. If a successful new deployment later needs reversal, restore the matching verified pre-deploy backup and prior image as one operation; never start an older image alone against a newer schema.

Temporary transcript replay and live-evaluation output must remain outside version control unless it is a sanitized aggregate. Remove debug logs, probes, and abandoned test scaffolding before review. Preserve the primary checkout’s ignored/local Terraform files; all work belongs to this worktree.

## Artifacts and Notes

The work item is `.agent/work/improve-conversation-quality/`. Planning and implementation reviews belong under its `adversarial/` directory. The explicit-memory follow-up review and its initial blocking verdict are recorded in `adversarial/memory-fix-review.md`; a focused re-review must append the final disposition before publication. The source transcript remains outside the repository at `/Users/kellen/.codex/attachments/2fdc5af3-8510-47e2-b4b9-0d0ec88ccf7c/pasted-text.txt`; the repository fixture should copy only the minimum sanitized turns needed for deterministic tests.

The baseline at `999b190` passed 137 tests across 23 files. Production diagnostic evidence is summarized in `decision.md`; no production message content, memory content, secrets, or Discord IDs should be copied into the work item or logs.

## Interfaces and Dependencies

In `src/conversation/conversation-store.ts`, define the concrete module interface around types similar to:

    type ConversationRole = 'human' | 'chief';
    type ConversationMedium = 'text' | 'voice';

    interface ConversationEventInput {
      platformEventId: string;
      requestId: string | null;
      role: ConversationRole;
      speakerId: string | null;
      speakerName: string | null;
      medium: ConversationMedium;
      content: string;
      occurredAt: number;
      retentionDeadline: number;
    }

    class ConversationStore {
      record(event: ConversationEventInput): number;
      recent(input: {
        beforeEventId?: number;
        maxMessages?: number;
        maxApproxTokens?: number;
        now: number;
      }): { events: readonly ConversationEvent[]; approximateTokens: number };
      maintain(now: number): { deletedEvents: number };
    }

This module hides SQL, idempotency, expiry, ordering, and bounding. Keep defaults of thirty messages, six thousand approximate tokens, and seven-day retention inside its implementation rather than spreading them across Discord and OpenAI callers.

In `src/memory/memory-service.ts`, define a concrete module with a small result-oriented interface:

    class MemoryService {
      observeAutomatic(source: SourceObservation): number;
      recall(prompt: string): Promise<MemoryRecall>;
      applyExplicit(source: SourceObservation): Promise<MemoryMutationReceipt>;
      runAutomaticOnce(now: number): Promise<AutomaticMemoryResult>;
    }

`MemoryMutationReceipt` is a discriminated union containing only committed user-relevant outcomes and usage, not raw model proposals. The module hides threshold selection, candidate lookup, extraction, embedding, SQL mutation ordering, job leasing/retry, and budget reconciliation. `AutomaticMemoryResult` reports only operational states needed by the runtime loop. Keep `SqliteMemoryStore` as its internal persistence implementation and as the direct owner of backup primitives. Remove `MemoryContextRetriever`, `MemoryWorker`, and their pass-through runtime wiring once this module owns the behavior.

In `src/app/conversation-orchestrator.ts`, deepen the existing public interface rather than adding another coordinator:

    handleText(turn: NormalizedTextTurn): Promise<ConversationResult | null>;
    handleVoice(turn: NormalizedVoiceTurn, sink: VoiceSink): Promise<VoiceConversationResult>;

`NormalizedTextTurn` includes qualification, normalized content, prompt when present, platform source ID, speaker ID, display name, and occurrence time. `NormalizedVoiceTurn` includes audio, request ID, speaker identity, and an optional pre-gate transcript. The orchestrator hides persistence order, as-of context, durable recall/mutation, paid FIFO, provider timeout, Chief reply persistence, and error mapping.

In `src/agent/chief-agent.ts`, add provider-neutral context types. `ChiefTextRequest` carries `recentConversation` and `memories` separately. `VoiceSessionRequest` carries bounded `recentConversation`. `OpenAiChiefAgent` and the Realtime adapter translate those types into provider inputs. No Discord types, SQLite rows, OpenAI SDK events, or raw memory proposals cross these seams.

Do not add another database, vector extension, agent framework, provider-neutral Discord wrapper, feature flag, dual context path, or backwards-compatibility alias. Production data compatibility is handled by the additive migration and backup/restore path, not by preserving the stateless behavior.

Plan revision note (2026-07-12T17:24:47Z): Created the initial self-contained ExecPlan from the completed grill, production diagnosis, repository code paths, and codebase-design lens.

Plan revision note (2026-07-12T17:27:00Z): Improvement pass 1 moved human persistence ahead of budget reservation and FIFO entry, preserved the local greeting path, and made event IDs represent Discord arrival order rather than paid-queue order. Usefulness score: 9/10 - corrected the as-of and ambient-message sequencing needed to make concurrent replay evidence trustworthy.

Plan revision note (2026-07-12T17:29:00Z): Improvement pass 2 replaced the proposed memory wrapper with one deep `MemoryService`, retired the shallow worker/context modules, and kept remote extraction and embedding outside SQLite transactions. Usefulness score: 9/10 - concentrated durable-memory policy behind one interface and identified the need for atomic application across prepared proposals.

Plan revision note (2026-07-12T17:31:00Z): Improvement pass 3 verified the installed Realtime SDK’s `updateHistory`/`resetHistory` path, moved historical dialogue out of fixed instructions into typed text-only history, and required a transport-level contract test. Usefulness score: 9/10 - removed a prompt-injection-prone voice bootstrap and grounded the plan in the shipped SDK interface.

Plan revision note (2026-07-12T17:42:00Z): Independent review resolved startup-retention starvation, split retrieval/expiry indexes, specified atomic prepared memory batches and the `0.75` explicit boundary, enumerated type-import rewiring, corrected the Realtime import path and transcript lifecycle, added readiness acknowledgement and hostile-history tests, and made rollback pairing explicit. Usefulness score: 10/10 - converted every verified high-severity ambiguity into a concrete invariant and acceptance test.

Plan revision note (2026-07-12T20:21:22Z): Added Milestone 6 after production exposed a false-sensitive explicit remember reply. The revision incorporates formal and adversarial findings across the plan, narrows framing to complete payloads plus only meaningful same-message context, isolates the calibrated prompt from automatic/correction flows, and adds repeatable real-model safe/sensitive evaluation before rollout.

Plan revision note (2026-07-12T20:34:00Z): Rewrote Purpose and Context for the merged architecture, documented the focused review's back-reference and empty-request findings, and changed Milestone 6 to preserve referential `that` while short-circuiting unresolved or punctuation-only requests before any model call.

Plan revision note (2026-07-12T20:46:30Z): Recorded clean final Standards/Spec re-reviews, the external review's sole non-blocking contextless-group-reference finding, and the red-green repair that now short-circuits those unresolved forms before extraction.

Plan revision note (2026-07-12T20:47:54Z): Recorded the fresh 195-test pre-publication gate and updated Outcomes to distinguish locally verified completion from the remaining PR, deployment, text smoke, and voice acceptance work.

Plan revision note (2026-07-12T21:30:45Z): Recorded PR #13 and deployment evidence, replaced the completed Milestone 6 rollout gap with Milestone 7, and grounded the new work in the live `remember @Chief` address-order failure, zero-memory database evidence, and the existing mention-only qualification boundary.

Plan revision note (2026-07-12T21:35:00Z): Recorded Milestone 7's four-test red state, focused green evidence, and fresh-eyes review result while keeping the work item active until review, rollout, text acceptance, and voice acceptance are complete.

Plan revision note (2026-07-12T21:41:00Z): Resolved formal review findings with red-green command/question ambiguity tests, imperative correction and forget mutation coverage, raw mention-boundary coverage, shared grammar fragments, and consistent remaining-work statements.

Plan revision note (2026-07-12T21:43:00Z): Extended the ambiguity repair to payload-bearing elliptical questions, recorded the second red-green cycle, and cleared the formatting gate reported by formal re-review.

Plan revision note (2026-07-12T21:45:00Z): Recorded zero-finding final formal re-reviews, the fresh 201-test and infrastructure gate, and both the initially mixed and subsequently passing optional paid-model evaluation results.

Plan revision note (2026-07-12T21:57:00Z): Recorded the bounded external adversarial review as unavailable after it emitted no result, preserving the clean two-review and deterministic-gate evidence without claiming third-party approval.

Plan revision note (2026-07-12T22:39:24Z): Recorded the merged Milestone 7 rollout, distinguished live recent conversation from still-empty durable memory, and added the user-selected GPT-5.6 Luna text-only upgrade with red-green defaults, current pricing, paid replay, native web-search evidence, and a dedicated rollout branch.
