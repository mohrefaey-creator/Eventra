# 12 · Open decisions, gaps and next steps

## Spec register (§16) with current status
| ID | Decision / risk | Owner (spec) | Status in this work |
|---|---|---|---|
| D-01 | Actual NextMind repo and signed contracts unverified | Tech lead | **Open.** No repo in the workspace (`00`). Stand-ins isolated for later replacement |
| D-02 | O\*NET licence, translation permission, Saudi suitability | Legal + psychometric | **Open.** No licensed instrument used; original unvalidated items only (`03`) |
| D-03 | Saudi program profiles, publishers, coverage, update rights | Academic data steward | **Open.** Fictional catalog only (`05`) |
| D-04 | Scoring weights / admission forecast calibration | Psychometric + product | **Open.** Placeholder weights present but never applied (composite refused); no forecast exists |
| D-05 | Legal basis and retention for minors; consent regime | Legal/DPO + safeguarding | **Open.** Placeholder age threshold (18) and `PENDING-COUNSEL-REVIEW` basis; retention tasks queue for decision |
| D-06 | Embed LimeSurvey/H5P or custom renderer | Architecture board | Custom renderer built (small, accessible, CSP-safe); no third-party survey code used |
| D-07 | Ability measures, norms, accommodations, item-bank security | Psychometric lead | **Open.** Aptitude on hold by design |
| D-08 | Source freshness and override dispute process; accountable publisher/SLA | Catalog owner | **Open.** Mechanism exists (review-due dates, four-eyes, conflict state); SLA/owner do not |
| D-09 | School tenants, roles, counselor visibility matrix | Security/operations | **Open.** Roles and visibility classes implemented as a draft matrix in `server/policy.js` |
| D-10 | Budget, load profile, time plan, platform choices | Sponsor/finance | **Open** |

## Additional items found while building
1. Encryption at rest, backups, key management: not implemented (synthetic data only).
2. Arabic copy and bidi review by a native education/localization expert; manual screen-reader and keyboard sessions with real users (including students).
3. PDF export exists (tagged; Arabic and English) but needs: a PDF/UA validator run (e.g. veraPDF), a native-speaker check of the Arabic pages, embedded-font decisions for machines without Arabic fonts, and retention/privacy controls before any real use (spec §1.3).
4. "Expired" consent; `not eligible` landing state. (Counselor conflict of interest, reassignment and guardians with several children are built.)
5. A task model with owners and due dates for the roadmap (DISC-08 "owner missing / overdue").
6. Evidence-recording workflow for instruments (licence document, validation results) so a legitimately validated instrument can be unblocked, plus its four-eyes promotion test through the API.
7. Rights-request, retention and deletion jobs; incident escalation; monitoring.
8. SBOM and dependency scanning (the runtime has no dependencies; dev tools do, including `ajv` and `yaml` for the contract tests). OpenAPI/JSON Schema artifacts and contract tests are built (`docs/api/`).
9. Pilot design (§15): sampling, pre-registration, subgroup/fairness plan, comprehension and appeal-rate metrics.
10. External anchoring of the audit chain; complementary suppression in aggregates; a copy-on-write or **database-backed store (PostgreSQL is the spec's target; needs a decision on which engine and migration tooling before it is built)**; guardian-link management (creation, expiry, revocation) beyond the field the policy already honours. (The separate consent scope for raw answers is built.)
11. Attempt-to-attempt change policy (retake spacing, interpretation of change) beyond the placeholder maximum of five attempts.
12. Conflict of interest and assignment policy (needs the signed authorization matrix, D-09): who may read a conflict reason and for how long; whether a platform role can override a school admin; how and how fast the school admin is alerted when a counselor steps away (the outbox event exists, nothing consumes it); what a student is told when their counselor changes; whether a conflict also bars reading the student's notes after handover.
13. Guardian with several children: the selector and per-child consent are built; a guardian linked to children in different schools is not modelled (links are per student, the tenant check still applies per child).

## Suggested next steps, in order
1. Obtain the NextMind repository and gate records and complete WP-00 (replace the four stand-ins).
2. Close D-02/D-03/D-05 with the named owners; until then keep everything synthetic.
3. Native-speaker review of Arabic content; manual accessibility testing.
4. Draft the DPIA and threat model with the security team; schedule a penetration test.
5. Only then plan Slice B (governed assessment beta) per spec §14.1.
