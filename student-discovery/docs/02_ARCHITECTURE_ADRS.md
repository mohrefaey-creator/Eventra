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

**ADR-014 · Assignments are history, not a flag.** A counselor assignment row is never deleted: ending one sets `ended_at` and
`end_reason` (`conflict_of_interest` or `reassigned`). Only an open row gives access, in the policy check, the queue, and where new
cases are routed. A counselor who declared a conflict for a student is excluded from ever being assigned to them again. Declaring needs
no consent from the student because it only removes access. The conflict reason is kept in `db.conflicts` and appears in no list or audit
entry. The idempotency epoch counts ended rows, so a replayed answer cannot outlive a change of assignment.

**ADR-015 · PDF by an installed browser, after the transaction.** Spec §6.2 and the zero-runtime-dependency rule rule out a PDF library,
so an installed Chromium/Chrome prints a server-built page (semantic HTML from the same dictionaries as the screen, everything escaped, CSP
with no script or network, name resolution disabled, throw-away profile) into a tagged PDF with `Lang`, `Title`, headings, tables and lists.
Authorization and the `report.exported` audit event happen inside the transaction; rendering happens after it commits through a route-level
`finish` hook so a slow render never holds the database. Output is cached by content fingerprint and language, at most two renders run at
once, four may wait, a hung browser is killed after 30 s. No browser: 501 and the print stylesheet remains. *Revisit:* a vetted PDF service
and PDF/UA validation.

**ADR-016 · The API contract is a checked artifact.** `docs/api/openapi.yaml` and `docs/api/events.schema.json` are hand-written and
validated against the running server: route parity (including who needs CSRF), a scenario that drives every operation and validates every
request the server accepted and every response (problems included), invariants over everything returned (no probability, percentile or
norm anywhere; no birth dates or keys), and every outbox event against its payload schema (extra fields are rejected, which keeps events to ids
and states). Mutating the server or the spec makes the suite fail (checked during the build).
