# 07 · UI screens (DISC-01 … DISC-14), Arabic and English

Implemented as hash routes in `web/js/views/`. Both languages come from one source (`web/i18n/build_dictionaries.py`);
a unit test verifies key parity, placeholder parity, and that every domain enumeration the UI can show has a label.

| Screen | Route | File | Spec states covered | Gaps |
|---|---|---|---|---|
| DISC-01 Landing | `#/discover` | `landing.js` | consent needed | "not eligible" (grade outside 10–12) not modelled |
| DISC-02 Consent | `#/consent` | `consent.js` | denied (nothing pre-ticked), revoked, guardian pending, layered notice | "expired" consent not modelled |
| DISC-03 Dashboard | `#/dashboard` | `dashboard.js` | partially complete, resume, instrument suspended ("needs review"), on hold (aptitude), locked without consent | — |
| DISC-04 Item runner | `#/run/:sid` | `runner.js` | network loss (queued + retry), skip permitted, duplicate submit, sealed, paused by consent, review step | no timed items exist |
| DISC-05 Result explorer | `#/results` | `results.js` | insufficient data, partial ranking, attempt history, provenance, replay, counselor note | automatic "retest conflict" detection not built (both attempts are shown) |
| DISC-06 Major explorer | `#/majors` (+ `#/compare`) | `majors.js`, `compare.js` | filters, compare ≤ 3, fit vs readiness vs eligibility, stale rules, no suggestions, pinned aspiration, "what changed" | — |
| DISC-07 Program detail | `#/program/:pid` | `program.js` | why-fit table, source with dates, source conflict, unknown requirement | — |
| DISC-08 Personal roadmap | `#/roadmap` | `roadmap.js` | gaps with owners, counselor request (no booking) | "owner missing" and "task overdue" need a task model; tasks are derived, without due dates |
| DISC-09 Student report | `#/report`, `#/report/:rid` | `reports.js`, `report.js` | approval pending, DRAFT watermark, share with expiry, **Download PDF** (approved reports; Arabic or English; falls back to print when no browser is installed), print stylesheet | PDF needs Chromium/Chrome on the server machine; no PDF/UA validation |
| DISC-10 Counselor Case 360 | `#/counselor/student/:id` | `case360.js` | evidence, results, notes, signed notes, appeals/cases, report review, raw answers (logged; needs the separate raw-answer consent, otherwise a clear message), step-away link | — |
| DISC-11 Guardian view | `#/guardian` | `guardian.js` | authorize/withdraw, no access when student has not shared, shared reports, **several children with a selector** (each child has its own consent and sharing state) | — |
| DISC-12 Admin instruments | `#/admin/instruments` | `adminInstruments.js` | state machine, licence/validation, blocked publication, suspend/resume, expired licence logic | no evidence-recording form (nothing can be unblocked) |
| DISC-13 Admin catalog | `#/admin/catalog` | `adminCatalog.js` | rule sources, freshness, drafts, four-eyes publish, conflicting publishers, expired rules | — |
| DISC-14 Control Tower | `#/admin/control` | `control.js` | suppressed small cells, catalog freshness, audit chain, kill switch ("incident mode") | no time series |
| Step away (conflict of interest) | `#/counselor/away/:id` | `counselorAway.js` | reachable from every queue row, also for a student who shared nothing; reason ≥ 10 characters; student not found/not yours reads "not available" | — |
| Counselor assignments (school admin, additional to the spec) | `#/admin/assignments` | `adminAssignments.js` | students without a counselor first, who stepped away and when (never why), reassign with a reason, a counselor who stepped away is not offered, counselor load | no notification to the admin when a counselor steps away (the event exists) |
| Supporting | `#/login`, `#/evidence`, `#/help`, `#/settings` | `login.js`, `evidence.js`, `help.js`, `settings.js` | persona picker; academic evidence with verification state; appeals; accessibility prefs | — |

## Interaction and accessibility behaviour (spec §9)
* Logical tab order; one fieldset + legend per question with native radio keyboard behaviour; visible focus (3 px) and 44 px minimum targets.
* No colour-only status: every chip has a glyph and text; bars show their number; ties and "insufficient data" are text.
* Locale-specific numerals/dates (Arabic-Indic digits, Gregorian) while identifiers/hashes stay LTR and untranslated. Digits typed in Arabic or Persian are accepted for scores.
* CSS logical properties; navigation follows reading direction; **data bars keep a left-to-right 0→100 scale** in both languages.
* Visible confirmations (warning before a consent withdrawal is saved, acknowledgement before an incomplete submit); no pre-ticked or coercive consent.
* Text size, high contrast and reduced motion are stored per student and applied on load; `prefers-color-scheme` dark mode and `prefers-reduced-motion` are honoured.
* Route changes move focus to the page heading and announce the title in a polite live region.

## Arabic vocabulary from spec §9
`اكتشف ميولك وقدراتك`, `ليس هناك إجابات صحيحة أو خاطئة في أسئلة الميول`, `الاستعداد الأكاديمي`, `استيفاء شروط القبول`, `البيانات غير مكتملة` and `تحقق مع المرشد`
are used verbatim. Everything else was written by the build team and **needs expert review** (the spec asks for it).
