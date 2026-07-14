# Adversarial plan review

## Review method

- Reviewer: Claude Opus 4.8 through the authenticated claude.ai Max subscription.
- Access: read-only repository inspection; no write/edit tools were allowed.
- Round 1 session: `6c60b1db-15d8-42e7-a967-9059c01417c4`.
- Resolution review session: `a1fa0ac6-7e4a-41b2-9dfe-047f83f4d331`.
- Scope: `decision.md`, `execplan.md`, `CONTEXT.md`, ADR 0001, and the real migration, memory, usage, Discord, health, deployment, restore, infrastructure, configuration, and test paths.

The first pass used two additional internal reviewers. It found one critical, five high, nine medium, and three low issues. The planning packet was revised before the resolution review.

```text
---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 18
CRITICAL_COUNT: 1
HIGH_COUNT: 5
MEDIUM_COUNT: 9
LOW_COUNT: 3
CONFIDENCE: HIGH
BLOCKING: true
SUMMARY: Core Discord edit/delete ingestion is unbuilt (no partials/bulk/offline catch-up), and deletion-atomicity, voice retrieval, budget category enforcement, rollback verification, Chief-message identity, and backup/quality gates are underspecified or contradictory.
---END_ADVERSARIAL_REVIEW_STATUS---
```

## Resolutions

| Finding area                    | Resolution incorporated into the written packet                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord lifecycle               | Add message/channel partials, update/single-delete/bulk-delete events, high-water catch-up, and complete-pass-only full-channel deletion inference.                                                                           |
| Cross-store deletion            | Use one synchronous better-sqlite3 transaction across context and memory primitives; perform provider, budget, and journal upload work only after commit.                                                                     |
| Voice retrieval                 | Replace the durable-memory-only Realtime tool with dynamic `recall_context`, using one embedding for each committed spoken query.                                                                                             |
| Budget admission                | Select the paid queue slot before reserving, persist category/priority, protect one maximum conservative interaction, and track backfill lifetime spend across month resets.                                                  |
| Migration and FTS               | Use a nullable/backfill/rebuild migration, contentless-delete FTS verified against bundled SQLite, and an exact Temporal polyfill version with DST tests.                                                                     |
| Chief reply identity            | Record one source row per delivered Discord chunk snowflake under a shared logical response ID; group at prompt assembly and deduplicate live/reconciliation/backfill by snowflake.                                           |
| Health and restore verification | Separate critical readiness from context diagnostics and make restore verification schema-aware instead of hard-coding migration 0002.                                                                                        |
| Backup resurrection             | Add a content-free journal outbox and GCS objects, replay all retained journals idempotently on every host start, fail closed on uncertainty, and retain a recovery image capable of replaying into migration 0002 or 0003.   |
| Local recovery copies           | Restrict `pre-deploy` and `.failed.*` databases to mode 0600, prune them after at most 30 days, and prohibit use without the same journal preflight.                                                                          |
| Retrieval freshness             | Search source-event FTS synchronously and return it as source evidence distinct from rollups, including messages outside the newest 30 recent rows.                                                                           |
| Covered safety logic            | Put complete-scan deletion inference and delivered-reply recording in covered services outside the excluded gateway adapter.                                                                                                  |
| Quality and retention           | Require at least 40 deterministic replay cases, zero forbidden or suppressed leakage, valid provenance IDs, paid preproduction quality thresholds, per-row recent retention tests, and 80% coverage for new included modules. |

The review suggestion to add the privileged Discord `GuildMembers` intent was not adopted. Current `guild.ownerId` and the requesting message member's `Administrator` permission are sufficient for live authorization; missing permission data fails closed. The cross-month usage concern was addressed through persisted occurrence-month attribution plus a separate monotonic backfill-run ledger rather than changing the monthly ceiling's UTC semantics.

## Resolution review

The second pass re-read the revised artifacts and verified their claims against the repository. It confirmed that the prior critical/high blockers were genuinely resolved. It reported two medium recovery-boundary gaps and two low identity/coverage seams; all four are incorporated in improvement pass 5 above.

```text
---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 4
CRITICAL_COUNT: 0
HIGH_COUNT: 0
MEDIUM_COUNT: 2
LOW_COUNT: 2
CONFIDENCE: HIGH
BLOCKING: false
SUMMARY: Prior blockers are genuinely resolved and repo-consistent; residual medium gaps are startup journal-replay airtightness/GCS coupling and local pre-deploy/.failed.* forgotten-byte persistence.
---END_ADVERSARIAL_REVIEW_STATUS---
```

## Conclusion

The planning review is nonblocking with zero critical or high findings. The final packet resolves the remaining medium and low issues explicitly. Implementation remains blocked only on the user's approval of this updated written packet.
