# 09 · Test plan and evidence

All numbers below are from runs in this workspace (Node 22, Chromium from `/opt/pw-browsers`). Re-run them with the commands shown.

| Suite | Command | Result | Notes |
|---|---|---|---|
| Unit (domain + UI helpers) | `npm test` | 43 tests | scoring, ties, property tests (300 random answer sets, monotonicity, order independence), gate, matching, recommendation runs, validation, i18n parity, CSP-safety lint, route-doc drift |
| API + security | `npm test` | 61 tests | acceptance criteria, authorization, tenancy, consent, concurrency, governance, audit, kill switch, rate limit, outbox retry |
| Lint | `npm run lint` | clean | unused imports/vars, undefined names |
| Browser E2E | `npm run test:e2e` | 22/22 steps, run repeatedly | real app in Chromium with the CSP enforced, Arabic and English, mobile width, offline/reconnect, keyboard, four-eyes, kill switch |
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
An independent reviewer (a separate agent given only the code and the spec, instructed to try to break authorization, tenancy,
consent, integrity and input handling) examined `server/`. Its findings, what was reproduced, and what was changed in response are recorded in the next section.

**Status at the time of this commit: the review had been started and had not yet reported.** Its findings, and the fixes made in response, are added in a later commit; until then this prototype has had no independent security review.
