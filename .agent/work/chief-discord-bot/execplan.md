# Build and operate Chief

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept current while work proceeds.

This plan is governed by .agent/PLANS.md. The provenance and product contract live in .agent/work/chief-discord-bot/decision.md. A future implementer must read both files before editing code.

## Purpose / Big Picture

After this work, members of one private Discord server can mention Chief in the main text channel, use four guild-scoped slash commands, or invite him into the main voice channel. Chief will answer as a concise American chief of staff, research current information with links, remember useful group context, and converse through OpenAI Realtime while following deterministic invocation, cost, retention, and “Mr. President” rules.

The repository is currently greenfield. The implementation should create a small number of deep modules that hide Discord event details, OpenAI sequencing, voice buffering, memory retrieval, and deployment recovery. Callers should not have to coordinate budgets, retrieval, suffixing, retention, or rollback themselves. The observable outcome is a fully tested production container and repository-owned GCP deployment pipeline that is ready for owner-supplied bootstrap values; this work does not provision live GCP or Discord resources.

## Progress

- [x] (2026-07-11T14:03:12Z) Completed the user grill and recorded confirmed decisions in decision.md.
- [x] (2026-07-11T14:03:12Z) Created the repository planning contract at .agent/PLANS.md and initialized meta.json.
- [x] (2026-07-11T14:03:12Z) Inspected current Weave Labs Node, Terraform, WIF, image-publishing, and deployment conventions.
- [x] (2026-07-11T14:03:12Z) Verified current package availability for Node 24, discord.js, OpenAI Agents SDK, better-sqlite3, and sqlite-vec.
- [x] (2026-07-11T14:40:00Z) Created the TypeScript foundation, deterministic pnpm native-build allowlist, local developer commands, and four required PR CI gates; format, lint, typecheck, unit coverage, and production TypeScript build pass locally.
- [x] (2026-07-11T15:47:49Z) Proved the pinned Discord DAVE receive fix and native dependency boundary locally, implemented the server-side Realtime audio contract, and documented the mandatory owner-run live DAVE gate.
- [x] (2026-07-11T15:47:49Z) Implemented deterministic text invocation, guild commands, reply shaping, paid FIFO queueing, persistent UTC-month budgets, and honest failure behavior with tests.
- [x] (2026-07-11T15:47:49Z) Implemented SQLite migrations, retention, hybrid FTS5/sqlite-vec retrieval, restart-safe extraction, sensitivity filtering, correction/forget candidate context, exact-duplicate consolidation, usage persistence, backup, and restore verification with tests.
- [x] (2026-07-11T15:47:49Z) Implemented the OpenAI text and memory adapters, hosted search, guarded URL fetch, strict structured extraction, bounded voice research, cost reconciliation, source rendering, and provider contract tests without paid calls.
- [x] (2026-07-11T15:47:49Z) Implemented Discord DAVE receive/playback ownership, 48 kHz to 24 kHz PCM conversion, one-human/group gating, interruption, transcripts, persisted suffix repair, citations, Realtime and connection inactivity, and native-codec smoke coverage.
- [x] (2026-07-11T15:47:49Z) Built the read-only production container, loopback health, systemd runtime/timers, GCP Terraform, exact-subject WIF CI, immutable-digest deployment, backup, monitoring, rollback harness, and owner documentation.
- [x] (2026-07-11T18:39:59Z) Ran the full validation matrix, iterative adversarial reviews, linux/amd64 container checks, and authorized live OpenAI text/search/Realtime probes; documented the remaining owner bootstrap, Discord DAVE, transcription, and GCP acceptance gates.

## Surprises & Discoveries

- Observation: The repository began with only .gitignore, so there is no compatibility surface or existing module convention to preserve.
  Evidence: git ls-files before planning listed only .gitignore.

- Observation: Current better-sqlite3 supports Node 24 and sqlite-vec is still version 0.1.9.
  Evidence: npm metadata on 2026-07-11T14:03:12Z reported better-sqlite3 12.11.1 with Node 24 support and sqlite-vec 0.1.9.

- Observation: Google Cloud charges 0.005 USD per hour for an in-use standard-VM external IPv4 even when e2-micro compute and the standard disk fit free-tier allowances.
  Evidence: the official VPC pricing page inspected during the grill lists the external IPv4 rate.

- Observation: OpenAI Realtime WebSocket exposes audio, audio transcript, audio-done, audio-interrupted, and usage events, so the application can own Discord PCM playback and interruption.
  Evidence: the current OpenAI Agents SDK transport documentation exposes those event surfaces.

- Observation: A completed streamed voice reply can be forced to end with the honorific by appending a validated, cached suffix clip generated with the configured Realtime model and voice. An interrupted response is canceled, not completed, so no suffix is appended after interruption.
  Evidence: Realtime output transcripts and audio-done make clip validation possible; audio-interrupted permits immediate local playback cancellation.

- Observation: Discord began requiring DAVE-capable clients for non-stage voice calls in March 2026. The reported @discordjs/voice 0.19.0 receive failure was closed by discordjs/discord.js#11449 and released in 0.19.2, the version selected here. Package/source evidence reduces but does not replace a live server acceptance test.
  Evidence: Discord's enforcement notice documents close code 4017 for outdated clients; upstream PR #11449 says it fixes #11419, and its release reference identifies 0.19.2 as the receive fix.

- Observation: typescript-eslint 8.63.0 supports TypeScript below 6.1, not TypeScript 7.0.2, and TypeScript 6 requires an explicit build rootDir for this project shape.
  Evidence: npm peer metadata reported `typescript >=4.8.4 <6.1.0`; the repository pins TypeScript 6.0.3, and `pnpm build` passed after setting `rootDir: src`.

- Observation: pnpm 11 refuses native dependency scripts until each package is explicitly approved.
  Evidence: the first install rejected @discordjs/opus, better-sqlite3, and protobufjs; pnpm-workspace.yaml now permits only those three scripts, and the frozen install built the native modules successfully.

