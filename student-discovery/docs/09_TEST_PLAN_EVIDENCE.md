# 09 · Test plan and evidence

All numbers below are from runs in this workspace (Node 22, Chromium from `/opt/pw-browsers`). Re-run them with the commands shown.

| Suite | Command | Result | Notes |
|---|---|---|---|
| Unit (domain + UI helpers) | `npm test` | 43 tests | scoring, ties, property tests (300 random answer sets, monotonicity, order independence), gate, matching, recommendation runs, validation, i18n parity, CSP-safety lint, route-doc drift |
| API + security (incl. 20 review regressions) | `npm test` | 81 tests | acceptance criteria, authorization, tenancy, consent, concurrency, governance, audit, kill switch, rate limit, outbox retry |
| Lint | `npm run lint` | clean | unused imports/vars, undefined names |
| Browser E2E | `npm run test:e2e` | 23/23 steps, run repeatedly | real app in Chromium with the CSP enforced, Arabic and English, mobile width, offline/reconnect, keyboard, four-eyes, kill switch |
| Accessibility scan | inside the E2E run | **0 axe-core violations** (WCAG 2.0/2.1/2.2 A+AA tags) | every screen, ar-SA and en, light and dark, six personas |

`npm test` finishes in about 2 seconds; the E2E run in about 40 seconds.

## Coverage against spec §12.2
| Required suite | Status |
|---|---|
| Unit: item validation, RIASEC scoring, reverse-coding, missingness, normalization, similarity, threshold gate, locale formatting | ✅ (locale formatting is exercised via the E2E rather than a dedicated unit test) |
| Property-based: range invariants, order independence, monotonicity, idempotency, null-as-zero | ✅ scoring; 🟡 matching has example-based tests only |
| Contract: OpenAPI and events, authorization, snapshots | 🟡 No OpenAPI file; route table is checked against the docs; event names asserted in API tests |
| Integration: migrations, outbox, concurrency, queue outage/replay | 🟡 No database/migrations; outbox, concurrency and retry are tested |
| E2E: ar-SA/en, mobile, back/forward, offline, guardian denial, counselor approval, PDF export | 🟡 all except browser back/forward and PDF export |
| Accessibility: WCAG automated + manual screen reader/keyboard + Arabic native QA | 🟡 automated scan and keyboard tests ✅; **manual screen-reader and native Arabic QA not done** |
| Security: OWASP threats, prompt injection, IDOR, leaked keys, exfiltration, revocation, SAST/DAST, SBOM, penetration | 🟡 IDOR, tenancy, CSRF, XSS-by-construction, revocation, prototype-pollution review (see below). No SAST/DAST, SBOM, or penetration test. Prompt injection is not applicable (no model is called) |
| Psychometric: licensed scoring fidelity, translation, reliability, validity, subgroup functioning | ⛔ not possible: no licensed or validated instrument exists |
| Operational: backup/restore, incident escalation, observability, kill switch, stale-source and licence drills | 🟡 kill switch, stale-source and licence-expiry behaviour tested; no backup/restore or escalation drills |

## Checks that the tests themselves can fail
Two deliberate mutations were applied to the domain code during development and the suite caught both (removing the minimum-completion rule failed 4 tests;
treating unverified evidence as verified failed the gate test), then the code was restored.

## Defects found and fixed during the build (so the history is honest)
| Found by | Defect | Fix |
|---|---|---|
| Visual check | The majors list rendered as escaped HTML text (`mount()` was given an array of fragments) | `mount()` renders arrays; unit test added |
| Visual check | The Arabic hold reason showed "D-07" scrambled by bidi reordering; internal spec ids do not belong in student copy | Removed from copy; documented in ADR-013 |
| E2E | **Reloading any deep link bounced the user to the home screen** (an early render before the session was known redirected to login) | Router renders only after boot |
| E2E | Incident banner not shown to a student already in the app | Router refreshes session state on any 503 |
| E2E / code read | `aria-pressed`/`aria-selected` rendered empty (`false` renders as nothing in the template helper) | Explicit `'true'/'false'`; unit test forbids the pattern |
| axe | Language toggle's accessible name did not contain its visible text (WCAG 2.5.3) | Removed the conflicting `aria-label` |
| axe | Disabled cards fell below 4.5:1 contrast (`opacity`) | Removed opacity |
| E2E | Report page overflowed horizontally (rotated DRAFT watermark); control tower and program pages overflowed at 375 px (long chips; hidden table captions escaping the scroll container) | CSS containment fixes |
| Unit test | A hard-coded, unused `{b}` placeholder parameter | Removed |

## Independent adversarial review

An independent reviewer (a separate agent, given only the code and the spec, told to try to break authorization, tenancy, consent,
integrity and input handling) examined all of `server/` and the domain code it calls, running 14 personas against 37 routes and
writing reproductions. It reported **22 confirmed findings** plus several suspected items, and listed the areas where it found nothing.
Every confirmed finding was reproduced as a regression test in `test/api/review.test.js` (all failed before the fix, all pass now).

