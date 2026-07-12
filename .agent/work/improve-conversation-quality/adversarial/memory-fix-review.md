# Explicit-memory follow-up adversarial review

Reviewed commit `34837f7` against `origin/main` with Claude Opus 4.8 in streamed
adversarial mode. Two independent review passes were consolidated and every
material claim was checked against the code and focused tests.

The initial verdict was blocking: zero critical, two high, two medium, and one
low finding. The high findings were that the new framing truncated multiline
requests before Chief acknowledged them, and that the security-relevant prompt
change had no real-model evaluation on `gpt-5.4-nano`. The medium findings were
that the shared prompt changed automatic/correction behavior and that separator
and stopword edge cases produced malformed payloads. The low finding noted that
corrections remained outside the calibrated remember path.

The follow-up implementation resolves the blocking findings by preserving
multiline content, stripping request separators, rejecting empty payloads,
retaining meaningful same-message referents, isolating the calibrated prompt to
the remember intent, and extending the paid aggregate evaluation with three
harmless-preference and three synthetic-credential trials on the configured
memory model. A focused adversarial re-review is required before publication.

The first focused re-review verified prompt isolation, floors, provenance, the
paid evaluation, and commit-before-acknowledgement. It remained blocking with one
high, one medium, and one low finding: stripping a leading `that` lost natural
back-references, the referent vocabulary omitted `both` and counted groups, and
the empty test missed punctuation. The second repair preserves those referents,
short-circuits syntactically empty requests before extraction, and adds red-green
coverage for every reproduced form.

The final focused re-review verified all prior critical, high, and medium findings
resolved. It reported one non-blocking low gap: bare plural/group references such
as `remember both` or `remember the two cities` without same-message context still
reached the paid model. Four additional tests were observed red, then passed after
the parser learned to short-circuit those unresolved references. The completed
focused suites pass twenty integration and four unit tests, with typechecking and
linting clean.

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 1
CRITICAL_COUNT: 0
HIGH_COUNT: 0
MEDIUM_COUNT: 0
LOW_COUNT: 1
CONFIDENCE: HIGH
BLOCKING: false
SUMMARY: Final external review found all blockers resolved; its one low unresolved-reference gap was fixed afterward with red-green coverage.
---END_ADVERSARIAL_REVIEW_STATUS---