- Observation: sqlite-vec 0.1.9 loads successfully through its packaged Node entrypoint alongside better-sqlite3 on the development host, and `vec_version()` reports the pinned version.
  Evidence: the real on-disk integration suite migrated twice under WAL, loaded vec0, and preserved a durable memory with copied provenance after its raw source row was deleted through ON DELETE SET NULL.

- Observation: @discordjs/opus 0.10.0 declares a named ESM export but is a CommonJS runtime module, and its Node 24 Linux binary is not prebuilt.
  Evidence: the compiled ESM smoke initially failed on the named import; createRequire fixed the real runtime boundary, and the linux/amd64 Docker build compiled the addon from source before its encode/decode smoke reached READY.

- Observation: Terraform 1.15.8 selected Google provider 7.39.0 for the constrained 7.x line and validated both roots.
  Evidence: both committed lock files contain darwin_arm64 and linux_amd64 checksums; init -backend=false and validate succeed for bootstrap and app without credentials or resource creation.

- Observation: The pinned Realtime SDK's base64 helper overflows at 128 KiB, `sendAudio(..., {commit:true})` does not request a response when turn detection is disabled, and usage arrives shortly after `audio_stopped` rather than atomically with it.
  Evidence: installed-SDK inspection plus authorized live probes measured the threshold, observed usage at 25 ms, and proved 32 KiB chunks plus one explicit `requestResponse()` complete a 130 KB turn with nonzero usage.

- Observation: OpenAI function schemas reject Zod's emitted `format: uri` even though the same string is valid for application-level URL validation.
  Evidence: the first live text probe returned the provider schema error; changing only the tool parameter to a bounded string while preserving `safeFetchText` validation produced a successful live response.

- Observation: Repeated adversarial passes found real cross-file failures in backup ownership, migration ordering, queue liveness, IAM plan enforcement, and voice transport behavior that isolated unit tests did not initially expose.
  Evidence: five durable implementation reviews under `adversarial/` ended with zero critical/high/medium blockers after each confirmed issue received a regression test and re-review.

## Decision Log

- Decision: Use Node.js 24, TypeScript ECMAScript modules, pnpm 11.9, strict compiler settings, and tsc output rather than bundling.
  Rationale: This matches current Weave Labs Node practice and avoids native-addon bundling problems for Opus, better-sqlite3, and sqlite-vec.
  Date/Author: 2026-07-11T14:03:12Z, Codex from confirmed grill decisions.

- Decision: Keep ConversationOrchestrator, VoiceSessionManager, SqliteMemoryStore, OpenAiChiefAgent, and DeploymentHealth as the principal deep modules.
  Rationale: These seams concentrate policy and sequencing that would otherwise leak across Discord listeners, commands, timers, and tests. Small pure functions may support them, but no pass-through interface should be added without a real adapter or test seam.
  Date/Author: 2026-07-11T14:03:12Z, Codex using the codebase-design lens.

- Decision: Treat text and voice as two adapters around one conversational policy and one serialized paid-generation queue. Keep voice interruption and local commands out of band.
  Rationale: Invocation rules differ by medium, but personality, memory, budgets, tools, and failure behavior must not drift.
  Date/Author: 2026-07-11T14:03:12Z, Codex from confirmed grill decisions.

- Decision: Enforce the text suffix after model output. For voice, prefer a naturally spoken suffix verified in the normalized transcript and persist a validated fallback PCM clip keyed by model and voice; append it only when the transcript omits the suffix.
  Rationale: “Mr. President” is a user-facing invariant. Transcript-based dedup avoids a blind double suffix; interrupted audio is canceled immediately and is not considered a completed reply. A repaired reply may have an accepted prosody seam.
  Date/Author: 2026-07-11T14:03:12Z, Codex resolving the streaming implementation detail.

- Decision: Use ordinary SQLite tables as the source of truth, FTS5 for lexical candidates, and sqlite-vec vec0 for embedding candidates combined by reciprocal-rank fusion.
  Rationale: The collection is small, relational provenance and lifecycle rules remain explicit, and no separate vector service is required.
  Date/Author: 2026-07-11T14:03:12Z, Codex from confirmed grill decisions.

- Decision: Keep workflows self-contained and use GitHub-hosted runners.
  Rationale: Chief is outside weave-labs and must not depend on private reusable workflows or RunsOn infrastructure.
  Date/Author: 2026-07-11T14:03:12Z, Codex from confirmed grill decisions.

- Decision: Do not provision live resources during this implementation.
  Rationale: Billing, Discord application creation, identifiers, and secrets remain owner-controlled bootstrap inputs. Repository code and validation can be completed without mutating those systems.
  Date/Author: 2026-07-11T14:03:12Z, user-confirmed delivery boundary.

- Decision: Treat pull-request Terraform plans as advisory and apply only a saved plan created from the merged main commit in the same workflow run.
  Rationale: Reusing a pull-request plan after merge can apply stale state or the wrong commit. The main workflow still applies exactly the plan file it just generated after all policy guards pass.
  Date/Author: 2026-07-11T14:06:24Z, Codex during infrastructure improvement.

## Outcomes & Retrospective

Chief is implemented as a Node 24/TypeScript Discord service with mention/slash invocation, an American chief-of-staff persona, exact text/voice honorific enforcement, persistent SQLite/FTS5/sqlite-vec group memory, persistent monthly cost controls, guarded Internet research, DAVE-capable Discord voice, OpenAI Realtime duplex audio, container packaging, and repository-owned GCP/GitHub deployment automation.

The exact final tree passes formatting, ESLint, strict TypeScript, 23 test files and 133 tests, global coverage thresholds, production compilation, actionlint, shellcheck, Terraform formatting/validation for both roots, diff hygiene, and a linux/amd64 Docker build and read-only smoke. The last measured coverage was 87.41 percent statements, 81.28 percent branches, 86.75 percent functions, and 88.31 percent lines. Container migration, non-root backup ownership, restore verification, and fake healthy/unhealthy deployment rollback also passed.

Authorized live OpenAI probes passed the production text adapter, one hosted web search with a direct source URL, Realtime suffix audio with nonzero usage, and a 130 KB committed duplex input turn with nonzero usage. No key was written to a file, repository, Terraform input, history, or log; the credential-bearing shells were destroyed. The pasted credential still needs owner rotation because it appeared in chat.

