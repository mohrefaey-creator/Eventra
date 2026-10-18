# 02 · Architecture decisions (prototype)

Each decision names what the real build must revisit.

**ADR-001 · Stand-alone synthetic prototype.** No NextMind repo exists in the workspace (see `00`). Built as a self-contained
folder whose layout mirrors spec §13. *Revisit:* WP-00 once the real repo is available.

**ADR-002 · Zero-dependency Node + JSON store.** `node:http` server, one JSON document, atomic file writes, all-or-nothing
transactions (snapshot + restore on error). Chosen so the app runs with one command. Collections mirror §7 tables.
*Revisit:* PostgreSQL, row-level security, real transactions, encryption at rest.

**ADR-003 · Identity, consent and journey are stand-ins.** The spec forbids a parallel auth/consent/profile stack in the
real module. Here they are isolated behind `/identity-stub`, `server/policy.js` and `journeySubscriber`, so replacing them
changes one place each.

**ADR-004 · Scoring and matching live in a pure `domain/` package.** No I/O; same input gives a byte-identical output.
Every `score_run` stores `input_hash` and `execution_hash` (SHA-256 of canonical JSON). Replay recomputes from the sealed
answers and compares (AC-09). Scores are never recomputed in place; revisions would create new runs (§5.1.5).

**ADR-005 · Three axes, no composite.** Interest fit, capability readiness and admission eligibility are separate fields
end-to-end (data, API, UI, report). The §5.4 composite uses placeholder weights and requires *demonstrated skills*, which
cannot exist while aptitude is on hold, so `composite_fit` is always `incomplete` and is never displayed.

**ADR-006 · Interest similarity = centred cosine, mapped to [0, 1].** Subtract each profile's own mean before the cosine,
so a student who likes everything does not match everything; a flat profile yields `insufficient_data` instead of a number.
The value is labelled a *similarity index*, never a probability. *Revisit:* needs an expert-reviewed, empirically sourced
program profile model (D-04).

**ADR-007 · Strict alignment, no silent renormalization.** Subject, value and skills alignment need every weighted input;
otherwise the component is `incomplete` and lists what is missing (§5.4).

**ADR-008 · The advisor is a deterministic explainer.** It builds structured message keys from stored results; the client
renders them in either language, so numbers and caveats are identical in both. It abstains when no verified source exists
(AC-10). No model is called, so no student data leaves the machine (§6.2). *Revisit:* the tool contract
(`get_student_discovery_summary`) is already shaped for a bounded LLM later.

**ADR-009 · Audit.** Append-only, hash-chained (`prev_hash`, `hash`), no answer text or evidence values (only hashes and ids).
Denials are written **after** the failed transaction rolls back (otherwise rollback would erase them). Counselor reads of
sensitive data are audited with a stated purpose.

**ADR-010 · Consent model.** Per scope, per party (student, guardian). A scope is active only if every *required* party's latest
record is "granted". `assessment_processing` needs the guardian too while the student is under a placeholder age (18).
Withdrawal suspends in-progress sessions, revokes shares, queues a retention decision (not an automatic deletion), and keeps
the student's own read access. *Revisit:* legal basis, age rule and retention are open decisions (D-05).

**ADR-011 · Four-eyes.** Rule publication requires a different steward from the author; instrument promotion requires a
second psychometric lead and is blocked entirely while licence/validation evidence is missing.

**ADR-012 · Safe-by-construction front end.** A tagged-template helper escapes every interpolated value; the CSP forbids inline
script and style; a unit test enforces no inline handlers/styles and no direct `innerHTML`. Bars are SVG attributes, not inline styles.

**ADR-013 · Bidirectional text.** CSS logical properties only; Arabic-Indic digits and Gregorian dates in Arabic UI; identifiers,
hashes and codes are isolated with `<bdi>`/`dir="ltr"`; data bars keep a left-to-right 0→100 scale in both languages (the
spec says not to reverse diagrams) while labels follow the reading direction. Internal spec references were removed from
student-facing Arabic copy after the hyphen in "D-07" scrambled under bidi reordering.
