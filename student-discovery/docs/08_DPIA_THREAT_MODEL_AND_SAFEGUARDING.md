# 08 · Threat model, privacy and safeguarding (prototype scope)

**This is a design-time threat model for a synthetic-data prototype. It is not a DPIA, legal opinion or security assessment.**
A real DPIA, PDPL review, safeguarding policy and penetration test are required before any real student data (spec §11.1–11.2);
they need qualified people and are listed in `12`.

## Assets and visibility classes (spec §11.7)
| Class | Examples | Who may read |
|---|---|---|
| Raw answers | item responses | the student; an assigned counselor **with** `counselor_sharing` **and** the separate `raw_answer_sharing` (each read audited). Never a guardian |
| Scored attributes | `score_run`, panels | the student; consented counselor. Guardian: allow-listed summary only (module status, top interest names) |
| Academic evidence | grades, test scores, pathway | the student; consented counselor. Guardian: not shown |
| Counselor notes | `case_notes`, override reasons | counselor; a note is visible to the student only if marked so. Never the guardian |
| Consent records | scope, party, policy version | the student, their guardian, assigned counselor |
| Audit log | keyed-hash (HMAC) before/after, ids, clipped reasons | security role only; no answer text, evidence values or note text; reading it is audited |
| Aggregates | control tower | tenant admin (own school) / security; cells under 5 suppressed; only opted-in students counted |

## Authorization model (server-side on every request, `server/policy.js`)
Order of checks: **authenticated → role may ever do this (needs no student, so it cannot reveal existence) → student exists → tenant match →
relationship (self / linked, unexpired guardian / assigned counselor; guardian consent powers only for minors) → processing consent and every required scope active → purpose allow-list** (advisor).
Any refusal about identity answers `not_available` to the caller and records the true reason in the audit log (no existence oracle). UI hiding is never relied upon (the UI also hides, but tests call the API directly).
Platform roles (steward, psychometric lead, tenant admin, security) have **no** path to student content. A kill switch fails the whole module closed (503).

## Threats considered and where they are handled
| Threat | Control | Evidence |
|---|---|---|
| Student reads another student (same or other school) | tenant + `not_self` checks; denial audited as `security.access_denied` | api `AC-02…`, `a student cannot read or write another student…` |
| Guardian reads answers/scores/evidence/notes | role absent from those intents; allow-listed summary builder; share needs an unexpired share **and** consent | api `AC-12…`, `guardian summary disappears…`, report share test |
| Counselor outside assignment or without consent | assignment + `counselor_sharing` + `assessment_processing` required; queue shows no data without consent | api `counselor queue…`, `AC-15…` |
| Platform role touching student data | not present in any student intent rule | api `a counselor can only reach assigned students; platform roles never see student content` |
| Self-approval / privilege escalation | four-eyes on rule publish; only counselor can approve reports; only security can use kill switch/audit | api `four-eyes rule publication…`, role tests |
| Tampering with results | sealed responses; `execution_hash`; replay detects altered answers; reports bound to `payload_hash`; approvals reference the exact hash | unit `AC-09…`, api `AC-09…`, `report: hash-bound approval…` |
| Tampering with / deleting audit history | hash chain; verification endpoint; tamper tests | api `NFR-08 audit chain verifies; tampering…` |
| Repudiation | every consequential action audited with actor, subject, hashes, decision, correlation id | api `every consequential action writes an audit event` |
| Replay / double submit | idempotency keys; single-threaded handlers; status checks | api `idempotency-key…`, `AC-14…` |
| CSRF | SameSite=Strict HttpOnly cookie **and** a per-session token header on every mutating call | api `login sets an HttpOnly SameSite=Strict cookie…` |
| XSS / injection | escaping template helper; CSP `script-src 'self'`, no inline script/style; unit test forbids inline handlers/styles/`innerHTML`; strict server-side typed validation | unit `html helper…`, `UI markup has no inline…`, api validation tests |
| Path traversal in static files | normalized path must stay inside `web/` | api `static app is served…; traversal is refused` |
| Oversized / malformed bodies | 64 KB limit, JSON content-type required, RFC 7807 errors | api `body must be JSON…` |
| Abuse / DoS | per-session fixed-window rate limit (429) | api `rate limiting…` |
| Partial writes after errors | snapshot + restore transaction wrapper | api `failed requests roll back every partial write` |
| Data leaving the machine | no outbound calls; advisor is deterministic; no external fonts/CDNs (CSP `connect-src 'self'`) | design + CSP |
| Unvalidated tools used as if valid | fail-closed usability, interpretation warnings, "not validated" on every result and report | unit/api instrument tests |
| Misleading outputs (probabilities, percentiles, destiny claims) | `acceptance_probability: null`, `norm_reference: null`, composite refused, copy reviewed against §1.4 | api `AC-18…`, e2e "no admission probability" |