The final independent review reports zero critical, high, or medium release blockers. The accepted residual is conservative usage imprecision when a Realtime usage event is unusually later than the 50 ms settle window; hard token/time bounds and reservation fallback preserve the monthly ceiling in the safe direction.

Repository implementation is complete. Production deployment is intentionally not claimed. The owner must still bootstrap GitHub/GCP/Discord values, rotate and store the OpenAI key in Secret Manager, apply both Terraform roots, install the four-check ruleset, and complete the manual DAVE two-speaker receive/transmit/interruption, live transcription, backup/restore, alerting, rollback, and latency scenarios in `docs/manual-acceptance.md`.

## Context and Orientation

The linked worktree is /Users/kellen/development/github/kellen-miller/chief/.worktrees/chief-discord-bot on branch codex/chief-discord-bot, based on main, with no upstream at planning time. The primary checkout must remain untouched. All paths below are relative to this worktree.

Chief has four layers. The Discord layer receives gateway events and voice packets. The application layer decides whether a turn qualifies, serializes paid generations, handles interruption separately, retrieves context, enforces cost and tool limits, invokes the agent, stores source material, and shapes replies. The capability layer contains the OpenAI, web, memory, and voice implementations. The operations layer packages and deploys the application and proves its health.

A deep module presents a small interface while hiding substantial behavior. A seam is the location of that interface. An adapter is a concrete implementation at a seam. These terms follow .agent/PLANS.md and the codebase-design lens.

Create these top-level surfaces:

- package.json, pnpm-lock.yaml, tsconfig.json, tsconfig.build.json, eslint.config.js, prettier.config.mjs, vitest.config.ts, .yamllint.yml, Dockerfile, .dockerignore, and .env.example define the project and validation contract.
- src/config/ validates all non-secret configuration and resolves Secret Manager values into memory.
- src/app/ contains ConversationOrchestrator, normalized turn/result types, the FIFO request queue, invocation policy, reply contract, and runtime composition.
- src/discord/ contains the discord.js gateway adapter, guild-scoped command definitions, and Discord reply/typing/defer delivery.
- src/agent/ contains the small ChiefAgent and ChiefVoiceSession interfaces, the OpenAiChiefAgent adapter, model prompts, tool registration, tool-call accounting, transcription, Realtime transport ownership, and usage extraction. No OpenAI SDK object crosses into Discord or voice modules.
- src/memory/ owns SQLite migrations, source retention, memory lifecycle, FTS5 and sqlite-vec indexing, hybrid retrieval, model-based extraction, nightly consolidation, and forget/correct operations.
- src/voice/ owns Discord voice join/leave, per-speaker Opus decoding, PCM buffers, participant state, one-human streaming, group transcription gating, Realtime playback, suffix clips, interruption, and timers.
- src/web/ owns the guarded URL-fetch tool. OpenAI’s hosted web-search tool supplies search results.
- src/usage/ owns calendar-month cost accounting and the warning and ceiling policy.
- src/health/ owns the loopback-only health endpoint and readiness aggregation.
- src/cli.ts exposes register-commands, migrate, backup, restore, verify-restore, and health commands used by operators and deployment.
- src/index.ts is the minimal process entry point.
- migrations/ contains ordered SQL migrations; tests/ contains unit, integration, contract, and deployment tests.
- scripts/ contains local and VM deployment helpers that are testable without cloud credentials.
- infra/bootstrap/ owns the one-time Terraform-state and GitHub WIF bootstrap.
- infra/app/ owns Artifact Registry, service accounts and IAM, VPC and firewall, persistent disk, VM, secrets, backup bucket, monitoring, notification channels, and alert policies.
- .github/workflows/ contains pull-request CI, Terraform plan, and merge-to-main deployment.

The stable application seam is ConversationOrchestrator.handle(turn), where a ConversationTurn is a normalized eligible-or-observed text or voice turn and ConversationResult describes silence, text segments, or completed voice and citation outcomes. A voice turn may carry bounded PCM input and an AudioSink supplied by VoiceSessionManager; the sink supports enqueue and immediate cancel but exposes no Discord connection. Discord-specific objects, OpenAI SDK objects, database handles, and raw provider errors do not cross this seam.

ChiefAgent has one real production adapter and a deterministic fake used by application tests. Its text method accepts a ChiefRequest containing the normalized prompt, bounded retrieved memories, recent context, source medium, and request limits. Its transcription method accepts only bounded audio plus language and context hints. Its voice method returns a ChiefVoiceSession whose small interface sends PCM, commits a turn, interrupts, closes, and emits normalized audio, transcript, completion, error, and usage events. OpenAiChiefAgent alone constructs Agent, RealtimeAgent, RealtimeSession, OpenAI clients, and provider tools. ConversationOrchestrator owns provider-session reuse and common budget, memory, and suffix policy; VoiceSessionManager owns Discord receive and playback, participants, and timers.

MemoryStore is a real seam because the SQLite adapter and an in-memory test adapter both exercise the same application behavior. It exposes focused operations for recording sources, retrieving bounded memories, applying extracted changes, forgetting, running retention, and backing up. Callers never manipulate FTS, vectors, row IDs, transactions, or supersession directly.

## Plan of Work

### Milestone 1: Establish a reproducible TypeScript service and PR gates

Create the package and configuration files, pin Node 24 and pnpm 11.9, add exact native dependency pins, and make all local commands available through package scripts. Use discord.js, @discordjs/voice, @discordjs/opus, @openai/agents, openai, better-sqlite3, sqlite-vec, zod, pino, and Google Secret Manager and Storage clients. Keep native production dependencies external to tsc compilation.

Create tests before behavior for configuration failure, suffix shaping, invocation policy, and /roll bounds. Implement the smallest pure modules that pass them. The /roll implementation must use crypto.randomInt and must reject non-integers, values below one, and values above one million.

