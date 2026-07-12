# Independent adversarial planning review

The independent Claude CLI review verified the baseline, migration shape,
Realtime SDK history mechanism, CI isolation, and deploy rollback path, then
raised these actionable findings. Raw CLI output and account metadata are
intentionally excluded from version control; this file preserves the durable
findings and status.

1. **High:** a 24-hour in-process maintenance timer can be starved by restarts,
   so seven-day retention requires a startup sweep and health state based on a
   successful sweep.
2. **High:** expiry and newest-before-ID retrieval need separate indexes.
3. **High:** explicit multi-proposal memory needs one concrete atomic batch
   transaction; the current per-proposal transactions can partially commit.
4. **High:** explicit-memory confidence semantics were ambiguous. The current
   separate `0.75` explicit floor must be either preserved deliberately or
   removed deliberately and tested at its boundary.
5. **Medium:** deleting `memory-worker.ts` also requires moving types imported
   by `openai-memory.ts` and rewiring every importer.
6. **Medium:** the plan named the transitive package instead of the production
   import path `@openai/agents/realtime`.
7. **Medium:** the human Realtime transcript arrives in a separate event, not
   in the existing `completed` event, and can race assistant completion.
8. **Medium:** Discord arrival ordering depends on a synchronous record before
   the first `await`; this must be a tested invariant.
9. **Medium:** the ordered migration runner must preserve lazy creation of the
   bookkeeping table and the deployed `0001` checksum and behavior.
10. **Low/medium:** wait for Realtime session creation and seeded-history
    acknowledgement before exposing the session as ready.
11. **Low:** never send Discord IDs to the provider; sanitize display labels and
    test hostile prior content and display names as untrusted data.
12. **Low:** prior-image rollback after a successful schema deployment is safe
    only when paired with the verified pre-deploy database backup.

All verified findings are resolved in `decision.md` and `execplan.md` before
implementation. The review's earlier statement that the current worker holds
SQLite transactions across remote calls was rejected: the code already avoids
that. The real improvement is atomicity across a prepared proposal batch.

---ADVERSARIAL_REVIEW_STATUS---
status: revisions_required
critical: 0
high: 4
medium: 6
low: 2
---END_ADVERSARIAL_REVIEW_STATUS---
