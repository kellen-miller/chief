# Chief Discord Bot Decision Record

## Objective

Build Chief, a private Discord bot for one presidential-themed friends server. Chief is a calm, hyper-competent, discreet American chief of staff with dry wit. He answers text requests, participates in voice conversations using OpenAI Realtime, researches the web, remembers useful group context, summarizes discussions, and rolls dice. Every user-facing reply ends exactly with “Mr. President”.

This record compiles the completed grill conversation. It distinguishes confirmed requirements from implementation defaults and deliberately excludes live cloud or Discord provisioning until the owner supplies the required project, application, channel, and secret values.

## Confirmed user decisions

### Audience and invocation

- Chief serves exactly one allowlisted Discord guild and one configured main text channel plus one configured main voice channel.
- Chief ignores direct messages, threads, webhooks, other bots, other guilds, and every non-allowlisted channel.
- Any human member of the allowlisted guild may invoke Chief; no special role is required.
- In text, Chief responds only to a direct @Chief mention or a supported slash command. He may silently read unmentioned messages in the allowed main text channel for context and memory.
- In voice with exactly one human participant, that participant may speak conversationally without addressing Chief. With two or more humans, a completed turn must directly address “Chief” at the start, end, or another unambiguous position before Chief may answer.
- Participant mode is recalculated whenever humans join or leave. Bots do not count. The mode is latched when an utterance begins and remains fixed for that utterance, so a join or leave during speech cannot change whether the turn qualifies.

### Personality and response contract

- Chief is American, masculine, polished, calm, concise, discreet, and hyper-competent, with light dry wit.
- Chief may use friendly sarcasm or light roasting and may mirror ordinary profanity, but must not initiate aggressive abuse or target sensitive traits.
- Chief must not imitate Marvel’s Jarvis, quote it, claim that identity, or use a British voice.
- Normal text replies are one to four sentences unless the user asks for detail.
- Every user-facing text, voice, command, help, and error reply ends exactly with “Mr. President”. A chunked Discord reply appends the suffix only to its final segment.

### Version-one capabilities and non-goals

- Version one answers questions, performs read-only web research and guarded URL fetches, holds text and voice conversations, learns and retrieves communal memories, summarizes discussions, and implements /roll, /join, /leave, and /help.
- /roll accepts max as an integer and returns a cryptographically fair value from 1 through max inclusive. The accepted range is 1 through 1,000,000.
- A mention with no substantive request returns a brief greeting and help hint.
- Version one does not implement reminders, calendars, external-account actions, browser automation, purchases, posting to external systems, shell execution, arbitrary code execution, or a hierarchy of multiple conversational agents.
- Internet access is read-only. Chief decides when freshness requires search. Research-backed text replies include source links; voice research posts the sources in the configured main text channel.
- A request may use at most six tool calls, including at most three searches, and runs for at most ninety seconds.

### Voice behavior

- /join is explicit and succeeds only when the caller is connected to the configured main voice channel. /leave disconnects Chief.
- Chief leaves after fifteen minutes without a qualifying request. In one-human mode every completed turn resets the timer; in group mode only an unambiguously addressed turn resets it. Ambiguous speech, overlap-repetition prompts, and unaddressed context do not reset it. The timer cannot expire while a qualifying turn is actively running.
- A paid Realtime session starts lazily when qualifying speech begins, with initial audio buffered, and closes after sixty seconds of silence.
- Discord audio is handled per speaker. In one-human mode PCM audio streams directly to an OpenAI Realtime WebSocket. Input transcription uses the same pinned transcription snapshot as group mode, is correlated by item ID, and must complete before its best-effort transcript may enter retention or memory extraction.
- In group mode local voice-activity detection buffers each utterance. The pinned default gpt-4o-mini-transcribe-2025-12-15 model transcribes every utterance before deterministic application gating. Unaddressed transcripts are available for context but are not sent to the conversational model. Addressed turns send the original buffered audio to Realtime.
- Any human speech interrupts Chief immediately. Chief answers after an interruption only if the completed turn qualifies.
- Overlapping speakers remain separated where Discord permits. When the result is unreliable, Chief asks for repetition.
- Audio is never retained. Audio buffers are erased immediately after processing. Voice transcripts are retained for seven days.

### Models and agent shape

