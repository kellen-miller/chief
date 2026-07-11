Verification complete. All load-bearing findings are confirmed by direct file inspection. Here is my adversarial review.

---

# Adversarial Review — Chief Discord Bot

**Method.** Two independent subagents (filesystem + web) plus my own pass over every high-risk file. Every finding below was verified by reading the actual uncommitted files (not `git diff`); the infra permission finding was traced through the exact ownership/uid chain. Findings the plan already worried about and that are genuinely handled (SSRF core, WIF subject conditions, CI SHA-pinning/`persist-credentials:false`, health loopback+no-secret body, durable-disk `prevent_destroy`, no secrets in state/image) are **not** re-listed except where a real defect remains.

The specific claim I was asked to verify — "application-owned six-tool/three-search budget, a 90-second abort signal, a 1,200-token output cap, and focused tests" — is **half true**: the caps exist in code (`openai-chief-agent.ts:191-192,199,255-258`) for the **text** path only. They are **absent on the voice path**, and the enforcement code is **excluded from coverage and not exercised by any test** (Findings 3 and 5).

---

## CRITICAL

### C1 — Backups are unwritable in production: root-owned dirs vs the uid-1000 container → silent backup failure + every post-first deploy aborts

**Artifact:** `infra/app/templates/startup.sh.tftpl:37`, `scripts/deploy.sh:28,34-36`, `Dockerfile:29`, `.github/workflows/deploy.yml:89`

**Evidence.** The container runs as `USER node` (uid 1000) — `Dockerfile:29` — and **no** `docker run`/`docker exec` that performs a backup passes `--user` (grep confirmed). The two backup destination dirs are created by **root, mode 0750, after** the data root is handed to uid 1000:

- `startup.sh.tftpl:27` `chown 1000:1000 /var/lib/chief`, then `:37` `install -d -m 0750 … /var/lib/chief/backups` → `backups` is `root:root 0750`.
- `deploy.sh:28` `install -d -m 0750 "$BACKUP_DIR"` (`/var/lib/chief/pre-deploy`), run under `sudo` (`deploy.yml:89`) → `root:root 0750`.

The writers run as uid 1000: nightly `docker exec chief node dist/cli.js backup --destination /var/lib/chief/backups` (`startup.sh.tftpl:81`); pre-deploy `docker run … "$CANDIDATE_IMAGE" backup --destination "$BACKUP_DIR"` (`deploy.sh:34-36`). `cli.ts:48` `mkdir(dir,{recursive:true})` is a no-op on the existing root dir, then `SqliteMemoryStore.backup()` tries to **create** the `.db` file inside it. Mode `0750` on a `root:root` dir gives uid 1000 ("other") no bits → **EACCES**.

**Why it matters.** (a) Nightly backups can never write, and `chief_backup_failed` is only logged when `docker inspect` fails (`startup.sh.tftpl:77-79`), **not** when the backup command fails — so the alert is silent and production runs with zero backups. (b) Once `chief.db` exists (i.e., every deploy after the first), `deploy.sh:33-36` runs the pre-deploy backup, which EACCES-fails → `set -e`/ERR trap → `rollback` with `MIGRATED=false` → deploy aborts back to the prior image. **Deploys break after the first one.** The fake-docker integration test (`test/integration/deploy-script.test.ts`) can't catch this because it ignores uid/permissions.

**Fix / next check.** `chown 1000:1000` (or 0770 + shared gid) on `/var/lib/chief/backups` and `$BACKUP_DIR`, or simply **remove them from the root `install -d`** and let `cli.ts`'s `mkdir` create them under the uid-1000-owned parent. Verify: `docker run --user node … backup` into a `root:root 0750` dir.

---

## HIGH

### H1 — "Pre-migration" backup is actually taken _after_ migration; rollback cannot recover pre-migration state

**Artifact:** `src/cli.ts:44-46`, `scripts/deploy.sh:33-39,45-51,71-73`; contradicts `decision.md:96`

**Evidence.** `cli.ts` `case 'backup'` calls `migrateChiefDatabase(database)` (`:46`) **before** `SqliteMemoryStore.backup()` (`:53`). `deploy.sh:34-36` takes the "mandatory pre-migration backup" by running that `backup` command **with the candidate image**, so it migrates the live `$DATABASE` in place and then snapshots the already-migrated DB. `rollback()` (`deploy.sh:45-51`) restores that post-migration snapshot and restarts the **old** image. `decision.md:96` requires "create and verify a definitive backup from any existing database … **then migrate**."

