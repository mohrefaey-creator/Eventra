# 11 · Gate decision record

> **This document signs nothing and approves nothing.** The specification states that prior audit context shows G0/G1 not closed,
> G2 design-conditional and G3–G6 not passed, and that only design/prototyping with synthetic data may proceed. This prototype
> stays inside that boundary. Gate decisions belong to the named sponsor, legal/privacy, safeguarding, psychometric and
> security owners; the "Decision" column is intentionally blank.

| Gate | Spec definition (§12.3) | Status for this work | Evidence this prototype can contribute | Still missing | Decision / signatory |
|---|---|---|---|---|---|
| **G0/G1** | Signed purpose, boundaries, metrics, backlog, data/consent inventory, budget, legal basis, psychometric plan, sponsor decision | **Not closed** (per spec); not addressed here | Requirement traceability (`01`), data model, consent model draft, open decisions list (`12`) | Sponsor decision, legal basis (D-05), psychometric plan, budget (D-10) | — |
| **G2** | Approved ADRs, exact schemas/APIs, threat model, abuse cases, item-licence decision, catalogue stewardship, UX, synthetic prototype | **Design-conditional** (per spec) | ADRs (`02`), API (`06`), threat model & test evidence (`08`, `09`), working synthetic prototype, UX in two languages | Approval of the ADRs, **item-licence decision (D-02)**, catalogue steward and sources (D-03), real repo reconciliation (D-01) | — |
| **G3** | Secure code review, CI pass, unit/contract/E2E, provenance, least-privilege evidence | **Not passed** | Unit, API/security and E2E suites; lint; independent adversarial review (see `09`) | A formal secure code review by the owning team, CI in the real pipeline, contract tests (OpenAPI), SBOM/dependency scanning | — |
| **G4** | Independent QA/security/accessibility, psychometric sign-off, source validity checks | **Not passed** | Automated accessibility scan | Independent QA, manual assistive-technology testing, native Arabic review, penetration test, psychometric sign-off, verified sources | — |
| **G5** | Approved limited pilot with authorised participants, monitoring, stop criteria | **Not permitted** while G0–G4 are open | — | Everything above; ethics/education approvals; pre-registered pilot design (§15) | — |
| **G6** | Production release, runbooks, DR evidence, retention/incident practice, sponsor sign-off | **Not passed** | Prototype runbook (`10`) | Production runbooks, DR/restore drills, retention and incident practice | — |

## Standing rule for this repository
No live minor or student data, no production connections, no public rollout, no irreversible external actions, no pilot with real
students without documented sponsor, safeguarding, legal/privacy **and** gate approvals. Where the real repository or a signed ADR
disagrees with this design, stop and raise a change request (spec header; `00`).