- Use the OpenAI Agents SDK for TypeScript, not Google ADK.
- Present one stable ChiefAgent module to the Discord application. The initial adapter is OpenAiChiefAgent. Background memory extraction is an internal model call, not a second conversational agent.
- Use a regular Agent for text/tool work and RealtimeAgent plus RealtimeSession with a server-side WebSocket/custom audio pipeline for voice.
- All model identifiers are configurable. Defaults are gpt-5.4-mini with reasoning disabled for text/tool/web work, gpt-realtime-2.1-mini for voice, gpt-5.4-nano with strict structured output for memory extraction and consolidation, text-embedding-3-small for embeddings, and the pinned transcription snapshot stated above.
- Execute only one paid AI generation at a time across text and voice. Paid generations wait in a FIFO queue with visible defer or typing feedback. Immediate voice interruption and local non-AI commands bypass that queue; interruption cancels playback and the active Realtime response out of band. Latency targets apply after a request reaches the head of the paid-generation queue.

### Memory and retention

- Memory is communal to the allowed server. Only Chief’s application code accesses the database; there is no memory browser or administrative memory command surface in version one.
- Main text source messages are retained for thirty days. Voice transcripts are retained for seven days. Extracted durable memories may remain indefinitely until superseded or forgotten.
- Automatically extract durable group-useful facts, decisions, preferences, recurring jokes, relationships, plans, and ongoing projects rather than retaining every detail as a memory.
- Never promote credentials, financial data, exact addresses, or similarly sensitive content into long-term memory.
- “Chief, remember…” creates a high-confidence memory. Ordinary conversation uses a stricter automatic-extraction threshold.
- Store copied compact provenance (platform source ID, speaker, timestamp, confidence, and supersession history) with each memory plus an optional nullable source-row reference. Durable memories remain intelligible after raw source retention expires.
- Corrections supersede stale memories. Preserve unresolved conflicts with uncertainty. Natural-language forget requests permanently delete the matching durable memory and its FTS/vector rows. Raw source content is deleted with it only when no surviving memory or pending extraction job references that source; ordinary retention may remove raw source content without deleting durable memories.
- Run extraction after text activity settles and when voice sessions end. Run nightly consolidation to deduplicate and expire stale items.
- Retrieve through hybrid FTS5 and sqlite-vec ranking with confidence and recency. Never send the entire memory database to a model.

### Persistence

- Use SQLite, not PostgreSQL, because Chief is a single-process bot on one VM.
- Run SQLite in WAL mode with serialized application writes.
- Keep relational source and memory records in ordinary tables. Use an FTS5 index for lexical search and a sqlite-vec vec0 virtual table keyed by memory row ID for vectors.
- Pin sqlite-vec to an exact version. Package and load only that extension, disable arbitrary extension loading, and verify vec_version() during startup.
- Test vector creation, search, deletion, migration, online backup, and restore.
- Use reciprocal-rank fusion or an equivalent deterministic hybrid combiner rather than a vector database service.

### Cost and failure controls

- Track OpenAI usage locally. Warn once at five US dollars and enforce an application-level ten-dollar ceiling per UTC calendar month.
- Every paid operation, including hosted-search calls, transcription, embeddings, text tokens, and Realtime audio tokens, consumes a conservative reservation before it starts and reconciles actual usage afterward. Voice reserves one response window at a time rather than an entire connected session. Group pre-gate transcription has its own reservation within the same ten-dollar ceiling.
- At the ceiling, pause AI-backed text, voice, memory extraction, embeddings, transcription, and web-research synthesis until reset. An in-progress response may consume only its existing reservation, then the Realtime session closes. /roll, /help, /join, and /leave remain available; /join clearly reports that Chief is connected but cannot listen or answer while AI usage is paused, rather than failing silently.
- State model and web failures honestly. Do not fabricate a result.
- Add two gigabytes of swap as an emergency buffer only, cap the Node heap, stream audio, and monitor CPU, memory, swap, Discord heartbeat, and voice underruns.
- Resize from e2-micro to e2-small if sustained swapping, dropped heartbeats, or audible latency show that the free-tier machine is inadequate.

### Hosting and infrastructure