Create .github/workflows/ci.yml with four jobs whose stable check names are Format, Lint, Test, and Build. Each job checks out with persist-credentials false, installs pnpm 11.9 and Node 24, uses pnpm install --frozen-lockfile, and has only contents: read. Format runs Prettier in check mode. Lint runs ESLint, tsc --noEmit, yamllint, actionlint, terraform fmt -check plus terraform validate, and hadolint. Test runs Vitest unit and integration projects on Linux, including native-codec/vector coverage. Coverage includes `src/**/*.ts`; exclusions are enumerated and limited to type-only files and composition entrypoints, with 80 percent global statements, branches, functions, and lines plus focused floors or explicit state-transition matrices for `src/app`, `src/memory`, `src/usage`, and `src/voice`. Build runs tsc with tsconfig.build.json and a production Docker build without pushing. Use concurrency keyed by workflow and pull-request number to cancel stale runs. Pin every external action to a full commit SHA. During installation, verify that the selected typescript-eslint release supports the TypeScript 7 native compiler; if not, pin the newest supported TypeScript 6 release and record the compatibility decision rather than weakening lint.

At the end of this milestone, pnpm format:check, pnpm lint, pnpm typecheck, pnpm test, pnpm build, and docker build all succeed in a clean clone without secrets or paid network calls. CI workflow acceptance tests parse the YAML and assert the four check names, permissions, pinned actions, frozen install, and lack of secret references.

### Milestone 1A: De-risk live-protocol boundaries before the full voice state machine

Pin @discordjs/voice 0.19.2 and its DAVE dependency graph. Add a source/package assertion that the installed build contains the merged RTP padding and packet guards from upstream fix #11449, then exercise encrypted-packet fixtures and per-speaker receive plumbing through the production container. Build a minimal fake-Discord/server-side Realtime transport probe that sends PCM, receives audio plus correlated transcript and usage events, interrupts playback, and closes cleanly without importing provider objects outside OpenAiChiefAgent. Bind the adapter to the exact transport-layer events exposed by the installed SDK and normalize them to ChiefVoiceEvent.

No repository test can prove live DAVE negotiation without the owner's Discord token and guild. Therefore docs/manual-acceptance.md must make a real non-stage channel join, two-speaker receive, transmit, and interruption scenario a blocking production-deployment gate. If 0.19.2 fails that gate, upgrade to a verified fixed release or descope voice from the deployed V1; do not ship a playback-only bot. Record this as unverified until owner bootstrap rather than treating fakes as proof.

### Milestone 2: Implement the deterministic application and persistence core

Write migrations/0001_initial.sql and a migration runner that uses an immediate transaction and records checksums. The schema includes schema_migrations, source_events, memory_jobs, memories, memory_fts, memory_vectors, memory_conflicts, usage_ledger, voice_sessions, and maintenance_runs. Source records contain unique Discord identifiers, speaker, medium, content, occurred time, retention deadline, optional voice-session ID, and extraction status. Memory jobs contain a source range or voice-session ID, not-before time, attempt count, lease expiry, and terminal status so extraction survives process restarts. Memory records contain canonical text, kind, confidence, copied compact provenance, a nullable source_event_id with ON DELETE SET NULL, active or superseded state, and timestamps. Deleting or superseding a memory updates FTS and vec0 in the same serialized write transaction.

Load sqlite-vec from the packaged sqlite-vec module only during database construction, immediately disable further extension loading, require vec_version() to equal the pinned expected version, set WAL, foreign_keys, busy_timeout, and synchronous pragmas, and serialize writes through one queue. Use a 1536-dimensional float vector for text-embedding-3-small.

Implement SqliteMemoryStore so hybrid retrieval queries active memories only, obtains independent FTS5 and vector rankings, combines them with reciprocal-rank fusion, and applies confidence and recency boosts without allowing either to overwhelm relevance. Bound the returned memory count and token estimate. Ordinary source retention removes text after thirty days and voice transcripts after seven while durable memory rows survive with copied compact provenance. Retention never removes a source with a pending extraction job. A forget operation transactionally removes matched memories and their vector and FTS entries, and removes raw source content only when no surviving memory or pending job references it. A correction creates the replacement then supersedes the prior row.

Implement UsageBudget around usage_ledger. It computes a UTC calendar-month estimate from configurable token, Realtime audio-token, transcription, embedding, and hosted-tool per-call pricing; emits the five-dollar warning only once; refuses a paid operation whose conservative reservation could cross ten dollars; reconciles actual usage; and leaves non-AI commands working. A connected voice session reserves per response window, not per idle connection. An active response cannot exceed its reservation; after it completes or is interrupted at the ceiling, close Realtime and post an explicit paused status. Model aliases and price values are configuration so pricing changes do not require scattered edits.

Implement ConversationOrchestrator.handle(turn) and its paid-generation FIFO. The module owns invocation checks, recent-context and memory retrieval, paid-action reservation, request timeout, tool-call counters, text or voice agent invocation, Realtime session reuse, source recording, asynchronous memory extraction scheduling, error translation, citations, Discord chunking, and suffix enforcement. A separate interruptActiveVoice operation synchronously cancels local playback and the current provider response without waiting for the FIFO. Local /roll, /help, /join, /leave, and mention-with-no-content results do not enter the paid queue. The Discord adapter owns typing and interaction-defer calls but receives their timing decisions from the orchestrator. Only one paid generation runs at once; tests cover text arriving mid-voice and speech interrupting an active generation.

At the end of this milestone, integration tests create a temporary on-disk database, load the real vector extension, migrate twice idempotently, insert and rank lexical and vector memories, supersede and forget them, enforce retention, cross the cost warning and ceiling, make online backups, restore into a fresh path, and run integrity_check plus index reconstruction. Tests must prove concurrent observed messages cannot interleave write transactions.

### Milestone 3: Add the text agent, safe research, and automatic memory

Define ChiefAgent with the minimal request and answer types described above. Implement OpenAiChiefAgent with gpt-5.4-mini, reasoning none, the confirmed personality, bounded context, OpenAI hosted web search, and a custom guarded fetch tool. The application, not the model, appends “Mr. President”.

