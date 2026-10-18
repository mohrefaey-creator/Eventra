# 00 · Discovery & reconciliation (WP-00)

The spec (§0.2–0.3) requires inspecting NextMind's real repository, gate records, ADRs, identity/consent policy,
catalogs and design system, producing a requirements-to-code matrix and a discrepancy log, and never inventing or
silently overwriting existing modules.

## What was found

| Item the spec says to review | Found in this workspace | Consequence |
|---|---|---|
| NextMind repository / monorepo | **Not present.** The workspace is `Eventra`, whose existing content is *MirrorLink* (screen mirroring over WebRTC, Android/iOS senders). Unrelated to NextMind. | WP-00 cannot be completed. D-01 stays open. |
| Gate decision records, ADRs | None. The spec's own text says G0/G1 are not closed, G2 is design-conditional, G3–G6 not passed. | Only synthetic-data design/prototyping is authorised. |
| Shared identity, consent, Student Profile, Journey Engine, Approval Inbox, Audit, model gateway | None to integrate with. | Minimal, clearly labelled stand-ins were built (below). |
| University catalog / admissions sources | None. | A fictional catalog is used; no real data is claimed. |
| UI design system | None. | A neutral token-based stylesheet was written. |
| Agent identifiers A01–A09 | None. | None invented; the advisor is a bounded explainer with no agent id. |

## Decisions taken because of that

1. **Stand-alone folder** `student-discovery/` (not mixed into MirrorLink code). Nothing outside this folder was modified.
2. **Stand-ins, each isolated and marked**, replacing shared services that do not exist here:
   | Stand-in | Replaces | Where |
   |---|---|---|
   | Synthetic personas + cookie session | NextMind identity | `/api/v1/identity-stub/*`, `server/http.js` (sessions), `server/seed.js` |
   | Consent records, age-based guardian rule | Shared consent / relationship service | `server/policy.js`, `server/services/consent.js` |
   | Outbox subscriber writing milestones | Journey Engine | `server/audit.js` (`journeySubscriber`) |
   | JSON document store with rollback transactions | PostgreSQL + transactional outbox | `server/store.js` |
3. **Everything else follows the spec's own shapes**: entity names (§7), route names (§8), event names (§8.3), result enums (§5.5), UI vocabulary (§9), advisor tool contract (§10).
4. **Additions the spec does not list**, needed to make the prototype usable: consent endpoints, `/me`, `GET /students/:id/cases`,
   `PATCH /cases/:id`, `POST /students/:id/notes`, report share endpoints, `POST /sessions/:id/replay`, kill switch, audit viewer.

## Discrepancy / deviation log

| # | Spec says | Prototype does | Why / status |
|---|---|---|---|
| 1 | Reuse existing platform services | Builds stand-ins | No platform exists here. Replace per ADR-003 when integrating. |
| 2 | Slice A: "6-question clearly unvalidated illustration" | 36 original items (6 per RIASEC area) plus 4 smaller modules | Gives a realistic flow and exercises minimum-completion rules. Still labelled exploratory/unvalidated on every surface. |
| 3 | Job: "durable worker for score jobs" | Scores computed inside the submit transaction | Prototype scale. The `score_run` / outbox shape is preserved so a worker can take over. |
| 4 | "Encrypt sensitive fields at rest" | **Not done** | Synthetic data only. Must be done before any real data (see open items). |
| 5 | PDF export | **Built, optional:** approved reports download as a tagged PDF (Arabic RTL or English) rendered by an installed Chromium/Chrome (`server/pdf.js`); without one the route answers 501 and the screen offers the browser's print stylesheet | Spec §1.3 allows PDF "only after privacy/retention controls"; those controls (retention schedule, legal basis) do not exist yet, so this is prototype-only. Rendering is tested (tagged, Arabic text extractable) but there is no PDF/UA validator run and no native-speaker review. |
| 6 | OpenAPI YAML (§17 item 7) | **Built:** `docs/api/openapi.yaml` (OpenAPI 3.1) and `docs/api/events.schema.json`, checked against the running server by `npm run test:contract` | The human-readable table in `06_API.md` is kept and drift-tested too. Two dev-only dependencies (`ajv`, `yaml`) were added for the checks; the runtime still has none. |
| 7 | Counselor conflict-of-interest / reassignment edge cases (DISC-10) | **Built:** the assigned counselor can step away from any student on their roster; the school admin reassigns; history is kept; a counselor who stepped away can never be re-assigned to that student | Who may read a conflict reason, notification of the school admin, and a platform-level override are decisions for the authorization matrix (D-09). |
| 8 | Guardian may relate to several students | Guardian UI uses the first linked student | Seed data has one child per guardian. API authorizes per student already. |
| 9 | Hijri/Gregorian date policy | Gregorian dates with Arabic-Indic digits in Arabic | Needs a decision from the product owner / localization lead. |
| 10 | "Four-eyes" for instrument publication | Implemented, but only the *blocked* path is reachable | No instrument has licence/validation evidence, so nothing can pass the blockers. The pure blocker function is unit-tested. |
