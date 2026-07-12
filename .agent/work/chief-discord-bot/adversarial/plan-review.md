# Independent adversarial plan review

Reviewed 2026-07-11 with a read-only Claude Opus adversarial pass. The raw transport stream remains local and ignored because it is large and contains tool telemetry; this file is the durable finding and resolution record.

## Reviewer result

The reviewer reported the planning packet as blocking. Its status block said 2 critical, 6 high, 4 medium, and 4 low findings, although the body actually enumerated 2 critical, 6 high, 6 medium, and 4 low findings. The durable review therefore records findings by identifier rather than relying on the inconsistent total.

Critical findings:

- C1: Discord DAVE enforcement allegedly made pinned @discordjs/voice 0.19.2 receive unusable.
- C2: A global FIFO conflicted with immediate voice interruption and latency targets.

High findings:

- H1: The blind cached voice-suffix clip could double the suffix and create an audible seam.
- H2: The ten-dollar ceiling did not define Realtime, transcription, or hosted-tool accounting and cutoff behavior.
- H3: Raw-source retention, durable provenance, foreign keys, and forget semantics could delete memories or shared evidence.
- H4: Pre-migration backup timing and dependence on a running container created rollback data-loss windows.
- H5: Fake rollback and local restore drills overclaimed live recovery proof.
- H6: The PR WIF subject and provider condition were underspecified and incompatible with an environment-only convention.

Medium and low findings covered participant-mode boundaries, SQLite temp paths on a read-only root, budget-deferred jobs, DNS rebinding, asynchronous one-human transcripts, an early voice spike, coverage denominator gaming, Terraform lifecycle deadlock, TypeScript 7 lint compatibility, and transport event-name precision.

Original reviewer status:

    ---ADVERSARIAL_REVIEW_STATUS---
    ISSUES_FOUND: 16
    CRITICAL_COUNT: 2
    HIGH_COUNT: 6
    MEDIUM_COUNT: 4
    LOW_COUNT: 4
    CONFIDENCE: HIGH
    BLOCKING: true
    SUMMARY: Versions/models are real, but DAVE E2EE breaks the pinned voice-receive stack and the cross-medium FIFO, budget, memory-retention, and rollback models have serious unresolved gaps.
    ---END_ADVERSARIAL_REVIEW_STATUS---

## Verification and disposition

- C1 was confirmed as a real historical 0.19.0 defect but rejected as a current blocker. Discord's March 2026 notice confirms DAVE enforcement. discordjs/discord.js issue #11419 is closed by merged PR #11449, which says it fixes the receive failure; the release references identify @discordjs/voice 0.19.2 as the fix. The plan retains an early package/protocol spike and makes real DAVE receive/transmit/interruption a blocking owner-run production gate.
- C2 and H1-H6 were accepted and resolved in decision.md and execplan.md. Paid generations, rather than all event handling, are serialized; interruption and local commands are out of band. Voice suffixes use transcript deduplication plus a persisted repair clip. Budget reservations cover audio, transcription, embeddings, and per-call tools with explicit cutoff behavior. Durable memories copy provenance and survive source deletion. Deploys quiesce before a mandatory disk-based backup. Fake drills are labeled control-flow evidence. PR WIF is repository/event scoped and does not require an environment claim.
- All medium/low items were incorporated: utterance mode latching, active-turn timer suppression, writable SQLite scratch configuration, non-attempt budget deferral, pending-job retention protection, IP-pinned fetch connections, correlated pinned transcription, early voice feasibility work, explicit coverage includes, non-deadlocking Terraform protection, TypeScript/linter compatibility fallback, and transport event normalization.

Resolution status:

    ---ADVERSARIAL_REVIEW_STATUS---
    ISSUES_FOUND: 18
    CRITICAL_COUNT: 0
    HIGH_COUNT: 0
    MEDIUM_COUNT: 0
    LOW_COUNT: 0
    CONFIDENCE: HIGH
    BLOCKING: false
    SUMMARY: Every confirmed finding is resolved in the plan; the stale DAVE blocker is corrected with primary-source evidence and retained as a mandatory live acceptance gate.
    ---END_ADVERSARIAL_REVIEW_STATUS---