**Why it matters.** For any future schema-changing migration, the original pre-migration DB is overwritten in place with no separate copy, and rollback leaves the old image running against the new schema. The migration-rollback guarantee is defeated. Latent today only because the sole migration `0001_initial` is checksum-gated and no-ops on an existing DB (`database.ts:102-107`) — it bites the moment a second migration lands.

**Fix / next check.** Add a raw `backup` path that does **not** migrate, or in `deploy.sh` take the backup with the **previous** image before pulling/migrating the candidate.

### H2 — No 90-second/abort bound on the voice path, and the orchestrator awaits a Realtime terminal event with no timeout → a stuck voice turn deadlocks the entire paid-generation FIFO

**Artifact:** `src/app/conversation-orchestrator.ts:136-206`, `src/agent/openai-voice.ts:260,351-359`; contradicts `decision.md:35`

**Evidence.** `handleVoice` enqueues an op that does `const completed = await result` (`:192`); `result` resolves **only** on `completed`/`interrupted`/`error` events (`:172-185`). `completed` is bound solely to `session.on('audio_stopped')` (`openai-voice.ts:260`). There is **no timeout** wrapping the voice turn, and — unlike the text path (`openai-chief-agent.ts:192` `AbortSignal.timeout(90_000)`) — the voice research tool's `client.responses.create` is called with **no `signal`** and **no `max_output_tokens`** (`openai-voice.ts:354-359`). The `#voiceIdleTimer` is scheduled only _after_ `await result` (`:193`), so it can't fire while waiting.

**Why it matters.** A voice turn that ends without an `audio_stopped` event (tool-only/refusal/empty response), a hung `web_search` sub-call (no signal), or a silent WebSocket drop leaves `result` unresolved forever. `#enqueue` never releases, so **all subsequent paid generations — text and voice — are blocked indefinitely.** Also independently violates the "at most ninety seconds per request" contract for voice.

**Fix / next check.** Wrap the voice turn in a hard timeout that force-finishes/closes the session; pass a 90-second `AbortSignal` to the voice research call; bind completion to the response-done transport event as well as `audio_stopped`.

### H3 — Flat, non-conservative reservations with no per-response spend cap → the $10 monthly ceiling can be overshot

**Artifact:** `src/app/conversation-orchestrator.ts:59,105,127`; `src/usage/usage-budget.ts:68-73,87-101`; `src/agent/openai-voice.ts:354-359`; `src/agent/openai-chief-agent.ts:242`; contradicts `decision.md:80-81`

**Evidence.** Every reservation is a hardcoded constant — `text-response 0.25`, `voice-response 0.25`, `voice-transcription 0.05`, `memory-extraction 0.05` — independent of request size. `reconcile()` then adds the **actual** to `#actualUsd` (`usage-budget.ts:98`) with no clamp to the reservation. The reserve-time check (`:68-73`) only guards the _estimate_. But actual can far exceed $0.25: the fetch tool returns up to 200 KB per call (`openai-chief-agent.ts:242`), re-billed as input tokens across up to 7 agent turns; the **voice** research call has no `max_output_tokens` cap (`openai-voice.ts:354-359`). `decision.md:81` explicitly promises "An active response cannot exceed its reservation" — nothing implements that.

**Why it matters.** With `#actualUsd` at, say, \$9.70, a \$0.25 reservation is allowed; if that heavy turn actually costs \$1.00, the month lands at \$10.70. Multiple queued reservations compound the overshoot. The headline "$10 UTC-month budget… conservative reservations" control is breachable post-hoc.

**Fix / next check.** Size reservations to a real worst case (tool budget × max fetch/search × turns × price) and/or enforce a hard token/time cutoff that aborts the in-flight generation when its reservation is exhausted.

### H4 — Coverage denominator gaming: the SSRF fetch execution path and the OpenAI tool/limit wiring are excluded from coverage _and_ untested

**Artifact:** `vitest.config.ts:6-18`; contradicts `execplan.md:143`

**Evidence.** `coverage.exclude` lists `src/web/safe-fetch.ts`, `src/agent/openai-chief-agent.ts`, `src/agent/openai-voice.ts`, `src/memory/openai-memory.ts` — all substantial security/billing logic, not "type-only files and composition entrypoints" as `execplan.md:143` restricts. Subagent grep confirms no test executes `safeFetchText`/`fetchResolved`/the redirect+bytecap+peer-check path, nor `createExecution` (which wires the 6-tool/3-search budget, the 90 s signal, and `maxTokens:1200`). The only "focused tests" cover `ToolCallBudget` (the counter) in isolation and `answerText` with a mocked `execute`.

