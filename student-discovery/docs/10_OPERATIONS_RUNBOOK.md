# 10 · Operations runbook (local prototype)

Scope: running and inspecting the *prototype*. The production runbook (freshness SLAs, rights requests, DR) cannot be written
until the platform, owners and legal decisions exist (see `12`).

## Start, stop, reset
| Task | How |
|---|---|
| Start | `npm start` → `http://127.0.0.1:4180` (`PORT`, `HOST`, `DATA_FILE`, `SYNTHETIC_MODE`, optional `CHROMIUM_PATH` env vars) |
| Reset to seed data | stop the server, `npm run reset`, start again (seeded rule dates are relative to the day of seeding) |
| In-memory run | `DATA_FILE= npm start` |
| Backup / restore | copy `data/db.json` (a single JSON document; writes are atomic via temp file + rename) |
| Fail-closed check | `SYNTHETIC_MODE=false npm start`: exploratory instruments refuse to start |

Do not bind `HOST=0.0.0.0` on a shared network: there is no real authentication.

## API contract
`docs/api/openapi.yaml` and `docs/api/events.schema.json` describe every route and event. `npm run test:contract` checks them against the running server; run it after changing any route, response or event.

## Health and integrity
* `GET /api/health` (liveness, mode, incident flag).
* **Control tower** (`#/admin/control`, tenant admin or security): catalog freshness, outbox backlog/retries, audit chain status, denied-access counts.
* **Audit chain**: `GET /admin/audit` returns `chain.ok`; a break reports the first bad `seq`. Events are append-only and hash-linked.
* **Outbox**: undelivered events show as "waiting" / "being retried"; delivery is at-least-once and consumers are idempotent.

## Incident handling
1. Security role → Control tower → **Suspend the module** (reason required). Students, guardians and counselors get 503 and an incident banner; governance screens stay reachable.
2. Investigate with the audit log (filter by action prefix, e.g. `security.`). Denials and kill-switch changes are themselves audited.
3. Resume the module with the same control. State is untouched by suspension.

## Routine operations that exist
| Situation | Where |
|---|---|
| A rule is past its review date | Control tower shows it stale; Steward 1 drafts a new version, Steward 2 verifies and publishes (four-eyes). `catalog.admission_rule.expired` is emitted once |
| An instrument has a defect | Psychometric lead → Instruments → **Suspend** (reason). In-progress sessions stop accepting answers; saved answers are kept; resume restores them |
| A student withdraws consent | Immediate: sessions suspend, shares revoke, counselor/guardian access closes. A **retention task** is queued for a human/policy decision; nothing is auto-deleted and audit records stay |
| Counselor needs to see answers | Case 360 → Answers tab. Needs the student's separate answer-sharing consent as well as counselor sharing. The read and its stated purpose are audited |
| A counselor has a conflict of interest | The counselor: queue → **Step away** (reason ≥ 10 characters; works even for a student who shared nothing). Access ends at once and open cases become unowned. The school admin: **Counselor assignments** → choose another counselor of the same school (history is kept). The counselor who stepped away is never offered for that student |
| A student has no counselor | School admin → Counselor assignments lists them first |
| An approved report is needed as a file | Report page → **Download PDF** (Arabic or English, matching the screen). It needs Chromium/Chrome on the server machine (`CHROMIUM_PATH`, or `/opt/pw-browsers`, or a system install); otherwise the screen says so and print-to-PDF still works. Each download is audited (`report.exported`); a failed render is audited as `report.export_failed` |

## Not available yet (needs decisions or a platform)
Rights-request handling (access/correction/deletion), retention schedules and deletion jobs, key management and backup encryption,
restore drills, monitoring/alerting, freshness SLA ownership, on-call/incident escalation, release and rollback process.
