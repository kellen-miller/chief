# Task 4 report: assemble bounded retrieval context

## Status

Complete.

## Delivered

- Added one `ContextAssembler` for text and Realtime retrieval. Each query is
  embedded once and the same vector is used for active durable memory and every
  active rollup tier.
- Added paid-call-free source FTS retrieval behind `ConversationStore`, with a
  strict current-event boundary, chronological recent context, Chief reply
  chunk grouping, source/recent deduplication, and source recency adjustment.
- Added per-tier lexical/vector normalization, tier-local recency adjustment,
  a relevance distance threshold, stop-word handling, lineage and normalized
  statement deduplication, and conflict preservation.
- Added an 8,000 approximate-token recent-plus-history budget, a maximum of 30
  recent events, up to 6,000 recent tokens, fixed per-tier history shares, and
  deterministic truncation of oversized evidence. Durable memory remains
  separately limited to six accepted items.
- Added guild/channel-scoped recursive lineage checks before rollup ranking and
  limiting. Empty or out-of-scope lineage is rejected, so old-channel material
  cannot be returned or crowd the configured channel's nearest neighbors.
- Added real Discord jump links, a maximum of three representative rollup
  links, configured-timezone labels, source-backed/summary-only provenance,
  and suppression of Discord-deleted or locally-forgotten links.
- Added one shared structured payload serializer for text and voice. Recent
  conversation, historical discussion, communal memory, and current request
  remain separate, labeled untrusted, and use sanitized display labels.
- Replaced static Realtime memory recall with dynamic `recall_context`.
  Recall is unavailable before a committed utterance, coalesces parallel calls,
  permits one successful call per utterance, resets on the next commit, and
  discards stale results and side effects from an older utterance.
- Preserved local greeting/observation silence, paid-work admission, explicit
  memory mutation, current lost-thread behavior, text/voice suffix rules, and
  provider source-ID validation.
- Extended `context-prepared` telemetry with only bounded counts, approximate
  tokens, and degradation state. No prompt, content, identity, topic, link, or
  provider payload is emitted.

## TDD evidence

The implementation followed RED-GREEN cycles with focused local tests:

- Missing `ContextAssembler` module, then one-embedding retrieval across source,
  durable memory, hourly, daily, weekly, and long-term tiers.
- Oversized relevant history was omitted, then deterministically truncated
  inside the fixed tier and total budgets.
- Older duplicate evidence won, then exact duplicate statements preferred the
  newer item within a tier.
- Invalid and suppressed Discord identities leaked links, then link validation,
  deletion/forget filtering, and summary-only retention behavior passed.
- Stop-word-only and lexically irrelevant prompts forced history, then vector-only
  fallback and relevance filtering passed without forcing tier results.
- Text omitted historical context and the orchestrator bypassed the assembler,
  then shared structured context and one assembler call per paid request passed.
- Realtime used static memory recall, then dynamic once-per-commit context recall,
  text/voice parity, citation propagation, and next-utterance reset passed.
- The current text event leaked through source FTS, then the strict source
  boundary and grouped-response boundary passed.
- Differently worded rollups repeated recent lineage, then recent event IDs
  seeded historical lineage deduplication.
- Twenty-four exact hourly vectors starved a relevant weekly vector, then
  tier-filtered scalar distance queries returned both tiers correctly.
- Parallel Realtime calls embedded twice, then the per-utterance in-flight gate
  coalesced them. An older call could later mutate the next turn, then stale
  result, citation, usage, and persistence side effects were discarded.
- Another channel's rollup was returned with empty local lineage, then recursive
  guild/channel candidate scoping and empty-lineage rejection passed.
- A recent-history database failure became a generic error, then the common
  context persistence error restored text and voice lost-thread behavior.
- Twenty-four recent FTS hits filled the source limit before deduplication and
  hid the first historical source, then recent event/response exclusions moved
  into the query before its limit.
- A later rollup appeared in an earlier replay turn, then recursive candidate
  lineage required every contributing event ID to precede `beforeEventId`.
- Multiple recent rows underfilled the 6,000-token recent budget when the next
  older row was oversized, then that row was truncated into the remaining
  allowance. The regression now proves at least 4,000 recent tokens remain
  available when the retained content can supply them.
- Twenty-five matching Chief chunks consumed the raw source FTS limit and hid
  another relevant response, then source matches were paged, grouped, relevance
  checked, and limited in that order.