The safe-fetch implementation accepts only HTTP and HTTPS, resolves every hostname before connection, rejects loopback, private, link-local, multicast, unspecified, IPv4-mapped private IPv6, and cloud metadata destinations, and repeats validation for every redirect. The connection uses the already-validated IP through a custom lookup/agent and validates the connected peer, eliminating DNS-rebinding between check and connect. It permits only text-like content types, caps redirects, response bytes, decompressed bytes, and duration, strips active HTML, labels fetched text as untrusted data, and never exposes cookies, local files, credentials, or arbitrary headers. Tests run against local fake DNS/fetch adapters and prove common SSRF encodings, second-lookup changes, and redirects fail. The web tool performs no writes or external side effects.

Enforce six total tool calls, three searches, and ninety seconds in application code and Agent SDK hooks rather than instructions alone. Research answers preserve URL/title citations, Discord text renders source links, and voice hands citations to the Discord adapter for a companion message.

Implement memory extraction with gpt-5.4-nano and strict structured output. The schema yields create, supersede, conflict, forget, or no-op proposals with canonical text, kind, confidence, target references, and a sensitivity classification. Reject sensitive proposals and low-confidence automatic facts before a transaction. Explicit remember requests use a higher-confidence path. Observing text transactionally upserts source_events and a debounced memory_job; ending voice transactionally closes the session and enqueues its memory_job. A worker leases due jobs, retries bounded transient failures with backoff, and resumes expired leases at startup. Budget refusal occurs before leasing or returns the job to pending with not_before at the next UTC month without incrementing attempts. The nightly pass first enqueues eligible unprocessed source ranges, then performs retention that preserves sources for pending jobs, then bounded consolidation. Embedding generation uses text-embedding-3-small only for accepted active memories.

All OpenAI and web adapter contract tests use fakes or recorded sanitized payload shapes. No test imports a real API key or reaches a paid endpoint. At the end of the milestone, a scripted conversation proves silent context capture, mention-only response, cited fresh research, automatic memory creation, correction, forgetting, and later retrieval.

### Milestone 4: Add Discord voice and Realtime conversation

Implement DiscordGateway with only Guilds, GuildMessages, MessageContent, and GuildVoiceStates intents. Validate the allowlisted guild and channels after READY and fail closed if they are missing or inaccessible. Register /roll, /join, /leave, and /help as guild-scoped commands through src/cli.ts. Ignore bots, webhooks, DMs, threads, and other channels before content reaches the application. Use replies to the triggering message, typing indicators for text, and deferred slash replies for work that might exceed Discord’s immediate response window.

Implement VoiceSessionManager as the sole owner of @discordjs/voice connections, receiver subscriptions, @discordjs/opus codecs, participant state, PCM buffers, playback, and timers. It never imports OpenAI. A join request requires the caller in the configured voice channel. Recalculate human count on voice-state changes, latch the mode at utterance start, and hold it for that utterance. Only qualifying turns reset inactivity; ambiguity and repetition prompts do not. Suppress both the 60-second Realtime close and 15-minute Discord leave timers while a qualifying turn is active.

In one-human mode, submit the buffered PCM turn to ConversationOrchestrator, which lazily asks ChiefAgent for a gpt-realtime-2.1-mini session, waits for normalized readiness or a bounded fallback, and streams subsequent audio through the returned ChiefVoiceSession. Configure input transcription with gpt-4o-mini-transcribe-2025-12-15, correlate asynchronous transcript completion by item ID, flag it as best-effort transcript-derived evidence, and enqueue retention/memory only after completion. In group mode, VoiceSessionManager collects per-speaker utterances with Discord end-after-silence plus application silence limits and asks ChiefAgent through the orchestrator to transcribe each with the same snapshot. Reserve transcription within the monthly ceiling before processing; if refused, stop listening and post an explicit paused status. Store the transcript and run a deterministic normalized address check before opening or feeding Realtime. Send the original qualifying PCM through ChiefVoiceSession so tone remains available. Discard every utterance buffer after processing.

Use a bounded playback queue. Any human speech stops local playback and invokes ConversationOrchestrator.interruptActiveVoice out of band, which interrupts ChiefVoiceSession, clears queued audio, and marks the incomplete response canceled. Only a later qualifying completed turn may receive a response. Bind completion/interruption at the installed SDK's transport layer and normalize it; the application layer consumes only ChiefVoiceEvent. Collect normalized output transcript deltas for safety without storing audio. Ask the conversational model to end naturally with “Mr. President” and buffer the final tail until the normalized completion transcript is known. When the transcript already ends with the exact suffix, release the tail unchanged. Otherwise append a validated fallback PCM clip persisted on the durable volume and keyed by model plus voice. Generate that clip only when absent and while budget permits. Test a response that already contains the suffix to prove no double suffix. If validation fails, report the voice failure honestly in text.

Close an idle Realtime session after sixty seconds and the Discord connection after fifteen minutes without a qualifying turn, never during an active turn. Test all state transitions with fake clocks, fake PCM chunks, fake Discord connections, and a fake Realtime transport. Add a container-level native-codec smoke test that encodes and decodes a known short PCM fixture. At the end of the milestone, the deterministic harness proves one-human free conversation, group silence when unaddressed, group response when addressed, latched participant-mode changes, overlap fallback, out-of-band interruption, suffix dedup/repair, source posting, budget cutoff, session close, and leave.

### Milestone 5: Package, deploy, observe, back up, and roll back

Create a multi-stage Debian slim Dockerfile for Node 24. Install only the native build and runtime packages required by @discordjs/opus, better-sqlite3, sqlite-vec, and container health checks. Build with pnpm 11.9 and frozen lockfile, compile with tsc, prune dev dependencies, run as a non-root user, use a read-only root filesystem at runtime, mount /var/lib/chief for SQLite and /tmp as tmpfs, set SQLITE_TMPDIR=/tmp and PRAGMA temp_store=MEMORY, cap Node’s old-space heap, and expose health only on 127.0.0.1 through the docker host mapping. Keep backup staging on /var/lib/chief. Add a container smoke test that starts with fake adapters, loads sqlite-vec, migrates, checks codecs, performs online backup and VACUUM INTO under the actual read-only/tmpfs layout, and reaches READY health.