| # | Severity (reviewer) | Finding | Outcome |
|---|---|---|---|
| 1, 11 | High / medium | Advisor endpoints skipped `counselor_sharing`; a student kept the advisor after processing consent was withdrawn | **Fixed.** Rules may require several scopes; a counselor needs `counselor_sharing` **and** `advisor_explanation`; any consent-gated intent now requires active processing consent for every role |
| 2 | High | The open persona stub was reachable from any host and is not tied to `SYNTHETIC_MODE`, so one person could act as both four-eyes approvers | **Mitigated, not eliminated.** The server refuses to start on a non-loopback `HOST` without an explicit `ALLOW_NETWORK_HOST=true`, and answers only loopback `Host` headers (DNS-rebinding defence). Four-eyes is only meaningful with real identities, which the stub cannot provide (documented) |
| 3 | Medium-high | An idempotent replay returned a cached 200 after consent was withdrawn; cached bodies were live objects and never expired | **Fixed.** Replays are honoured only while no consent/relationship record has changed and for 10 minutes; bodies are stored as serialized snapshots; per-actor cap |
| 4 | Medium | Kill switch bypassed by a request whose body arrived after it was enabled | **Fixed.** The switch and the session are re-checked after the body is read |
| 5 | Medium | A student could plant `subject_ref` to read another student's report outcome, across schools | **Fixed.** `subject_ref` must name one of the student's own records; case auto-resolution is also scoped to the report's student |
| 6 | Medium | Audit before/after hashes were plain SHA-256 of small-domain values (grades could be brute-forced by the security role); audit reads unaudited | **Fixed.** Keyed HMAC (key stays in the database document); reading the audit log is recorded |
| 7, 12, 22 | Medium / low | Evidence types, consent scopes and persona ids accepted names inherited from `Object.prototype`; array scopes corrupted the ledger; malformed `%`-encoding returned 500 | **Fixed.** Own-property checks, type checks, 400 for malformed input; evidence maps are prototype-less; canonical hashing no longer drops `__proto__` keys |
| 8 | Medium | A guardian could withdraw consent for an adult; no expiry on guardian authority; consent toggling piled up retention tasks | **Fixed.** Guardian consent powers exist only for minors; guardian links can expire or be revoked; one open retention decision per student and scope. Unknown birth date now fails closed (treated as a minor) |
| 9 | Medium | A counselor could create and approve the same report | **Fixed.** Only the student creates reports; the approver may never be the creator |
| 10 | Medium | Authenticated DoS: unbounded growth, full-database clone per request, session-hopping around rate limits | **Partly fixed.** Rate limits are keyed by client address as well as session; logins have their own limit; `force_recompute` removed and runs capped at 50 per student; idempotency and session stores bounded. **Not fixed:** the per-request full-database copy used for rollback (prototype scale; a real database replaces it) and unbounded audit growth under sustained probing (append-only by design; the rate limit slows it) |
| 13 | Medium-low | A stale draft could overwrite a newer published rule; `null`/`""`/`[]` thresholds became 0 | **Fixed.** A draft is only publishable against the rule it was written for; thresholds must be real numbers; pathways must be known |
| 14 | Low-medium | Counselor reads of evidence, recommendations, reports, cases and consent were not audited | **Fixed** |
| 15 | Low | Existence oracle: unknown ids returned 404 while other schools' ids returned 403 "belongs to another school" | **Fixed.** Identity-related denials all read `not_available`; the audit log keeps the true reason. The role check now runs before any lookup |
| 16, 17 | Low | Kill-switch reason broadcast publicly; school admin's counters included other schools; drafts and steward ids visible to students | **Fixed** |
| 18 | Low | Guardian summary listed approved-but-unshared reports | **Fixed.** Only actively shared reports are listed |
| 19 | Low | Replay and approval compared hashes without re-hashing the stored payload | **Fixed.** Replay, score view and report approval verify the stored content against its recorded hash (this defends against database-level tampering only) |
| 20 | Low | A missing grade was counted as zero in `capability_readiness.ratio` | **Fixed.** No ratio until every item has a value |
| 21 | Low | Free text entered the immutable audit chain (`purpose`, kill-switch reason) | **Fixed.** `purpose` is a fixed list; every audit `meta` string is clipped to 200 characters |

**Suspected / out of reach, with decisions:**
* Guardian-shared reports are wider than the summary allow-list: **kept**, because it requires an explicit student share; policy owner to confirm.
* Raw answers share the `counselor_sharing` scope with scored data (spec §11.7 asks for distinct classes): **open decision**, listed in `12`.
* The audit chain has no external anchor (tail truncation by someone with database access is undetectable): **documented**.
* Control-tower cells at or above the threshold are shown exactly, so differencing is possible; denial counts are not suppressed: **documented**.
* Consent withdrawal during an incident: the reviewer observed it was blocked (fail-closed against data-subject rights). **Changed:** withdrawing stays possible during an incident; granting does not.

**Areas where the reviewer found nothing:** IDOR across 14 personas and 37 routes with real ids; cross-tenant and unassigned-counselor access; counselor-only fields reaching students or guardians; mutation of sealed answers/scores/approvals through any route; concurrent submits; four-eyes on rules; prototype pollution through request bodies; static-file traversal; CSRF; admission probability and hard-rejection invariants.

I also found, while fixing these, a regression of my own that the browser suite caught (`.map(publicRule)` passed the array index as a new argument, hiding a draft's author from the stewards). It is fixed and now has an API assertion.