- Deploy one containerized Chief process to a Google Cloud e2-micro VM in an eligible US free-tier region.
- Use a standard persistent disk within the thirty-gigabyte free allowance. Keep the SQLite volume outside the container and set the data disk to survive instance replacement.
- Accept an external IPv4 baseline of approximately four US dollars per month because IPv6-only Discord voice compatibility is unproven. Expose no public application endpoint. Restrict administration to IAP and deny unsolicited ingress.
- Use repository-owned Terraform under infra/. Project creation, billing attachment, Terraform-state bucket creation, workload-identity bootstrap, and first secret seeding are explicit one-time owner actions.
- Use GitHub Actions OIDC and Google Workload Identity Federation with no service-account keys.
- Separate Terraform, image publishing/deployment, and VM runtime identities. The runtime identity may read only Chief’s required secrets and backup bucket paths.
- Store Discord and OpenAI credentials in Secret Manager. Terraform creates secret resources but never manages secret values.
- Run the immutable container under systemd with restart backoff.
- Create a verified online SQLite backup to GCS daily. Before every migration, quiesce writes, stop Chief, create and verify a definitive backup from any existing database on the durable disk whether or not the prior container is running, then migrate. Retain thirty daily backups.
- Health covers Discord READY state, SQLite read/write, sqlite-vec availability, disk space, and event-loop responsiveness.
- Emit structured JSON logs with rotation. Redact prompts, source messages, transcripts, tokens, and secrets.
- Notify the owner by email for repeated crashes, failed backups, low disk space, and five-dollar or ten-dollar AI thresholds.
- Test image rollback and database restoration before deployment is considered ready.

### Delivery and CI

- Work in the linked worktree at /Users/kellen/development/github/kellen-miller/chief/.worktrees/chief-discord-bot on branch codex/chief-discord-bot, based on main, with no upstream configured at planning time.
- Pull requests run independent formatting, linting, testing, and production-build checks. Merging is blocked unless all required checks pass.
- Use Node.js 24 and pnpm 11.9, pinned through package.json.
- Formatting uses Prettier check. Linting uses ESLint, TypeScript checking, YAML/actionlint, Terraform formatting and validation, and Dockerfile linting.
- Tests use Vitest unit and integration suites with meaningful coverage thresholds. Discord, OpenAI, and web access are mocked or recorded; the Format, Lint, Test, and Build pull-request jobs use no repository secrets, cloud credentials, or paid API calls.
- Build CI compiles production TypeScript and builds the final container without pushing it.
- CI is self-contained in this personal repository; it must not call private weave-labs/ci reusable workflows. It follows their current conventions: minimal permissions, checkout credentials disabled, external actions pinned to full commit SHAs, Node 24, pnpm, and separate named checks.
- Cancel stale pull-request runs.
- Pull requests always perform Terraform format and validate. Same-repository pull requests may additionally obtain a short-lived read-only Google credential through a repository-scoped WIF provider and run plan; forked or pre-bootstrap pull requests skip only the credentialed plan. A main merge runs verification, applies Terraform, builds and pushes an immutable commit-SHA image, quiesces Chief, takes the pre-migration backup, runs migrations, starts the new image, and verifies readiness.
- A failed deploy restores the prior database backup when required, restarts the prior image digest, and must recover health within five minutes.
- Scope the production OIDC identity through a GitHub production environment without a manual approval gate, preserving merge-to-main deployment.

## Agent-recommended defaults

- Use TypeScript with ECMAScript modules and strict compiler settings.
- Use discord.js and @discordjs/voice for Discord. Decode Opus and stream PCM without retaining audio files.
- Compile with tsc rather than bundling native SQLite and audio dependencies.
- Use ESLint flat configuration, Prettier, Vitest, and explicit package scripts for format, lint, typecheck, test, build, and aggregate verification.
- Use structured schema validation for all configuration and model outputs.
- Prefer small deep modules whose interfaces hide policy and sequencing: DiscordGateway, ChiefAgent, ConversationOrchestrator, MemoryStore, VoiceSession, WebResearch, UsageBudget, and DeploymentHealth. Do not create interfaces for dependencies with only one implementation unless tests or a second real adapter make the seam useful.
- Register Discord commands as guild-scoped commands for immediate updates.

## Assumptions

