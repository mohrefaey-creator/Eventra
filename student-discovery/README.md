# NextMind · Student Discovery — local prototype (Arabic / English)

A web app that runs on your own computer and implements the **Student Discovery, Aptitude & University-Major Fit**
specification (`Placement_.md`): a validated-style interest assessment flow, subject / skills / values modules, an
independent admission-requirements gate, transparent major matching, counselor and guardian workflows, signed reports,
audit and governance screens, in **Arabic (RTL, default) and English (LTR)**.

> **This is a synthetic-data prototype, not a production system.**
> The specification itself says that, with gates G0–G6 unclosed, only design and prototyping with synthetic data may
> proceed. So: every person is a made-up persona, every university/program/admission rule is **fictional**, the
> instruments are original **unvalidated exploratory** questionnaires, and aptitude testing is **on hold**. Nothing here
> may be used with real students. See [docs/11_GATE_DECISION_RECORD.md](docs/11_GATE_DECISION_RECORD.md).

## Run it

Requires Node.js 20 or newer. There are **no runtime dependencies** (nothing to install to run it).

```bash
cd student-discovery
npm start                      # http://127.0.0.1:4180
```

Open the URL, pick a persona, and explore. The first start creates `data/db.json` (git-ignored) with synthetic data.
`npm run reset` deletes it so it is re-seeded (do this occasionally: seeded rule dates are relative to the day they
were created).

| Setting | Default | Notes |
|---|---|---|
| `PORT` | `4180` | |
| `HOST` | `127.0.0.1` | Keep it local. The prototype has no real authentication. |
| `DATA_FILE` | `data/db.json` | Set to an empty string for an in-memory database. |
| `SYNTHETIC_MODE` | `true` | Set `false` to see the **fail-closed** behavior: exploratory instruments refuse to start. |

## A five-minute tour

| Try this | Persona | What to notice |
|---|---|---|
| Consent flow for a minor | **Demo Student A1**, then **Demo Guardian A1** | Nothing is pre-ticked. A student under the (placeholder) age threshold needs their own assent **and** the guardian's authorization before any question can be answered. |
| Take the interest module | Student A1 | One accessible radio group per question, autosave, resume after reload, works offline (queued, retried). Submitting seals the attempt. |
| Read results | **Demo Student A2** (pre-filled) | Six interest bars with numbers, "insufficient data" instead of zero, no percentile, no Holland code, "Verify the calculation" replays the score from the saved answers. |
| Major suggestions | Student A2 → *Majors* | Interest fit, academic readiness and admission conditions are shown **separately**. Look for *Source outdated*, *Sources conflict*, *Not evaluated*. No admission probability appears anywhere. |
| Ask the explainer | Student A2 → a program → *Explain this major* | Try *Psychology* (conflicting source): it **abstains** and routes to a human. |
| Review as counselor | **Demo Counselor (School A)** | Case queue with reasons, consent-gated access, evidence verification with a note, signed interpretation notes, hash-bound report approval. Every view is logged. |
| Four-eyes publishing | **Catalog Steward 1** then **2** | The author of a rule draft cannot publish it. |
| Governance | **Psychometric Lead 1**, **Security & Audit** | Instrument states, why publication is blocked, kill switch, hash-chained audit log, small-cell suppression in the control tower. |
| Tenant isolation | **Demo Student B1** | School B cannot reach School A's data; the attempt is itself audited. |

Switch language any time with the button in the header. Settings has text size, high contrast and reduced motion.

## What is implemented

* **Journeys J-01…J-06**, screens **DISC-01…DISC-14** (see [docs/07](docs/07_UI_SCREEN_SPEC.md)).
* **Deterministic scoring** in pure, versioned code (`domain/`): mean and `25 × (mean − 1)` per interest area, minimum-completion
  rule, deterministic tie handling, `insufficient_data` for thin areas, never zero-imputation, input and execution hashes, replay.
* **Independent admission gate** with the spec's six outcomes; unverified evidence never causes a hard rejection;
  stale/conflicting/absent sources never read as eligible; `acceptance_probability` is always `null`.
* **Matching** with three separate axes; centred-cosine interest similarity; strict (non-renormalized) subject and
  value alignment; the spec's weighted composite is **refused** because a required input (demonstrated skills) does not exist.
* **Server-side authorization on every request**: tenant, role, relationship, consent scope and purpose
  ([docs/08](docs/08_THREAT_MODEL_AND_PRIVACY.md)); append-only hash-chained audit; transactional outbox; kill switch;
  idempotency keys; optimistic concurrency; RFC 7807 errors; CSRF; rate limiting; strict CSP.
* **Quality gates**: unit, API, security and browser end-to-end tests, and a WCAG 2.2 AA automated scan
  ([docs/09](docs/09_TEST_PLAN_EVIDENCE.md)).

## What is deliberately *not* implemented

Not forgotten, but excluded by the spec or blocked on decisions only people can make:

* **Aptitude / cognitive tasks**: spec §4.1 puts them on HOLD until a licensed, validated, fairness-tested instrument exists. The module is shown, with the reason, and cannot start.
* **O\*NET or any third-party licensed instrument**: none is assumed. The items are original wording (`domain/instruments/`).
* **Real Saudi universities, programs, thresholds, admission cycles, or official integrations**: all fictional; a real catalog needs source-verified stewardship (§5.5, D-03).
* **Norms, percentiles, IRT scaling, admission probabilities, "AI placement"**: excluded (§1.4, §5.1).
* **External AI models**: the advisor is a deterministic explainer (template wording over structured results). No student data leaves the machine.
* **Production concerns**: PostgreSQL, encryption at rest, real identity/consent services, retention jobs, rights-request workflows, PDF generation (the report prints cleanly to PDF from the browser), penetration testing, load and DR drills.
* **Native-speaker review of the Arabic copy** and manual assistive-technology testing: needed before any pilot.

The full list, with owners from the spec's risk register, is in [docs/12_OPEN_ITEMS.md](docs/12_OPEN_ITEMS.md).

## Commands

```bash
npm test            # unit + API + security tests (node:test)           ~2 s
npm run lint        # unused imports / undefined names (ESLint)
npm run test:e2e    # drives the real app in Chromium, both locales, plus an axe-core accessibility scan (~40 s)
npm run check       # lint + tests
python3 web/i18n/build_dictionaries.py   # regenerate the two UI dictionaries from the single source
```

`npm run test:e2e` needs Chromium. It looks in `$CHROMIUM_PATH`, then `$PLAYWRIGHT_BROWSERS_PATH` (default
`/opt/pw-browsers`); screenshots land in `test/e2e/out/`.

## Layout

```
domain/        pure, deterministic logic: instruments, scoring, matching, admission gate, fictional catalog
server/        zero-dependency HTTP server: policy (authorization), services, audit/outbox, seed data
web/           the app: vanilla ES modules, no build step, CSP-safe, i18n/ar-SA.json + en.json
test/          unit/, api/ (incl. security), e2e/ (Chromium + axe)
docs/          the spec's §17 artifact set, condensed and honest about gaps
```

The layout deliberately mirrors the spec's candidate structure (§13) so the pieces can move into the real NextMind
monorepo: `domain/` ↔ `packages/domain/student-discovery`, `server/` ↔ `services/api/src/modules/student-discovery`.
The identity endpoints (`/api/v1/identity-stub`), the consent endpoints and the journey milestones are stand-ins for the shared services the spec says to reuse, and are named as such in code and docs.