Implement GET /healthz as a loopback-only endpoint returning non-secret JSON. Liveness covers event-loop responsiveness; readiness covers Discord READY, database read/write, vec_version(), disk free space, and maintenance freshness. Do not include prompts, messages, transcripts, Discord IDs, secret values, or tokens in logs or health output. Pino redaction and tests must cover nested errors and provider payloads.

Create infra/bootstrap Terraform for a versioned remote-state bucket, GitHub Workload Identity Pool/provider, and narrowly scoped plan, apply, and deploy service accounts. Run bootstrap initially with local state under an explicitly ignored path, then migrate that state into its own protected GCS prefix after the bucket exists. The PR provider maps repository and event claims, has an explicit `assertion.repository == "kellen-miller/chief" && assertion.event_name == "pull_request"` condition, and binds the read-only plan service account through `attribute.repository/kellen-miller/chief`; it does not require an environment claim. The production provider requires the exact subject repo:kellen-miller/chief:environment:production for apply and deploy. Grant deploy only Artifact Registry publishing plus IAP tunnel and OS Login capabilities needed to reach the named VM; use no SSH keys and open TCP 22 only from 35.235.240.0/20.

Create infra/app Terraform for APIs, Artifact Registry, runtime service account, Secret Manager resources without versions, backup bucket with thirty-day lifecycle, custom VPC and IAP SSH firewall, static external IPv4, durable standard disk with auto-delete false, e2-micro Debian VM, resource-level IAM, monitoring email channel, alert policies, and production labels. Use prevent_destroy only for the Terraform state and backup buckets where the documented owner decommission path can explicitly remove it; use provider deletion protection where available for the VM and disk. Protect secrets and other durable resources with the plan-policy script and narrowly scoped apply identity without deadlocking the documented owner recovery path. The policy rejects unapproved destruction or replacement before PR reporting or main apply. Use GCS remote state and checked-in example backend and tfvars files without live values.

Provision the VM with Docker, a two-gigabyte swap file, systemd units and timers, strict journald rotation, and a minimally configured Google Ops Agent for Chief JSON logs and host metrics. Grant only logs writer and metric writer in addition to the runtime needs. Configure systemd start limits and a health-watchdog timer that writes a structured event when the loopback check fails even if the Chief container is down. Standardize redacted event names for chief_process_started, chief_health_failed, chief_backup_failed, chief_budget_warning, chief_budget_ceiling, chief_disk_low, and chief_voice_underrun. Terraform log-based metrics and email alert policies consume those events; built-in VM uptime covers a stopped VM. Monitor agent memory itself; the resize threshold remains sustained swap, missed Discord heartbeats, or audible latency.

Create scripts/deploy.sh with a transaction-like sequence. It receives an immutable Artifact Registry digest, verifies inputs, records the current digest, pulls the candidate, quiesces and stops Chief, then detects the database on the mounted durable disk independently of container state. If a database exists and the candidate has any pending migration, a verified offline-consistent pre-deploy backup is mandatory or deployment aborts. Run the candidate migration, start the candidate in a readiness mode that completes local database/provider checks before Discord gateway login, then permit login and poll local health plus Discord READY for at most five minutes. On failure, stop the candidate before it can accept writes, restore the pre-deploy backup when a migration ran, restart the prior digest, verify health, and exit nonzero. First deploy handles the absence of a prior container and database explicitly. scripts/backup.sh, restore.sh, and restore-drill.sh use the application CLI and never copy a live WAL database directly.

Create .github/workflows/terraform-plan.yml for same-repository pull requests and .github/workflows/deploy.yml for pushes to main. The plan workflow uses contents: read and id-token: write, authenticates through the repository/event-scoped PR WIF provider, creates a binary plan and JSON rendering, runs the protected-resource policy, and publishes only a redacted human-readable summary. Do not upload the binary plan because it can contain sensitive values. Forked pull requests and repositories that have not completed WIF bootstrap still run local fmt and validate, emit an explicit non-error skip summary, and never attempt credentialed plan. Repository-policy tests distinguish short-lived OIDC from stored secrets and assert the PR provider cannot accept push or environment tokens.

Deploy uses a job scoped to the production environment without manual approval. It authenticates through the environment-bound WIF principal, initializes against current state at the merged commit, creates a new saved binary plan, runs the same protected-resource policy, and applies that exact same-run plan file. It then builds and pushes an image tagged by commit SHA, resolves its digest, connects through IAP and OS Login, runs deploy.sh, and records the digest and health evidence. External actions are pinned to full SHAs and checkout credentials stay disabled.

Add deployment acceptance tests that inspect Terraform plans generated with fixture variables, parse workflow YAML, shellcheck scripts, run scripts against a fake docker/gcloud harness, and deliberately fail candidate health to prove prior image and database restoration. No test creates live resources.

### Milestone 6: Complete documentation and evidence

Write README.md for product behavior and local fake-adapter development. Write docs/discord-setup.md for application creation, privileged Message Content intent, exact minimal permissions, guild-scoped commands, and required IDs. Write docs/gcp-bootstrap.md for billing project choice, backend and WIF bootstrap, GitHub variables and production environment, secret seeding, static IP cost, and first deployment. Add an idempotent scripts/configure-github-ruleset.sh that uses gh api only when the owner explicitly runs it; it requires Format, Lint, Test, and Build on main and prevents direct pushes while preserving the merge-to-main deploy trigger. Write docs/operations.md for health, logs, alerts, budgets, durable memory-job inspection, backup listing, restore, rollback, secret rotation, e2-small resize, and retention. Write docs/manual-acceptance.md as the real-server checklist.

Run every command in Concrete Steps from a clean checkout and record concise evidence in this plan. Run a local restore drill and failed-deployment harness; these exercise control flow only. Live Discord DAVE receive, live OpenAI latency/cost, live WIF, live GCS restore, and live GCP rollback remain pending owner bootstrap and must be labeled unverified rather than simulated as complete. The repository is implementation-complete when all local and CI-equivalent gates pass, the work item reviews find no unresolved critical or high issue, and the documentation makes the remaining owner actions explicit. Production deployment is not accepted until the owner-run live gates pass.

## Concrete Steps