- The owner will create or choose a billed GCP project and Discord application before live bootstrap.
- The owner will supply the Discord guild ID, main text channel ID, main voice channel ID, alert email address, GCP project and region values, and secret values outside version control.
- GitHub-hosted runners are sufficient for this personal repository.
- One Discord voice connection, one Realtime session, and one serialized paid-generation queue are sufficient for version one; interruption and local commands remain out-of-band control paths.
- The friend-group traffic level keeps SQLite, FTS5, sqlite-vec, and e2-micro operationally reasonable.
- English is the primary spoken language.
- No backwards compatibility is required because the repository has no existing bot contract or production data.

## Open questions or user judgments

No product or architecture questions remain open. Live resource identifiers, billing ownership, Discord application creation, and secret values are intentionally deferred bootstrap inputs rather than unresolved design decisions.

## Accepted risks and failure modes

- The e2-micro’s shared CPU and one gigabyte of memory may produce voice latency or heartbeat instability. Swap is not a performance solution; the documented resize threshold governs escape.
- Discord requires DAVE E2EE for non-stage voice calls. @discordjs/voice 0.19.2 contains the upstream receive fix for the 0.19.0 DAVE/RTP failure, but a real-server receive/transmit/interruption check remains a mandatory production-deployment gate because fakes cannot prove Discord compatibility. Native Opus/SQLite packaging is separately covered by container integration tests.
- Group address gating adds transcription latency and cost because every group utterance must be transcribed before Chief decides whether to answer.
- Local usage accounting may lag provider billing and is an application safety control, not an authoritative invoice. Reservations include per-call tools and audio-token pricing and preserve explicit headroom rather than assume exact provider reconciliation.
- A persisted fallback voice-suffix clip can have an audible prosody seam. Chief prefers a naturally spoken suffix detected in the normalized output transcript, suppresses fallback when already present, and uses the validated clip only to repair an omission; correctness takes precedence over a perfectly seamless splice.
- A single VM is not highly available. Automatic restart, durable disk, backup, and rollback reduce recovery time but do not eliminate downtime.
- sqlite-vec is pre-1.0. Exact pinning, version checks, migration tests, and restore tests constrain upgrade risk.
- Read-only web access still faces prompt injection and hostile content. Fetch limits, content-type limits, network restrictions, tool-result labeling, and the prohibition on side effects are required.
- Automatic communal memory can retain incorrect or awkward facts. Confidence, provenance, supersession, natural-language forgetting, and bounded retrieval mitigate but do not eliminate this risk.
- External IPv4 and data transfer create a nonzero GCP bill even when compute and disk remain within free-tier allowances.

## Validation expectations

- Unit tests prove message/channel gating, suffix enforcement and deduplication, command validation and cryptographic roll bounds, voice participant/address state transitions including mid-utterance joins/leaves, out-of-band interruption, queueing, budget enforcement, retention, redaction, and mandatory memory conflict rules.
- Integration tests prove SQLite migrations, FTS5 plus sqlite-vec retrieval, memory supersession/deletion, backup and restore, Discord/OpenAI/web adapter contracts, and container packaging of native dependencies.
- Pull-request format, lint, test, and build checks all pass without secrets or paid network calls.
- A post-deploy probe proves process health, Discord READY, database read/write, vector extension load, and event-loop responsiveness without posting a Discord message.
- Manual acceptance in the real server covers mention response, /roll, join, one-human conversation, group address gating, interruption, leave, researched answers with sources, automatic memory, correction, forgetting, and later recall.
- Normal text replies target ten seconds or less. First voice audio targets 2.5 seconds or less after a qualifying completed turn, excluding slow web searches.
- A deliberately failed local deployment exercises rollback control flow against a fake container/cloud harness. Only an owner-run failed deployment in live GCP can prove recovery of the prior image and database state within five minutes.
- A local restore drill exercises database and index reconstruction from a backup fixture and must reproduce a known hybrid query result. Only an owner-run GCS restore drill can prove recovery from a retained production backup.

## Source notes

- Primary provenance: the completed user/agent grill conversation in the current Codex task, ending 2026-07-11.
- Repository evidence: current origin/main workflows and configuration inspected in weave-labs/ci, weave-labs/weavelabs.io, weave-labs/weave, and weave-labs/infrastructure.
- Product and API evidence: official Discord, OpenAI, Google Cloud, and sqlite-vec documentation consulted during the grill.
- ADRs and CONTEXT.md are intentionally skipped. This greenfield repository has one work item and decision.md is the compact source of durable design intent; separate ADRs or a glossary would duplicate it without improving recovery.
