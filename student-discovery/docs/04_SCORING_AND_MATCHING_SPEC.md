# 04 · Scoring and matching specification (as implemented)

Code: `domain/scoring/`, `domain/matching/`, `domain/admission/`. All functions are pure; the same input yields a
byte-identical output. Values marked **PLACEHOLDER** are not approved (spec D-04) and are not operational defaults.

## 1 · Interest scoring (`riasec_mean`, spec §5.2)
For each area `c ∈ {R,I,A,S,E,C}` with answered values `x_i ∈ {1..5}` (reverse-coded items map to `6 − x`):

```
mean_c        = (Σ x_i) / n_answered_c
display_0_100 = 25 × (mean_c − 1)
```
* An answer counts only if it is an integer 1–5. `"na"`, missing, or out-of-range answers are **missing** and never imputed.
* If `n_answered_c < 4` (**PLACEHOLDER** minimum) the area is `insufficient_data`: `mean` and `display_0_100` are `null`, never `0`.
* Values are rounded to 6 / 4 decimals with a decimal-safe rounding function so replays are stable.
* This is a **within-person** display, not a norm or probability.

**Ranking and ties (disclosed rule):** competition ranking (`1,2,2,4`) on `display_0_100`; equal scores are ordered by the
fixed sequence R,I,A,S,E,C; `top` = every area with rank ≤ 3, so a tie at the boundary is **not** silently broken. Near-equal
scores are not claimed to differ meaningfully. If any area is `insufficient_data` the ranking is flagged `complete: false`.

**Test vector** (also in `test/unit/scoring.test.js` and `test/api/assessment.test.js`):

| Area | Answers | mean | display |
|---|---|---|---|
| R | 5,4,3,2,1,5 | 3.333333 | 58.3333 |
| I | 3,3,3,3,3,3 | 3 | 50 |
| A | 1×6 | 1 | 0 |
| S | 5×6 | 5 | 100 |
| E | 2,2,2,2,4,4 | 2.666667 | 41.6667 |
| C | 3,3,3,3,5,1 | 3 | 50 |

Ranking: S(1), R(2), I(3, tied with C), C(3), E(5), A(6); `top = [S,R,I,C]`.

**Other modules** (`per_item_normalized`): `value_0_1 = (x − 1) / 4`; `"na"` → status `not_applicable`; unanswered → `missing`; no totals.
`choice_passthrough` stores the chosen option.

**Provenance on every `score_run`:** `instrument_version_id`, `item_bank_hash`, `algorithm_version`,
`input_hash = SHA-256(canonical{instrument version, bank hash, sorted answers})`, `execution_hash = SHA-256(canonical{whole payload})`,
`norm_reference: null`. `POST /sessions/:id/replay` recomputes from the sealed answers and compares `execution_hash`.

## 2 · Interest fit (spec §5.4) 
```
s_i = display_i(student) − mean(display)        p_i = profile_i(program) − mean(profile)
cosine = (s · p) / (‖s‖ ‖p‖)                     interest_similarity = (cosine + 1) / 2   ∈ [0, 1]
```
* Needs all six areas scored; otherwise `insufficient_data` (lists which). A flat student or program profile → `insufficient_data` (nothing to compare).
* The per-area contribution `s_i·p_i / (‖s‖‖p‖)` is returned, sums to the cosine, and drives the "why" table.
* Reported to the user as a **similarity index 0–100**, never as a chance of success.
* Program profiles are **synthetic placeholders** (`profile.source = synthetic_placeholder`, `reviewer: null`).

**Alignment components** (subject, work values, self-reported skills): `Σ w_k · v_k / Σ w_k` over the program's weighted keys.
**Strict:** if any weighted key has no student value the component is `incomplete` with the missing keys; nothing is renormalized.
Skills alignment is labelled **self-report** and is never part of ranking or any composite.

**Composite (§5.4):** `0.45·interest + 0.25·subject + 0.20·demonstrated_skills + 0.10·values` (**PLACEHOLDER weights, `approved: false`**).
`exploratoryFit()` returns `incomplete` unless all four components exist. `demonstrated_skills_alignment` is `not_available`
while aptitude is on hold, so the composite is **never computed or shown**.

**Ranking of programs:** by `interest_similarity` descending (competition rank), ties by program id; programs without an interest
fit are listed unranked after the ranked ones. `alternatives` = up to three other programs: same field first, then by rank.

## 3 · Capability readiness
For each `required_preparation {subject, min_grade}` compare the student's grade evidence: `met` / `not_met` if verified,
`unverified_met` / `unverified_not_met` if not, `unknown` if absent or expired. Status: `not_required`, `evidence_missing`
(all unknown), `provisional` (some unknown or unverified), `assessed` (all verified). `ratio = met / total`.
Aptitude is reported separately as `on_hold`. No single "ability" number is produced.

## 4 · Admission gate (spec §5.5, independent of fit)
Source classification first: no published rule → `not_evaluated`; `conflicting` → `manual_review_required`;
outside `[effective_from, effective_to]` or past `review_due_at` → `source_stale`. Then per condition (`pathway ∈ …`, `secondary_percentage ≥ …`, `gat ≥ …`, `saat ≥ …`):

| Condition result | Meaning |
|---|---|
| `met` / `not_met` | evidence present, **verified**, passes / fails |
| `unverified_met` / `unverified_not_met` | present but not verified (manual entry is not official proof) |
| `unknown` | no evidence, or evidence expired |

Overall (in this order): any `not_met` → **`verified_ineligible`**; else any `unknown` → **`evidence_missing`**; else any unverified →
**`manual_review_required`**; else **`verified_eligible`**. Unverified factors never cause a hard rejection. `acceptance_probability` is always `null`;
`competitive` is carried through because eligibility is not acceptance.

## 5 · Explainability payload (§5.6)
Every program item carries: `program_id`, `rank_if_available`, `interest_evidence`, `academic_evidence` (evidence ids), `admission_status`
(with `rule_snapshot_id`, source, window), `rule_version`, `missing_inputs`, `uncertainties`, `tensions`, `alternatives`, `human_review_status`;
the run carries `catalog_snapshot_id`, `input_snapshot_hash`, `algorithm_version`, `generated_at`, `decision_status = system_generated_non_authoritative`.

## 6 · Abstention cases (tested)
No sealed interest result → advisor abstains (`no_verified_source` → counselor). Program source stale/conflicting/none → abstains and routes to catalog review.
Missing consent scope → denied before anything is computed. Missing interest area → no fit, no rank, eligibility still evaluated.
