# Manual production acceptance

Repository tests do not use paid APIs, real Discord encryption, live WIF, or GCP resources. Complete this checklist before calling Chief production-deployed.

## Discord text and commands

- An allowed-channel message without a mention receives no reply.
- Discuss a distinctive topic without mentioning Chief. Confirm there is no typing indicator, reaction, or reply, then ask for it by mention and confirm immediate retained-source recall.
- `@Chief` alone returns a local greeting; `@Chief <request>` returns one answer whose final segment ends exactly “Mr. President.”
- A mention in the middle of a sentence remains the word “Chief”; use “This list @Chief remember no military academy” and confirm Chief saves it before acknowledging.
- Have one President provide a list and constraint, then another ask “what were those outcomes?” and “pick one from the list.” Chief must use the shared prior turns and preserve the constraint.
- Current-fact research includes direct links. Prompt injection in fetched pages does not change Chief’s rules.
- DMs, threads, webhooks, bots, other channels, and other guilds are ignored.
- `/roll max:1` returns 1; normal bounds are inclusive; `/roll`, `/help`, `/join`, and `/leave` still work when AI usage is paused.
- A remembered plan can be recalled, corrected, and forgotten without exposing a memory browser.
- A sensitive remember request is truthfully rejected. An ambiguous correction asks for clarification, and a failed memory update says it was not saved.
- Restart `chief.service`, then ask a follow-up about a pre-restart turn from the last seven days. Chief must retain the thread.
- After the applicable periods close, ask separate hourly, daily, weekly, and long-term questions. Confirm the answer identifies discussion as history rather than accepted fact, preserves disagreement/corrections, and does not quote evidence labeled summary-only.
- Request a source for retained raw evidence and verify a valid configured-channel jump link. For expired raw evidence, confirm Chief states the summary-only limitation instead of inventing an exact quote or link claim.
- Edit and delete eligible messages, restart Chief, and confirm complete reconciliation updates or suppresses them without a generated reply.
- As an ordinary member, forget one authored source. Confirm another member cannot delete it. Confirm an owner/admin broad topic deletion requires a single-use confirmation, removes active raw/FTS/vector/prompt results before acknowledgement, leaves Discord untouched, and states the at-most-30-day encrypted recovery-artifact risk.

## Live DAVE voice gate

This is blocking. With Discord DAVE enabled, have two humans join the configured non-stage voice channel.

- `/join` connects Chief and both humans can hear him.
- One-human mode accepts natural conversation without saying Chief.
- Two-human mode ignores an unaddressed completed utterance and answers “Chief, …”.
- A join/leave during speech does not change that utterance’s latched mode.
- Speaking over Chief immediately stops playback; a later qualifying turn can answer.
- Receive, transmit, and interruption all work for both speakers—playback-only success is a failure.
- Completed speech ends exactly “Mr. President” without duplication. Delete the persisted suffix clip once and confirm it is regenerated and validated within budget.
- Voice research posts source links in the text channel. If this is not observed, voice research is not accepted.
- Discuss a fact in text and ask about it in voice, then discuss a fact in voice and ask about it in text. Both directions must carry the human and Chief turns.
- Chief closes a Realtime session after about 60 seconds idle and leaves Discord after about 15 minutes without a qualifying turn.

If pinned `@discordjs/voice` 0.19.2 fails DAVE receive, upgrade to a verified fixed release or disable voice; do not ship playback-only voice.

## Live performance and operations

- Before activating production, run
  `pnpm eval:conversation -- --grade-pinned-corpus` with an owner-approved paid
  budget. Save the emitted model names, UTC timestamp, and aggregate scores
  without saving prompts or private content. Acceptance requires at least 90%
  supported-claim precision, at least 90% history/memory classification
  accuracy, zero forbidden claims or suppressed-source leakage, and 100%
  validity among returned provenance IDs.

- Normal text generation is at most 10 seconds after reaching the head of the paid queue, excluding deliberate queue wait and slow research.
- First voice audio is at most 2.5 seconds after a qualifying completed turn reaches the head of the paid queue.
- PR WIF cannot authenticate a push/environment token; production WIF accepts only the exact production environment subject.
- A real GCS backup restores with matching known memory retrieval.
- `GET /healthz` remains HTTP 200 when only `diagnostics.context.degraded` is true, but returns HTTP 503 when database, Discord, disk, or maintenance critical readiness fails.
- Run `context-backfill --dry-run`, review its content-free counts/cost estimate, activate a spend-limited sample, and stop/restart or exhaust its run ceiling. Confirm `--status` and `--resume RUN_ID` continue without duplicate context or Discord writes.
- Inspect `backups/` and every current/noncurrent `forget-journal/` generation,
  verify one current backup with explicit migration 0003 mode, and confirm
  journals contain identifiers/checksum only—no deleted text or summary. In the
  drill bucket, retain two generations of one journal name and prove startup
  downloads both by generation without overwriting either local file; its
  receipt must name both generation numbers and checksums.
- A deliberately unhealthy deployment returns to the prior digest and matching
  pre-migration database within five minutes while retaining the newer recovery
  digest. Replace the database manually and confirm the normal systemd start
  still replays journals before Discord connects. Pair a current-schema
  database with an older or unlabeled target image and prove restore/startup
  refuses it before stopping the service or reading Discord secrets; pair that
  old image with its pre-migration database and prove the supported rollback
  path remains available.
- Force journal listing failure, malformed JSON, checksum mismatch, and migration-0002 replay in the approved drill environment. Each failure must stop before Discord; successful replay must remain idempotent.
- Stop the VM and confirm the uptime alert; force a watchdog and backup failure and confirm redacted email alerts.