All commands run from /Users/kellen/development/github/kellen-miller/chief/.worktrees/chief-discord-bot unless stated otherwise.

Install and verify the toolchain:

    corepack enable
    corepack prepare pnpm@11.9.0 --activate
    pnpm install --frozen-lockfile
    node --version
    pnpm --version

Expected versions begin with v24 and 11.9.

Run fast developer gates after each slice:

    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test:unit

Run integration and full gates before a milestone closes:

    pnpm test:integration
    pnpm test:coverage
    pnpm build
    docker build --tag chief:test .
    docker run --rm chief:test node dist/cli.js smoke

Validate infrastructure and deployment assets without credentials:

    pnpm lint:yaml
    pnpm lint:actions
    pnpm lint:docker
    terraform -chdir=infra/bootstrap fmt -check -recursive
    terraform -chdir=infra/bootstrap init -backend=false
    terraform -chdir=infra/bootstrap validate
    terraform -chdir=infra/app fmt -check -recursive
    terraform -chdir=infra/app init -backend=false
    terraform -chdir=infra/app validate
    pnpm test:deployment
    pnpm test:repository-policy

Run the recovery evidence:

    pnpm chief -- migrate --database .tmp/acceptance/chief.db
    pnpm chief -- backup --database .tmp/acceptance/chief.db --destination .tmp/acceptance/backups
    pnpm chief -- verify-restore --backup .tmp/acceptance/backups/latest.db
    pnpm test:rollback

The fake-adapter smoke run must log a READY state and return HTTP 200 from the loopback health endpoint without a Discord or OpenAI credential.

## Validation and Acceptance

The format gate passes only when Prettier reports no changes for TypeScript, JavaScript, JSON, Markdown, YAML, and supported configuration files and terraform fmt reports no changes for Terraform.

The lint gate passes only when ESLint and strict TypeScript report no errors; yamllint and actionlint accept every workflow; hadolint accepts the Dockerfile; terraform validate accepts both roots; shellcheck accepts deployment scripts; and repository policy tests find no unpinned external action, persisted checkout credential, broad workflow permission, paid PR call, uploaded binary Terraform plan, secret value in Terraform, private weave-labs/ci dependency, unguarded protected-resource replacement, or drift in the stable required-check names.

The test gate passes only when unit and integration tests pass with the committed `src/**/*.ts` coverage include list, narrow enumerated exclusions, 80 percent global thresholds, and focused state-transition coverage for app, memory, usage, and voice. Real sqlite-vec/FTS5, migration, backup, restore, codec, retention, memory, queue, budget, and rollback tests succeed on Linux. Distribution-like roll sampling must verify bounds and deterministic rejection, not use a flaky statistical fairness assertion.

The build gate passes only when tsc emits runnable ECMAScript modules and the production container builds on linux/amd64, runs as non-root, loads the pinned native extensions, starts the fake-adapter runtime, and becomes healthy.

Application acceptance is observable through tests that prove: unmentioned allowed-channel text produces no reply; an @Chief request produces one final segment ending in “Mr. President”; other channels, DMs, threads, bots, and webhooks are ignored; /roll is available after the AI ceiling; researched text includes links; voice research produces a text source companion; one-human voice does not require a name; group voice does; interruption stops audio immediately; completed voice appends the validated suffix; memory can be learned, corrected, forgotten, and recalled; pending extraction resumes after a simulated crash and lease expiry; a budget-paused job resumes in the next UTC month; and raw content expires on schedule.

Operational acceptance is observable through a fake deploy where a healthy candidate replaces the old digest and an unhealthy candidate exercises restoration of the old digest and pre-migration database. The harness includes a prior-container-down/populated-disk/migration-failure case and proves a verified backup existed before migration. A restored database passes SQLite integrity_check, reports the expected vec_version(), rebuilds FTS and vector indexes, and must yield the same known hybrid-memory query results. Monitoring fixture tests prove every named event is redacted and connected to the intended alert policy. The GitHub ruleset script has a dry-run or fixture mode that proves the four stable required checks without mutating GitHub. The five-minute recovery claim remains a live GCP acceptance measurement.

Live acceptance after owner bootstrap requires the manual scenarios in docs/manual-acceptance.md, including DAVE-enabled two-speaker receive/transmit/interruption, and measured normal text generation at or below ten seconds plus first voice audio at or below 2.5 seconds after a qualifying completed turn reaches the head of the paid-generation queue, excluding deliberate queue wait and slow web searches. These live measurements are not required to claim repository implementation complete, but must be completed before claiming Chief is production-deployed.

## Idempotence and Recovery

Package installation, formatting, linting, tests, TypeScript compilation, Docker build, Terraform fmt/init/validate, migrations, command registration, daily maintenance, and Terraform apply must be idempotent.

Each SQL migration has a stable identifier and checksum and runs once inside a transaction. Never edit an applied migration; add a new ordered migration. A failed first-run migration leaves no version row. A deploy quiesces writes and always creates and verifies a backup from an existing durable database before a migration, independent of prior container state. Restore writes to a new path, verifies it with known hybrid-query fixtures, stops Chief, atomically swaps database paths, and retains the failed database for investigation until the operator confirms cleanup.

Terraform bootstrap and application roots are separate so application CI cannot recreate or destroy its own identity and state bucket. Bootstrap state is migrated once from the ignored local path to a versioned, protected GCS prefix. The application apply identity has no permission to mutate the WIF pool, provider, or its own principal binding. Provider deletion protection, bucket lifecycle guards, and the protected-resource policy prevent automated destruction or replacement of durable resources without blocking the explicit owner recovery/decommission path. Secret values remain outside state.

The deployment script is safe to rerun with the same digest. It records current, candidate, and prior digests in a host state file using atomic rename. A failed rollback exits loudly and preserves both database artifacts and logs. It never reports success based solely on container process state; readiness and Discord READY must pass.

## Artifacts and Notes

The durable intent record is .agent/work/chief-discord-bot/decision.md. The lifecycle record is .agent/work/chief-discord-bot/meta.json. Planning and implementation adversarial reviews live under .agent/work/chief-discord-bot/adversarial/.

