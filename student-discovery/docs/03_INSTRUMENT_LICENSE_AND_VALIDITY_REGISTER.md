# 03 · Instrument licence & validity register

**Nothing in this register is licensed or validated.** All instruments are original wording written for this prototype.
They run only while `SYNTHETIC_MODE=true`; with it off, they refuse to start (fail closed, AC-06). Source of truth:
`domain/instruments/` (the Admin → Instruments screen shows the same data live).

| Instrument id | Ver. | Items | Construct | Scoring (`algorithm_version`) | Licence | Validation | State | Disposition |
|---|---|---|---|---|---|---|---|---|
| `interest_exploratory` | 0.1.0 | 36 (6 × R,I,A,S,E,C) | Occupational-interest preferences (self-report) | `riasec-exploratory-mean-1.0.0` | Original text; **no** third-party rights claimed; no licence document | None | draft | Exploratory, synthetic only. Not O\*NET, not a validated Holland code |
| `subject_preference_exploratory` | 0.1.0 | 12 | Enjoyment of school subjects | `item-normalized-1.0.0` | Original | None | draft | PROPOSED custom questionnaire (spec §4.1) |
| `skills_confidence_selfreport` | 0.1.0 | 8 | Self-reported confidence | `item-normalized-1.0.0` | Original | None | draft | Never scored as demonstrated competence |
| `work_values_exploratory` | 0.1.0 | 8 | Importance of work values | `item-normalized-1.0.0` | Original | None | draft | Needs governance before any use |
| `student_constraints` | 0.1.0 | 1 | Stated constraint (instruction language) | `choice-passthrough-1.0.0` | Original | n/a (not scored) | draft | Used only to flag tensions; never changes a score |
| `aptitude_reasoning` | 0.0.0 | **0** | Cognitive aptitude | none | **None procured** | None | draft | **HOLD** (spec §4.1, D-07). Shown with its reason; cannot start |

Mandatory metadata (spec §4.2) held per instrument: id, version, locales, item-bank hash, owner, jurisdiction, age/grade range,
intended uses, licence record, validation checklist, missing-response policy, timing/accommodation, exposure controls,
interpretation warning, approvers, effective dates (dates/approvers empty: nobody has approved anything).

## Why publication is blocked
`publicationBlockers()` returns `license_not_confirmed`, `translation_review_missing`, `back_translation_missing`,
`expert_review_missing`, `cognitive_interviews_missing`, `reliability_missing`, `fairness_findings_missing` for every instrument.
`POST /admin/instruments/:id/publish` therefore answers 409 with the list, and writes an audit event.

## What must happen before any real use (spec §4.3)
1. Decide O\*NET (or another instrument): exact usage rights, translation permission, API/service terms, age suitability, Arabic validation. Reference links in the spec are verification starting points, **not approvals**.
2. Professional translation + independent back-translation; cognitive interviews with the actual Saudi school population (urban/rural, school types, pathways).
3. Reliability, factor behaviour, test–retest, convergent evidence; measurement invariance and subgroup functioning where appropriately powered.
4. Separate norming study. A 200–400-student convenience pilot supports feasibility only, **not** national norms (§4.3, §15). No percentiles are produced anywhere in this prototype (AC-18).
5. Aptitude: a licensed, validated, fairness-tested, securely administered instrument, with answer keys held server-side and never sent to browsers or models.
6. Native-speaker education/localization review of all Arabic item text and UI copy (current Arabic was written by the build team, not reviewed).