## Privacy and safeguarding behaviours
* **Minors:** guardian authorization required below a placeholder age (18); student assent always; nothing pre-ticked; optional scopes never gate features.
* **Purpose limitation and minimization:** audit/outbox carry ids and hashes only; guardian and advisor receive allow-listed fields; counselors see answers only through a logged read.
* **Withdrawal:** stops new processing and sharing immediately; student keeps read access to their own data; retention decision is queued for people, not automated.
* **Safeguarding:** students can raise help requests at any time; counselors can open `safeguarding_referral` cases that surface in the queue. The prototype does **not** scan text for risk keywords (that would be an unvalidated detector); escalation is human.
* **Fairness:** protected attributes are not used by scoring or matching. The only personal attribute used by logic is date of birth, for the consent age rule. **Bias monitoring is not implemented** (needs real data and an approved, proportionate processing basis, spec §11.8).
* **Commercial use:** none. No advertising, no sale, no profiling beyond the stated educational purpose.

## Independent review
An independent adversarial review of the server produced 22 confirmed findings, all reproduced as regression tests and addressed or explicitly
documented as residual risk. See `09_TEST_PLAN_EVIDENCE.md` for the table; the fixes behind the rows above (uniform denials, keyed audit hashes,
re-checks after slow bodies, consent-aware idempotency, loopback-only serving) come from it.

## Known gaps (not hidden)
1. Identity is a stand-in: anyone who can reach the server can sign in as any persona, and one person can therefore act as both four-eyes approvers. The server therefore only serves loopback hosts by default and refuses to start elsewhere without an explicit opt-in.
2. The cookie is `Secure` only when a proxy says the request came over HTTPS (`X-Forwarded-Proto`); no TLS of its own, no HSTS, no session rotation.
3. No encryption at rest; `data/db.json` is plaintext (synthetic data only). The audit HMAC key lives in the same file.
4. Rollback uses a full copy of the database per mutating request; fine at prototype scale, not beyond it. Audit and consent history are append-only and can grow under sustained probing (rate limits slow it).
5. The audit chain has no external anchor, so truncating its tail with database access is undetectable.
6. Control-tower numbers at or above the suppression threshold are exact, so differencing between periods is possible; denial counts are not suppressed.
7. A guardian-shared report is wider than the guardian summary by design (it needs an explicit student share). *(Raw answers used to share the counselor scope with scored data; they now have their own, unticked-by-default consent scope.)*
8. Rate limits key on the socket address, which behind a proxy would be the proxy.
9. No DPIA, no legal basis (`PENDING-COUNSEL-REVIEW`), no retention schedule, no rights-request handling, no penetration test.
10. PDF export runs an installed Chromium/Chrome as a child process. Mitigations: the printed page is built server-side from escaped content with a CSP that forbids script and network, name resolution is disabled, the profile is a throw-away directory, the child gets a minimal environment, renders time out after 30 s, and at most two run at once. The sandbox is turned off only when the server runs as root (a browser refuses to start otherwise). A browser is a large parsing surface: pin and patch it, and run the server unprivileged, before real use.
11. A conflict-of-interest reason is stored with the conflict record and shown nowhere (not in lists, not in the audit log, which keeps only its length). Who may read it, and for how long, is a school-policy decision that does not exist yet. The school admin sees who stepped away and when, never why.
12. A student who loses their counselor (conflict or reassignment) is not told; the school admin sees them first in the assignments list, but nothing alerts the admin (the outbox event `discovery.assignment.conflict_declared` has no consumer here).
13. Ending an assignment keeps the old counselor's notes in the student's record; they are visible to the next counselor (handover is by design) and to nobody the student has not shared with.
14. The optional Vercel host (`api/index.js`) lifts the loopback-only Host check, so the persona sign-in is reachable by whoever can reach the URL. It is acceptable only behind Vercel Deployment Protection; the app itself cannot verify that. State is in memory per function instance (see README).