- A common term in an OR query admitted unrelated source and rollup evidence,
  then lexical candidates required both majority overlap and at least two
  distinct meaningful terms for multi-term prompts. Single named-term and
  valid lexical-only evidence remain supported.
- Realtime trusted its instruction prompt to prevent greeting and one-character
  recall calls, then a deterministic pre-assembler guard rejected both while a
  short topical query on the same committed utterance still succeeded.

No test makes a paid provider call. Embeddings, provider responses, clocks, and
the retrieval corpus are deterministic and local.

## Surprises and discoveries

- sqlite-vec's `MATCH ... k = 24` chose the global nearest 24 rows before the
  joined tier predicate. A busy hourly tier could therefore starve weekly or
  long-term retrieval. Tier-filtered `vec_distance_L2` queries restored the
  required per-tier behavior. A deterministic 25-document regression proves
  the formerly starved weekly result is returned.
- Dynamic Realtime tools can overlap across both the same utterance and a newly
  committed utterance. Capturing the utterance number is insufficient unless
  every shared-state side effect is also conditioned on that utterance still
  being current.
- Candidate channel isolation must happen before nearest-neighbor limiting.
  Filtering only when links are assembled is too late because out-of-scope
  candidates can both leak summaries and crowd valid candidates.
- Point-in-time and deduplication predicates must also happen before candidate
  limits. Applying either after top-k selection can hide valid older evidence
  or admit later evidence into an earlier turn.
- The deterministic milestone replay issued eight retrieval queries. All eight
  passed their required horizon/provenance/conflict/dedupe/empty-index checks,
  with zero cross-channel leakage. The oversized prompt fixture stayed at or
  below 8,000 approximate recent-plus-history tokens, retained at least 4,000
  approximate recent tokens, and truncated relevant history rather than
  dropping it. This supports retaining the initial fixed allocation.
- Retrieval-intent words should not become relevance requirements. The full
  replay exposed `source` in "Show the SourceBeacon source" as metadata rather
  than a topic term, so it joined the lexical stop-word set while the named
  beacon remained eligible.

## Verification

`pnpm verify` passed:

- Prettier, ESLint, and TypeScript checks passed.
- 40 test files passed with 328 tests.
- Coverage: 91.07% statements, 83.42% branches, 92.96% functions, and 92.69%
  lines.
- `ContextAssembler`: 98.71% statements, 88.09% branches, and 100% functions
  and lines.
- The production TypeScript build passed.

Focused Task 4 verification also passed with 78 unit tests and two integration
replays. Post-review verification passed 22 focused unit tests and 12 focused
integration tests. `git diff --check` passed before the final commit.

## Independent review response

The independent and standards reviews found no Critical issue. Their
substantiated Important findings were reproduced and resolved:

1. Source FTS and Chief chunk expansion now enforce the strict event boundary
   through `ConversationStore`.
2. Vector search is truly per tier and cannot be starved by another tier's
   global top-k rows.
3. Rollup candidates require recursive lineage in the configured guild and
   channel before ranking or limiting.
4. Same-utterance and cross-utterance Realtime races are coalesced or discarded
   without stale citations, cost, or persistence state.
5. Recent-history persistence failure retains lost-thread behavior through a
   correctly named shared persistence error.
6. Text and voice use one structured context serializer, eliminating payload
   drift while preserving display-label sanitization.
7. The deterministic replay now covers source, hourly, daily, weekly,
   long-term, summary-only, conflicts, mixed-tier deduplication, and no-index
   behavior.
8. Source FTS excludes recent events and response groups before its bounded
   limit, so recent matches cannot starve retained historical evidence.
9. Rollup candidate lineage is point-in-time safe: every contributing event
   must precede the current event boundary.
10. Recent selection truncates any next oversized row into the remaining
    budget, not only the first selected row, preserving the intended recent
    context floor when content is available.
11. Source FTS limits apply after Chief logical-response grouping and lexical
    relevance checks, so one multi-chunk response cannot crowd out distinct
    candidates.
12. Lexical source and rollup candidates pass an absolute distinct-term overlap
    gate before ranking; vector candidates still use their independent distance
    threshold, and valid lexical-only evidence remains retrievable.
13. Realtime recall rejects committed greeting and one-character noise before
    claiming the per-utterance recall slot, preserving a subsequent short
    topical request on that utterance.

## Concerns

No known blocker. Tier-filtered scalar vector distance favors correctness and
privacy with the current local SQLite scale. Retrieval latency should be
measured as the index grows; a future schema migration could add a partitioned
vector index without changing the assembler contract.
