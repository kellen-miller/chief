Look at this again with fresh eyes.

You are an adversarial reviewer. You are not the author, and the author may have
conflicting goals when reviewing their own work. Review the current uncommitted
working-tree diff in this repository against origin/main at a4ddbdb. This is a
read-only review: do not edit files or change external systems.

Repository:
/Users/kellen/development/github/kellen-miller/chief/.worktrees/conversation-quality

Work item:
.agent/work/improve-conversation-quality/

Read decision.md, execplan.md (especially Milestone 7), the current diff,
src/discord/invocation-policy.ts, src/app/conversation-orchestrator.ts,
src/memory/memory-service.ts, and the changed tests.

Production evidence: after PR #13 deployed, a human sent the actual bot-user
mention in `remember @Chief, no military academies`. Discord qualification
normalized it to `remember Chief, no military academies`. The explicit matcher
only understood Chief before the verb, so the general text model replied that it
would use the rule, but SQLite still contained zero durable memories. This is a
false acknowledgement and blocks acceptance.

The proposed fix adds a second grammar to the one shared matcher for imperative
`remember|correct|forget` immediately followed by normalized `Chief`. It claims
to preserve mention-only qualification, payload capture, confidence floors,
atomic mutation, deterministic receipts, and the original address-first grammar.

Challenge these criteria:

1. The exact normalized production message must reach the explicit remember
   path, frame only `no military academies`, commit before acknowledging, create
   no automatic job, and never call the general text agent.
2. Imperative correction and forget forms must capture the intended payload and
   reuse their existing semantics.
3. Questions or discussions such as `Do you remember Chief's last answer?` must
   not become mutations.
4. Ambient or disallowed Discord messages must not gain response or mutation
   authority; actual bot-user mention qualification remains mandatory.
5. Existing Chief-before-verb, sensitivity, 0.75/0.85 floors, provenance,
   automatic extraction, suffix, and budget behavior must remain intact.
6. Tests must reproduce the real cross-module failure rather than merely testing
   a regular-expression helper.
7. The living ExecPlan and metadata must accurately describe the deployed state,
   red-green evidence, remaining rollout, and branch.

If subagents are available, ask two independent subagents to compete for serious
findings, then verify and synthesize only findings that survive. Run read-only
tests or probes if useful. Report only issues that could change implementation,
validation, or release. For each, give severity, file/line evidence, impact, and
the suggested fix or next check.

End with exactly:

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: <number>
CRITICAL_COUNT: <number>
HIGH_COUNT: <number>
MEDIUM_COUNT: <number>
LOW_COUNT: <number>
CONFIDENCE: HIGH | MEDIUM | LOW
BLOCKING: true | false
SUMMARY: <one line>
---END_ADVERSARIAL_REVIEW_STATUS---
