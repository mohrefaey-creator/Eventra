# 01 · Requirements → implementation → evidence

Status: ✅ implemented and tested · 🟡 partial (see note) · ⛔ out of scope / blocked by a spec decision or gate.
Test names are the `test()` titles in `test/`; "e2e" = `test/e2e/run.mjs` step.

## Acceptance criteria (spec §12.1)
| ID | Status | Implementation | Evidence |
|---|---|---|---|
| AC-01 consent required to start | ✅ | `policy.authorize` (`session.create` needs `assessment_processing`); dashboard locks start | api `AC-01 without consent…`; e2e `AC-01 no consent…` |
| AC-02 cross-tenant denied + security event | ✅ | tenant check first in `authorize`; denial audited after rollback (`http.js`) | api `AC-02 cross-tenant access is denied…`; security tests |
| AC-03 save & resume, no duplication | ✅ | per-item PUT with revisions; idempotent session create; client autosave queue | api `AC-03 save & resume…`; e2e runner resume + offline |
| AC-04 score matches independent fixtures | ✅ | `domain/scoring` | unit `AC-04…`; api `AC-04 submitted interest scores equal an independent hand computation` |
| AC-05 unanswered area = `insufficient_data`, never 0 | ✅ | min-completion rule; strict fit | unit + api `AC-05…` (scoring and recommendations); e2e ack step |
| AC-06 archived/expired/suspended instrument denied | ✅ | `instrumentUsability` (fail closed), suspend/resume | api `AC-06…`; unit `instrument usability fails closed` |
| AC-07 stale/conflicting rules are not eligible | ✅ | `classifySource` + gate | unit gate tests; api `AC-07 / AC-08…` |
| AC-08 interest visible while exam score missing → `evidence_missing` | ✅ | gate precedence | unit + api `AC-07 / AC-08…` |
| AC-09 replay is bit-for-bit deterministic | ✅ | canonical JSON + SHA-256; `POST /sessions/:id/replay` | unit `AC-09 replay…`; api `AC-09…`; e2e "Verify the calculation" |
| AC-10 advisor abstains without a verified source | ✅ | `services/advisor.js` | api `AC-10 the advisor abstains…`; e2e program advisor |
| AC-11 counselor override = signed reason, sealed data untouched | ✅ | `createOverride` (annotation layer) | api `AC-11 a signed interpretation override…` |
| AC-12 guardian cannot read raw answers | ✅ | `guardian` absent from raw/score/profile rules; allow-listed summary | api `AC-12…`; e2e guardian |
| AC-13 Arabic UI/report/screen-reader legible and ordered | 🟡 | RTL, logical CSS, `<bdi>`, Arabic numerals; automated layout + axe | e2e RTL/overflow/axe. **Not done:** native-speaker review, screen-reader session, Arabic **PDF** rendering test (print only) |
| AC-14 concurrent submits → one attempt, one scoring command | ✅ | single-threaded handler + status check | api `AC-14 two concurrent submits…` |
| AC-15 consent withdrawal stops processing, revokes shares | ✅ | `setConsent` + `reconcileSessions`; retention task queued | api `AC-15 withdrawing consent…` |
| AC-16 old result reproducible after catalog change; new labelled recomputed | ✅ | immutable runs + snapshot ids + diff | api `AC-16…`; e2e majors "What changed" |
| AC-17 student can challenge/ask for review | ✅ | `POST /cases` (student reasons), Help screen | api `AC-17…` |
| AC-18 no percentile / guaranteed placement without norms | ✅ | `norm_reference: null`; `acceptance_probability: null` | api (no percentile-like keys; probability null everywhere); unit |

## Non-functional (spec §1.5)
| ID | Status | Evidence / gap |
|---|---|---|
| NFR-01 WCAG 2.2 AA | 🟡 | axe-core: 0 violations on every screen, both languages, light + dark, plus keyboard e2e. **Manual assistive-technology testing not done.** |
| NFR-02 Arabic shaping/RTL/bidi | 🟡 | RTL layout + overflow checks at 375 px; one bidi defect found and fixed. **No native-speaker review.** |
| NFR-03 no lost answers after retry/reconnect | ✅ | e2e offline/reconnect, reload resume |
| NFR-04 p95 < 2 s | ⛔ | Not load tested; no load profile exists (D-10). |
| NFR-05 no cross-tenant / minor-data exposure | ✅ (prototype scope) | api security tests; independent review in `09` |
| NFR-06 every score reproducible | ✅ | replay tests |
| NFR-07 every recommendation carries rationale, provenance, snapshot | ✅ | api `explainability payload is complete…` |
| NFR-08 100% consequential-action audit | ✅ (listed actions) | api `NFR-08 every consequential action writes an audit event`; chain verification |
| NFR-09 graceful failure on missing catalog/unlicensed instrument | 🟡 | fail-closed instrument, stale/none sources, kill switch tested; chaos/DR drills not done |

## Journeys and screens
See `07_UI_SCREEN_SPEC.md` for DISC-01…14 and their states. Journeys: J-01 enrollment/consent ✅ (age threshold and legal basis are placeholders);
J-02 dashboard ✅; J-03 item runner ✅ (no timed tasks exist); J-04 results & recommendations ✅; J-05 counselor workflow ✅ (conflict-of-interest/reassignment 🟡 not modelled);
J-06 longitudinal reassessment 🟡 (attempt history shown without interpreting change; no policy beyond a max-attempts placeholder).

## Spec sections not implemented
§6.2 official integrations, §7 PostgreSQL/encryption, §10 LLM tool-use (deterministic explainer only), §11 DPIA/legal/pen-test (documents and people, not code),
§14 slices B–E (need approvals), §15 pilot metrics beyond control-tower aggregates. See `12_OPEN_ITEMS.md`.
