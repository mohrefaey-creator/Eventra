# 05 · Program data contract

**The catalog in this prototype is fictional.** There are 3 made-up universities and 15 made-up programs
(`domain/catalog/programs.js`); thresholds, windows and publishers are invented (`example.invalid` URLs). Nothing may be
presented as a real Saudi admission rule. This document defines the contract a *real* steward-verified catalog must meet.

## Entities
* **`degree_program`**: `program_id`, `university_id`, `official_name{ar-SA,en}`, `degree_level`, `instruction_language` (`ar|en|both`), `taxonomy_code`, `field_cluster`, `status`.
* **`program_profile`**: `model_version`, `source`, `reviewer`, `evidence_refs`, RIASEC vector (0–100), subject / values / skills weights (0–1), `required_preparation[{subject,min_grade}]`. *Currently synthetic placeholders, `reviewer: null`. Needs expert rating and Saudi relevance review.*
* **`admission_rule_snapshot`** (immutable once published): `program_id`, `cycle`, `version`, `state`, `rules{conditions[], competitive, application_window}`,
  `source{publisher, source_url, published_at, captured_at}`, `effective_from/to`, `review_due_at`, `authored_by`, `verified_by`, `conflict_detail`, `supersedes_id`.

Supported condition keys: `pathway` (set), `secondary_percentage`, `gat`, `saat` (minimums). Adding more (language tests, subject
requirements) means extending `domain/admission/gate.js` and its tests; unknown operators evaluate to `unknown`, never to a pass.

## Rule lifecycle
`draft → published → superseded` (or `conflicting` when publishers disagree). Publishing needs a **different** steward from the author
(four-eyes), a complete source record, and valid dates. Publishing supersedes the previous version; earlier recommendation runs keep their
stored snapshot ids and output, so old results stay reproducible (AC-16) and new ones are labelled "recomputed" with a diff.

## Freshness
A published rule is **current** only inside `[effective_from, effective_to]` and before `review_due_at`; otherwise `source_stale`
(admission cannot be reported as eligible). `catalog.admission_rule.expired` is emitted once when `review_due_at` passes.
`GET /programs?source_state=` and the Control Tower show freshness; the catalog screen shows who published what, from where, until when.

## Seeded exceptions (so every state can be seen)
| Program | Seeded state | Shows |
|---|---|---|
| Nursing | `review_due_at` in the past, plus a pending draft | `source_stale`; publish the draft as Steward 2 to see the change |
| Psychology | two publishers disagree on the minimum GAT | `manual_review_required`, "Sources conflict" |
| Media & Communication | no rule | `not_evaluated` |

## For a real catalog
Source-backed, steward-owned data with update rights (D-03); official admissions integrations only under an agreement and an approved adapter
(§6.2); a published SLA for freshness and disputes (D-08). Never scrape or infer current cutoffs, seat counts or acceptance chances.
