# Adversarial Re-Review — Chief Discord Bot

The reviewer inspected the uncommitted tree, ran two independent subreviews, executed the Terraform policy against crafted plans, reran coverage, and checked the Realtime SDK option placement. The original backup, pre-migration snapshot, conservative reservation, tracing, addressing, forget, suffix, chunking, backup IAM, and sqlite-vec findings were verified as fixed. The Realtime `providerData.max_output_tokens` placement was also verified as correct.

## High

1. `scripts/check-terraform-plan.sh` enumerated only `*_iam_member` resources. Crafted `google_project_iam_binding` and `google_project_iam_policy` resources granting `roles/owner` passed, while an equivalent member resource was denied. Because the apply service account is intentionally broad and deployment follows a merge automatically, authoritative binding and policy resources must be denied unconditionally.
2. The 90-second voice-turn timer began only after `openVoice()` resolved. A stalled Realtime WebSocket connection could therefore keep the paid-operation FIFO locked forever. Session opening needs its own deadline and a regression test proving later text work proceeds.

## Medium

1. Transcription had no application or SDK timeout and could hold the same FIFO for the provider's retry window.
2. Although global coverage passed, voice provider boundaries remained lightly covered. Add direct tests for Realtime output configuration and the three-search accounting path.
3. `scripts/restore-drill.sh` mounted a 0750 directory owned by the invoking user into a uid-1000 container, making the drill unreadable for other host UIDs.

## Low

1. A missing backup container exited from an `if` branch without triggering the ERR trap, so it did not emit `chief_backup_failed`.
2. Reservations are deliberately conservative but do not abort an active provider response at the precise reservation boundary. This is an accepted low residual risk because hard output, input, tool, and time bounds constrain practical overshoot.

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 7
CRITICAL_COUNT: 0
HIGH_COUNT: 2
MEDIUM_COUNT: 3
LOW_COUNT: 2
CONFIDENCE: HIGH
BLOCKING: true
SUMMARY: IAM binding and policy resources bypass the plan gate, and an untimed Realtime connection can permanently lock the shared paid-operation FIFO.
---END_ADVERSARIAL_REVIEW_STATUS---