**Why it matters.** The 80% threshold is computed over a denominator that omits the security-critical SSRF guard and the exact cap-enforcement code this review was told to verify. CI is green while the enforcement paths have zero executed coverage.

**Fix / next check.** Remove those four files from `exclude`; add an integration test driving `createExecution` past 3 searches / 6 calls and a local-server `safeFetchText` test for redirect + byte cap + content-type + peer mismatch.

---

## MEDIUM

### M1 — OpenAI Agents tracing is enabled; prompts and voice transcripts export to OpenAI's trace store

**Artifact:** `src/agent/openai-voice.ts:156,193`; no global disable anywhere in `src/`; contradicts `decision.md:98`

**Evidence.** Both `RealtimeSession`s set `tracingDisabled: false` (explicitly enabling export). The text path calls `setDefaultOpenAIKey` (`openai-chief-agent.ts:188`) and `run()` with no tracing disable; nothing in `runtime.ts` calls `setTracingDisabled(true)` or sets the disable env. With the SDK's default exporter on, prompts, tool IO, and voice transcript deltas are uploaded to OpenAI's platform trace dashboard — directly against `decision.md:98` ("Redact prompts, source messages, transcripts, tokens") and the "retain no audio / 7-day transcript" posture.

**Fix / next check.** `setTracingDisabled(true)` globally and `tracingDisabled: true` on both sessions; assert in a test.

### M2 — Group-voice addressing over-matches "chief" anywhere and mangles the prompt

**Artifact:** `src/voice/addressing.ts:20-22`; contradicts `decision.md:17`

**Evidence.** In group mode, `qualifyVoiceTranscript` treats the turn as addressed if `/\bchief\b/iu` appears **anywhere** and strips the first match. "The fire **chief** said…" or "**chief** among my concerns…" qualifies and becomes "the fire said…". `decision.md:17` requires addressing "at the start, end, or another unambiguous position."

**Why it matters.** False triggers make Chief answer un-addressed group chatter (extra paid Realtime turns) and garble the prompt.

**Fix / next check.** Require "chief" at an utterance boundary (leading/trailing token, optionally vocative punctuation); test the "fire chief" negative.

### M3 — Terraform protected-resource policy ignores IAM changes while the apply SA holds project-wide admin roles

**Artifact:** `scripts/check-terraform-plan.sh:7-15`; `infra/bootstrap/main.tf:154-165`; `.github/workflows/deploy.yml:41`

**Evidence.** The policy only flags `delete` actions on 4 resource types; it does not inspect IAM `create`/`update`. The apply SA (`chief-tf-apply`, used on every push to main with **no manual approval**) is granted `roles/resourcemanager.projectIamAdmin`, `roles/storage.admin`, `roles/secretmanager.admin`, `roles/compute.admin` (`main.tf:154-165`).

**Why it matters.** A merged commit can add a `google_project_iam_member` self-granting a wide role to any principal and the policy passes; `storage.admin` also permits API-level deletion of objects in the state/backup buckets (the `prevent_destroy` lifecycle only protects the bucket _resource_). Branch protection (1 review) is the only gate between a bad merge and project takeover.

**Fix / next check.** Have the policy reject unreviewed IAM `create`/`update`; scope apply to `iam.securityAdmin` on the runtime SA + bucket-scoped admin instead of project-wide `projectIamAdmin`/`storage.admin`.

### M4 — Natural-language "Chief, forget X" permanently deletes the top-3 lexical matches

**Artifact:** `src/memory/memory-worker.ts:84-93`; contradicts `decision.md:64`

**Evidence.** On a forget request, the worker runs `findLexical(forget[1], 3)` and calls `store.forget()` on **each** of up to three matches — an unconditional, permanent delete of memories + FTS + vec rows (`memory-store.ts:245-278`). `decision.md:64` says a forget "permanently delete[s] the matching durable memory."

**Why it matters.** "Chief, forget that Alice moved to Denver" can also delete "Bob visited Denver" and "the Denver trip is planned" — irreversible communal-memory data loss on token overlap, with no confidence/precision gate.

**Fix / next check.** Delete only the single best, sufficiently-scored match (or require model confirmation of the target id) before forgetting.

