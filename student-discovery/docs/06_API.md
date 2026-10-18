# 06 · API reference (prototype)

Base path `/api/v1/discovery` (spec §8). Identity stand-in endpoints live under `/api/v1/identity-stub`.
JSON in/out; errors are RFC 7807 `application/problem+json` with `code`, `request_id` and, for denials, `reason`.
Every mutating request needs the `X-CSRF-Token` header (from `GET /identity-stub/me`) and `Content-Type: application/json`.
`Idempotency-Key` is honored on all mutating routes (same key + same body replays a stored snapshot for up to 10 minutes **and only while no consent or relationship record has changed**; same key + different body → 422).
`PUT …/responses/:itemId` supports `If-Match: "<revision>"` (stale → 412 with `current_revision`).
**Denials:** identity-related refusals (unknown id, other school, someone else's student, unlinked guardian, unassigned counselor) all answer `403` with `reason: "not_available"`, so a caller cannot probe for existence; the audit log records the true reason. The server only answers loopback `Host` headers unless started with `ALLOW_NETWORK_HOST=true`.
The machine-readable contract is [`api/openapi.yaml`](api/openapi.yaml) (OpenAPI 3.1) with event payloads in [`api/events.schema.json`](api/events.schema.json); `npm run test:contract` validates both against the running server (routes, security, every response shape, every event). This table is the human summary and is also checked against the real route table.

**Authorization column** = the policy intent evaluated by `server/policy.js#authorize` (role → allowed consent scope), or the role list for governance routes.
"consent" means the named scope must be active; counselors additionally need `assessment_processing` **and** an assignment to the student.

## Identity stand-in and platform
| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness, synthetic mode, incident mode (public) |
| `GET /api/v1/identity-stub/personas` | List synthetic personas (public) |
| `POST /api/v1/identity-stub/login` | Start a session for a persona; sets an HttpOnly, SameSite=Strict cookie |
| `POST /api/v1/identity-stub/logout` | End the session |
| `GET /api/v1/identity-stub/me` | Persona, CSRF token, linked students (guardian), incident mode, policy version |

## Assessments and sessions
| Route | Authorization | Purpose |
|---|---|---|
| `GET /assessments` | student (self) | Modules for the signed-in student: status, progress, duration estimate, hold reasons |
| `GET /students/:id/assessments` | `session.read` (student) | Same, by id |
| `POST /sessions` | `session.create` – student + `assessment_processing` | Create/resume an attempt (`instrument_version_id`, `locale`, `idempotency_key`, optional `consent_record_id`). 201 new, 200 existing |
| `GET /sessions/:id` | `session.read` – student | Items (localized, no keys), scales, saved responses, `can_edit` |
| `PUT /sessions/:id/responses/:itemId` | `session.write` – student + processing | Save one typed response (server-validated; revisions) |
| `POST /sessions/:id/submit` | `session.write` | Seal and score. `acknowledge_incomplete` needed if unanswered. Duplicate/concurrent submit → one result (`already_submitted`) |
| `GET /sessions/:id/score` | `score.read` – student, counselor + `counselor_sharing` | Scores, ranking, provenance, signed notes (student sees only student-visible) |
| `GET /sessions/:id/responses` | `responses.read_raw` – student; counselor needs `counselor_sharing` **and** the separate `raw_answer_sharing` scope. **Guardian: never** | Raw answers are a separate visibility class from scored results; counselor reads are audited |
| `POST /sessions/:id/replay` | `score.replay` | Recompute from sealed answers and compare hashes |

## Student data
| Route | Authorization | Purpose |
|---|---|---|
| `GET /students/:id/discovery-profile` | `profile.read` – student, counselor + sharing | Panels, completeness, evidence, aspirations, preferences, journey |
| `GET /students/:id/consent` | `consent.read` – student, guardian, counselor | Derived consent state per scope and party |
| `POST /students/:id/consent` | `consent.write` – student; guardian for `assessment_processing` only and **only while the student is a minor** | Grant or withdraw one scope. During an incident withdrawing still works; granting returns 503 |
| `GET /students/:id/evidence` | `evidence.read` | Latest and history |
| `PUT /students/:id/evidence/:type` | `evidence.write` – student + processing | Enter a value (always `unverified`); invalid ranges 422 |
| `POST /students/:id/evidence/:evidenceId/verify` | `evidence.verify` – counselor + sharing | Mark counselor-verified (note required) |
| `PUT /students/:id/preferences` | `preferences.write` – student | Accessibility and locale |
| `PUT /students/:id/aspirations/:programId` | `aspiration.write` – student + processing | Pin a major (max 5) |
| `DELETE /students/:id/aspirations/:programId` | same | Unpin |
| `GET /students/:id/guardian-summary` | `guardian.summary` – guardian + `guardian_summary_sharing` | Allow-listed summary only |

## Recommendations and catalog
| Route | Authorization | Purpose |
|---|---|---|
| `POST /students/:id/recommendations` | `recommendation.create` – student + processing | Deterministic run. Identical inputs → the same run (200, cannot be forced to duplicate); changed inputs → new run (201) with `changes_since_previous`; at most 50 stored runs per student (409 `run_limit_reached`) |
| `GET /students/:id/recommendations` | `recommendation.read` | Run history |
| `GET /recommendations/:runId` | `recommendation.read` | Stored output (immutable) |
| `GET /programs` | any signed-in user | Filter `q`, `cluster`, `university`, `language`, `source_state`; `limit`/`offset` |
| `GET /programs/:id` | any signed-in user | Program, profile, pathways |
| `GET /programs/:id/admissions` | any signed-in user (`?cycle=`) | Active rule, provenance, freshness, published version list. Drafts, authors and verifiers only for stewards |

## Cases, notes, overrides
| Route | Authorization | Purpose |
|---|---|---|
| `POST /students/:id/cases` | `case.open` – student (help/appeal/dispute), counselor (any) | Open a case. Optional `subject_ref` must name one of the student's own records (`program:`, `session:`, `score_run:`, `recommendation_run:`, `report:`) |
| `POST /students/:id/counselor-review` | same | Spec-named alias of the above |
| `GET /students/:id/cases` | `case.open` | Cases for a student |
| `PATCH /cases/:id` | `case.review` – counselor | `in_review` / `resolved` (resolution required) |
| `POST /students/:id/notes` | `case.review` | Counselor note (`counselor_only` or `student` visibility) |
| `POST /students/:id/overrides` | `override.create` | Signed interpretation note over a sealed score (reason ≥ 10 chars). Never changes answers or scores |
| `GET /counselor/queue` | counselor | Currently assigned students (ended assignments excluded) and reasons; no data peeking without consent |
| `GET /students/:id/case360` | `case.review` | Bundle for review. `?purpose=` must be one of `case_review`, `parent_inquiry`, `appeal_review`, `follow_up`, `safeguarding`; the read is audited. Raw answers are not part of it (separate scope) |
| `POST /students/:id/conflict-of-interest` | the **currently assigned** counselor only (anyone else: 403 `not_available`); no student consent needed, because stepping away only removes access | Declare a conflict (`reason` ≥ 10 chars). The assignment ends at once, open cases become unowned, and the counselor is barred from being assigned to this student again. The reason is kept with the conflict record, never in the audit log or any list |

## Reports
| Route | Authorization | Purpose |
|---|---|---|
| `POST /students/:id/reports` | `report.generate` – **student only** | Build a report payload (identical content → same report) |
| `GET /students/:id/reports` | `report.read` | List |
| `GET /reports/:id` | student, counselor; guardian only via an unexpired share + consent | View; `watermark: "DRAFT"` until approved |
| `GET /reports/:id/pdf` | Same as `GET /reports/:id` (owner; assigned counselor + `counselor_sharing`; guardian only through an active share), **and** the report must be approved (409 `report_not_approved`) | Tagged PDF (`?locale=ar-SA` default, or `en`; anything else 400). Rendered by an installed Chromium/Chrome after the transaction commits; without one: 501 `pdf_unavailable`; a failed render: 502 `pdf_failed` (recorded as `report.export_failed`); too many at once: 429 `pdf_busy`. Every download is audited as `report.exported`. Nothing about the downloader is printed, so identical approved content and language give an identical (cached) file |
| `POST /reports/:id/review-request` | `report.generate` | Ask the counselor to review |
| `POST /reports/:id/approval` | `report.approve` – counselor | `approve`/`reject` bound to the exact `payload_hash` (mismatch → 409); the stored content is re-hashed first; the approver can never be the creator (403 `separation_of_duties`) |
| `POST /reports/:id/shares` | `report.share` – student + `guardian_summary_sharing` | Share an approved report with the guardian for 1–90 days |
| `DELETE /shares/:id` | `report.share` | Revoke |

## Advisor (explain only)
| Route | Authorization | Purpose |
|---|---|---|
| `POST /advisor/tools/get_student_discovery_summary` | same as above + purpose allow-list | Spec §10 tool contract; ids and warning flags only |
| `POST /students/:id/advisor/explain` | `advisor.explain` – student + `advisor_explanation`; counselor + `counselor_sharing` **and** `advisor_explanation`; active processing consent for both | Structured, non-authoritative blocks; abstains without a verified source |

## Governance
| Route | Role | Purpose |
|---|---|---|
| `GET /admin/instruments` | psychometric lead, security | Instruments, state, licence, validation, blockers, usability |
| `POST /admin/instruments/:id/publish` | psychometric lead | Request promotion. **Blocked (409) with reasons** while evidence is missing; second lead required otherwise |
| `POST /admin/instruments/:id/suspend` | psychometric lead | Suspend (reason required); emits `discovery.instrument.suspended` |
| `POST /admin/instruments/:id/resume` | psychometric lead | Resume |
| `GET /admin/program-rules` | steward, psychometric lead, security | Rules, drafts, versions, source state |
| `POST /admin/program-rules` | steward | Draft a rule (source, dates, conditions mandatory) |
| `POST /admin/program-rules/:id/publish` | steward **other than the author** | Verify and publish; supersedes the previous version |
| `GET /admin/assignments` | tenant admin (own school) | Students (unassigned first) with their counselor and who declared a conflict, plus counselors with load. No student content, no conflict reason |
| `POST /admin/assignments` | tenant admin (own school) | `{student_id, counselor_id, reason}`. Counselor must be of the same school (422 `counselor_other_school`) and must not have declared a conflict for that student (409 `conflict_of_interest`). Ends the old assignment (history kept), moves open cases, repeating the same assignment returns `changed:false` |
| `GET /admin/control-tower` | tenant admin (own school), security | Aggregates with small-cell suppression |
| `GET /admin/audit` | security | Audit events (filter by action prefix) with chain verification; the read is itself audited |
| `POST /admin/kill-switch` | security | Suspend/resume the whole module (fail closed, 503) |

## Events (outbox)
`discovery.session.started`, `discovery.session.submitted`, `discovery.score.ready`, `discovery.profile.updated`,
`discovery.recommendation.generated`, `discovery.report.review_requested`, `discovery.report.approved`,
`discovery.consent.granted`, `discovery.consent.withdrawn`, `discovery.assignment.conflict_declared`, `discovery.assignment.changed`, `discovery.instrument.suspended`,
`catalog.admission_rule.published`, `catalog.admission_rule.expired`.
Payloads carry ids and states only, plus schema version, correlation id and actor. Delivery is at-least-once; the
journey consumer is idempotent.