Current package metadata observed during planning includes discord.js 14.26.5, @discordjs/voice 0.19.2, @discordjs/opus 0.10.0, @openai/agents 0.13.2, openai 6.46.0, better-sqlite3 12.11.1, sqlite-vec 0.1.9, zod 4.4.3, pino 10.3.1, Vitest 4.1.10, TypeScript 7.0.2, ESLint 10.7.0, and Prettier 3.9.5. The implementation should pin native and infrastructure-critical packages exactly and let pnpm-lock.yaml provide reproducibility for the rest. Re-check types during installation rather than assuming examples from older versions compile.

The minimum live bootstrap inputs are GCP billing project and region/zone, Terraform state bucket name, GitHub repository and production environment, Discord application/client ID, Discord guild ID, main text channel ID, main voice channel ID, alert email, Discord token secret value, and OpenAI API key secret value.

## Interfaces and Dependencies

In src/agent/chief-agent.ts define normalized provider seams:

    export interface ChiefAgent {
      answerText(request: ChiefRequest): Promise<ChiefAnswer>;
      transcribe(request: TranscriptionRequest): Promise<Transcript>;
      openVoice(request: VoiceSessionRequest): Promise<ChiefVoiceSession>;
    }

    export interface ChiefVoiceSession {
      sendAudio(pcm: ArrayBuffer, options?: { commit?: boolean }): void;
      interrupt(): void;
      close(): Promise<void>;
      onEvent(listener: (event: ChiefVoiceEvent) => void): () => void;
    }

ChiefRequest contains only normalized content, bounded context and memories, medium, request ID, and immutable limits. ChiefAnswer contains user-facing content, citations, provider usage, and terminal status. ChiefVoiceEvent is a discriminated union for ready, audio, transcript delta, completed, interrupted, usage, and error. The adapter hides OpenAI Agent construction, model settings, instructions, tools, tracing, WebSocket transport, raw events, and provider errors.

In src/app/conversation-orchestrator.ts define:

    export class ConversationOrchestrator {
      handle(turn: ConversationTurn): Promise<ConversationResult>;
    }

The constructor accepts ChiefAgent, MemoryStore, UsageBudget, a monotonic clock, and narrow delivery callbacks. handle hides eligibility, FIFO scheduling, retrieval, budget reservation, timeout, tool limits, memory scheduling, reply shaping, and error mapping. Tests exercise the same method used by Discord adapters.

In src/memory/memory-store.ts define a compact interface:

    export interface MemoryStore {
      observe(source: SourceEvent): Promise<void>;
      retrieve(query: MemoryQuery): Promise<readonly RetrievedMemory[]>;
      apply(changes: readonly MemoryChange[]): Promise<void>;
      forget(request: ForgetRequest): Promise<ForgetResult>;
      maintain(now: Date): Promise<MaintenanceResult>;
      backup(destination: BackupDestination): Promise<BackupReceipt>;
    }

SqliteMemoryStore hides SQL, transactions, WAL, FTS5, vec0, embeddings, fusion, retention, and backup sequencing. The in-memory adapter exists only for application tests; integration tests use the real adapter.

In src/voice/voice-session-manager.ts expose join, leave, participant-change, and shutdown operations to the Discord adapter. Raw receiver and playback events remain private to its implementation. It accepts a function that submits observed voice turns and an AudioSink to ConversationOrchestrator, keeping OpenAI, memory, and budget policy out of Discord event listeners.

Use Node built-ins for crypto, DNS, HTTP server, timers, streams, and IP classification wherever sufficient. Add a dependency only when it hides real complexity or supplies a required protocol or native implementation. Do not create provider-neutral wrappers for Discord, GCP, or OpenAI beyond the explicitly confirmed ChiefAgent seam and testable storage or delivery seams.

Plan revision note (2026-07-11T14:03:12Z): Created the initial self-contained ExecPlan from the completed grill, current repository state, current sibling-repository CI/infra patterns, package metadata, and the codebase-design lens.

Plan revision note (2026-07-11T14:04:26Z): Improvement pass 1 removed OpenAI SDK leakage from VoiceSessionManager, expanded the confirmed ChiefAgent provider seam to cover text, transcription, and normalized Realtime sessions, and clarified ownership of playback versus conversational policy. Usefulness score: 9/10 - corrected a provider-lock and duplicated-policy risk before code existed.

Plan revision note (2026-07-11T14:06:24Z): Improvement pass 2 corrected Terraform plan provenance, exact WIF subjects, same-run apply behavior, IAP-only administration, bootstrap state migration, and protected-resource destruction guards. Usefulness score: 9/10 - removed stale-plan and data-loss paths from automatic main deployment.

Plan revision note (2026-07-11T14:08:35Z): Improvement pass 3 added restart-safe memory jobs, budget-paused job recovery, named redacted monitoring events, pre-bootstrap Terraform-plan skipping, and an explicit owner-run GitHub ruleset bootstrap. Usefulness score: 8/10 - closed persistence, alerting, and merge-gate gaps that tests can now prove.

Plan revision note (2026-07-11T14:24:00Z): Adversarial resolution corrected the paid-generation concurrency boundary, made interruption out of band, closed retention/forget and deploy-backup data-loss windows, defined voice budget cutoff, hardened SSRF and SQLite runtime paths, corrected PR WIF binding, and downgraded fake recovery claims to control-flow evidence. It also source-verified that the DAVE bug cited as critical was fixed in the pinned @discordjs/voice 0.19.2 while preserving a mandatory live DAVE acceptance gate. Usefulness score: 10/10 - resolved every confirmed critical/high issue before implementation and rejected one stale blocker with primary-source evidence.

Plan revision note (2026-07-11T18:39:59Z): Implementation and five adversarial re-reviews hardened backup ownership and ordering, persistent budgeting, OpenAI tracing/schema/usage, Realtime connection and audio framing, Terraform IAM/destroy policy, SSRF address classification, and DR uid handling. Authorized live probes then proved text, hosted search, Realtime output, and a chunked duplex input turn against the configured models. Usefulness score: 10/10 - converted repository-only confidence into direct provider evidence and caught three SDK contracts that mocks could not prove.