### M5 — Text suffix enforcement isn't robust to a model-supplied honorific with punctuation (double "Mr. President")

**Artifact:** `src/replies/suffix.ts:3-7` vs `src/voice/voice-suffix.ts:1`

**Evidence.** `ensureTextSuffix` gates on `trimmed.endsWith('Mr. President')` (no trailing punctuation). Output ending "…Mr. President." or "…!" fails the check and gets a second honorific appended → "…Mr. President. Mr. President". The voice enforcer already tolerates this via `/\bMr\. President[.!?]?$/u`; the text path is the inconsistent one. `reply-suffix.test.ts` never covers it.

**Why it matters.** The application is the sole enforcer of an exact user-facing invariant; enforcement that breaks when the model happens to include the honorific defeats the point. (Lower likelihood for text since the model is told not to add it, but the enforcement layer should be robust.)

**Fix / next check.** Strip a trailing `Mr\. President[.!?]*` before appending (mirror the voice regex); add a test with model output ending "…, Mr. President.".

---

## LOW

### L1 — `chunkReply` can emit a >2000-char chunk for a single long token, so long-URL answers fail to send (and lose the suffix)

`src/replies/suffix.ts:29-38` never splits an oversized whitespace-token; a long source URL yields a chunk >2000 chars → Discord rejects it → `for (const chunk of chunkReply(...)) await delivery.reply(chunk)` (`text-controller.ts:83-84`) throws before the final suffixed chunk sends. Also flattens the `\n\nSources:` block to inline spaces. Fix: hard-split tokens longer than `maximumLength`.

### L2 — Runtime (bot) SA has `storage.objectAdmin` on the backup bucket

`infra/app/main.tf:129-131` grants the most network-exposed identity delete/overwrite on every backup object; least privilege is `objectCreator` (+`objectViewer`). A compromised bot could wipe the (already 30-day-lifecycled) backups.

### L3 — Memory extraction isn't atomic across proposals + `completeJob`

`memory-worker.ts:99-152` applies each proposal (paid `embed` + `applyMemory`) individually, then `completeJob`. A failure mid-list (`:153`) → `retryJob` re-runs the **whole** job, re-embedding (paid) and re-creating already-applied memories → transient duplicate durable memories until nightly exact-dup consolidation, plus double embedding spend. Fix: wrap proposals+completeJob in one transaction, or make application idempotent per proposal.

### L4 — Crash between `reserve` and `reconcile` leaves a permanent phantom reservation

`usage-budget.ts:160-168` reloads ledger rows with `actualUsd === null` as outstanding reservations on startup; nothing ever cancels a reservation whose operation died. Repeated crashes accumulate phantom holds that consume the month's headroom and can falsely pause AI (fail-safe direction, but an availability bug). Fix: expire/cancel stale unreconciled reservations on load.

### L5 — `vec_version()` pin not asserted at startup

`database.ts:84-93` loads sqlite-vec but never checks `vec_version() === 'v0.1.9'` at open/migrate time; the assertion lives only in the health check (`runtime.ts:239`) and `verify-restore`. `decision.md:73` requires verifying it "during startup." A version drift isn't caught until the health/deploy gate rather than fail-fast at boot.

---

Two minor items observed and judged **not** worth a finding: the budget month-boundary reconcile drops a cross-month actual from both in-memory totals (under-counts, safe direction — `usage-budget.ts:97`); and `MIGRATION_CHECKSUM` is a manual version string, not a content hash (process risk only, greenfield). Several plan worries are genuinely handled well: SSRF core (multi-record rejection, IP-pinned connect + peer verification, redirect revalidation), WIF exact-subject conditions, CI SHA-pinning + `persist-credentials:false` + `pull_request` (not `_target`), fail-closed allowlist validation (`gateway.ts:75,195-207`), WAL-safe online backup, and durable-disk `prevent_destroy`.

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 15
CRITICAL_COUNT: 1
HIGH_COUNT: 4
MEDIUM_COUNT: 5
LOW_COUNT: 5
CONFIDENCE: HIGH
BLOCKING: true
SUMMARY: Backups are unwritable in prod (root-owned dirs vs uid-1000) breaking durability and post-first deploys; plus post-migration "pre-migration" backup, an untimed voice path that can deadlock the paid queue, non-conservative reservations that can overshoot the $10 ceiling, and coverage that excludes the untested SSRF/limit-enforcement code.
---END_ADVERSARIAL_REVIEW_STATUS---
