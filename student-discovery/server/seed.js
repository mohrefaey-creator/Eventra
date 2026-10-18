// Seeds SYNTHETIC personas and demo activity. Nothing here is a real person or a real record.
// Demo activity is created by calling the same services the API uses, so score hashes,
// audit chain and outbox events are genuine rather than hand-written.
import { randomUUID } from 'node:crypto';
import { PROGRAMS } from '../domain/catalog/programs.js';
import { buildSeedRuleSnapshots } from '../domain/catalog/seedRules.js';
import { getInstrument } from '../domain/instruments/registry.js';
import { audit, drainOutbox, journeySubscriber } from './audit.js';
import { setConsent } from './services/consent.js';
import { createSession, putResponse, submitSession } from './services/assessments.js';
import { putEvidence, verifyEvidence, putAspiration } from './services/student.js';
import { createRecommendation } from './services/recommendations.js';
import { openCase, addNote } from './services/counselor.js';
import { generateReport, requestReview } from './services/reports.js';
import { createRuleDraft } from './services/admin.js';
import { POLICY } from './config.js';

const L = (ar, en) => ({ 'ar-SA': ar, en });
const DAY = 86400000;
const YEAR = 365.25 * DAY;

export const TENANTS = {
  'school-a': L('مدرسة العرض (أ) — وهمية', 'Demo School A — fictional'),
  'school-b': L('مدرسة العرض (ب) — وهمية', 'Demo School B — fictional'),
  platform: L('المنصة', 'Platform'),
};

function personas(now) {
  const dob = (years) => new Date(+now - years * YEAR).toISOString().slice(0, 10);
  const u = (id, role, tenant_id, ar, en, extra = {}) => ({ id, role, tenant_id, display_name: L(ar, en), synthetic: true, ...extra });
  return [
    u('user-student-a1', 'student', 'school-a', 'طالب تجريبي أ١', 'Demo Student A1', { grade: 11, date_of_birth: dob(16.4) }),
    u('user-student-a2', 'student', 'school-a', 'طالبة تجريبية أ٢', 'Demo Student A2', { grade: 12, date_of_birth: dob(17.3) }),
    u('user-student-b1', 'student', 'school-b', 'طالب تجريبي ب١', 'Demo Student B1', { grade: 12, date_of_birth: dob(18.4) }),
    u('user-guardian-a1', 'guardian', 'school-a', 'ولي أمر تجريبي أ١', 'Demo Guardian A1'),
    u('user-guardian-a2', 'guardian', 'school-a', 'ولي أمر تجريبي أ٢', 'Demo Guardian A2'),
    u('user-guardian-b1', 'guardian', 'school-b', 'ولي أمر تجريبي ب١', 'Demo Guardian B1'),
    u('user-counselor-a', 'counselor', 'school-a', 'مرشد تجريبي (المدرسة أ)', 'Demo Counselor (School A)'),
    u('user-counselor-b', 'counselor', 'school-b', 'مرشد تجريبي (المدرسة ب)', 'Demo Counselor (School B)'),
    u('user-steward-1', 'catalog_steward', 'platform', 'مسؤول كتالوج تجريبي ١', 'Demo Catalog Steward 1'),
    u('user-steward-2', 'catalog_steward', 'platform', 'مسؤول كتالوج تجريبي ٢', 'Demo Catalog Steward 2'),
    u('user-psych-1', 'psychometric_lead', 'platform', 'قائد قياس نفسي تجريبي ١', 'Demo Psychometric Lead 1'),
    u('user-psych-2', 'psychometric_lead', 'platform', 'قائد قياس نفسي تجريبي ٢', 'Demo Psychometric Lead 2'),
    u('user-tenant-admin-a', 'tenant_admin', 'school-a', 'مدير مدرسة تجريبي (أ)', 'Demo Tenant Admin (School A)'),
    u('user-security', 'platform_security', 'platform', 'مراجع أمن وتدقيق تجريبي', 'Demo Security & Audit Reviewer'),
  ];
}

// Answer patterns for the demo student (deterministic).
const RIASEC_BASE = { RIASEC_I: 5, RIASEC_R: 4, RIASEC_C: 3, RIASEC_A: 2, RIASEC_E: 2, RIASEC_S: 2 };
const SUBJECTS = { math: 5, physics: 4, chemistry: 3, biology: 2, computer: 5, english: 4, arabic: 3, islamic: 3, social: 2, business: 3, art: 2, pe: 3 };
const SKILLS = { analytical: 4, numeracy: 5, communication: 3, creativity: 3, collaboration: 3, organization: 4, digital: 5, practical: 3 };
const VALUES = { security: 3, helping: 2, creativity: 3, income: 4, autonomy: 4, leadership: 2, learning: 5, balance: 3 };

function demoAnswer(instrument, item, idx) {
  const clamp = (n) => Math.max(1, Math.min(5, n));
  switch (instrument.instrument_id) {
    case 'interest_exploratory':
      return clamp(RIASEC_BASE[item.construct] + [0, -1, 0, 0, -1, 0][idx % 6]);
    case 'subject_preference_exploratory':
      return SUBJECTS[item.construct.slice(5)];
    case 'skills_confidence_selfreport':
      return SKILLS[item.construct.slice(6)];
    case 'work_values_exploratory':
      return VALUES[item.construct.slice(6)];
    default:
      return 'en';
  }
}

export function seedDatabase(store, now) {
  store.tx((db) => {
    db.meta.seeded_at = now.toISOString();
    for (const p of personas(now)) db.users[p.id] = p;
    db.guardian_links.push(
      { guardian_id: 'user-guardian-a1', student_id: 'user-student-a1' },
      { guardian_id: 'user-guardian-a2', student_id: 'user-student-a2' },
      { guardian_id: 'user-guardian-b1', student_id: 'user-student-b1' },
    );
    db.counselor_assignments.push(
      { counselor_id: 'user-counselor-a', student_id: 'user-student-a1' },
      { counselor_id: 'user-counselor-a', student_id: 'user-student-a2' },
      { counselor_id: 'user-counselor-b', student_id: 'user-student-b1' },
    );
    for (const p of PROGRAMS) db.programs[p.program_id] = { program_id: p.program_id, status: p.status };
    for (const r of buildSeedRuleSnapshots(now, randomUUID)) db.rule_snapshots[r.id] = r;
  });

  const base = { store, requestId: 'seed', now, config: { syntheticMode: true } };
  const as = (id) => ({ ...base, db: store.db, actor: store.db.users[id] });
  const seedTx = (fn) => store.tx(() => fn());

  // ---- consent: A2 fully consented (student + guardian), B1 (adult) consented, A1 intentionally none
  seedTx(() => {
    for (const scope of ['assessment_processing', 'counselor_sharing', 'guardian_summary_sharing', 'advisor_explanation', 'aggregate_analytics']) setConsent(as('user-student-a2'), 'user-student-a2', { scope, granted: true });
    setConsent(as('user-guardian-a2'), 'user-student-a2', { scope: 'assessment_processing', granted: true });
    for (const scope of ['assessment_processing', 'counselor_sharing', 'aggregate_analytics']) setConsent(as('user-student-b1'), 'user-student-b1', { scope, granted: true });
  });

  // ---- A2: all five scored modules sealed
  const complete = (studentId, instrumentId) => {
    const ctx = as(studentId);
    const inst = getInstrument(instrumentId);
    const { session } = createSession(ctx, studentId, { instrument_version_id: inst.instrument_version_id, locale: 'en', idempotency_key: `seed-${studentId}-${instrumentId}` });
    inst.items.forEach((it, idx) => putResponse(as(studentId), session.session_id, it.item_id, { value: demoAnswer(inst, it, idx) }));
    submitSession(as(studentId), session.session_id, {});
  };
  seedTx(() => {
    for (const id of ['interest_exploratory', 'subject_preference_exploratory', 'skills_confidence_selfreport', 'work_values_exploratory', 'student_constraints']) complete('user-student-a2', id);
    complete('user-student-b1', 'interest_exploratory');
  });

  // ---- A2 academic evidence: some verified by the counselor, some left unverified on purpose
  seedTx(() => {
    const st = as('user-student-a2');
    const entries = [['pathway', 'cs_engineering'], ['secondary_percentage', 91], ['gat', 84], ['subject_grade:math', 92], ['subject_grade:physics', 85], ['subject_grade:computer', 88], ['subject_grade:english', 90]];
    const created = Object.fromEntries(entries.map(([t, v]) => [t, putEvidence(st, 'user-student-a2', t, { value: v }).evidence]));
    const co = as('user-counselor-a');
    for (const t of ['pathway', 'secondary_percentage', 'subject_grade:math']) verifyEvidence(co, 'user-student-a2', created[t].id, { note: 'Checked against the (synthetic) school transcript.' });
  });

  seedTx(() => {
    const st = as('user-student-a2');
    putAspiration(st, 'user-student-a2', 'prog-demo-cs', { note: 'Interested in software.' });
    putAspiration(st, 'user-student-a2', 'prog-demo-nurs', { note: 'Family suggestion.' });
    createRecommendation(st, 'user-student-a2', {});
    openCase(st, 'user-student-a2', { reason_code: 'appeal', message: 'I am also curious about Architecture. Why is it not higher in my list?', subject_ref: 'program:prog-demo-arch' });
    const { report } = generateReport(st, 'user-student-a2');
    requestReview(st, report.id);
    addNote(as('user-counselor-a'), 'user-student-a2', { body: 'Wants to explore both computing and health options. Revisit after SAAT result.', visibility: 'counselor_only' });
  });

  // ---- a pending rule draft (authored by steward 1) so the four-eyes publish can be tried with steward 2
  seedTx(() => {
    createRuleDraft(as('user-steward-1'), {
      program_id: 'prog-demo-nurs',
      cycle: '2027',
      conditions: [{ key: 'pathway', value: ['health_life', 'general'] }, { key: 'secondary_percentage', value: 80 }, { key: 'gat', value: 70 }, { key: 'saat', value: 65 }],
      source: { publisher: 'Demo University Admissions Office (fictional)', source_url: 'https://example.invalid/demo-admissions/prog-demo-nurs/2027-r2', published_at: new Date(+now - 5 * DAY).toISOString(), captured_at: new Date(+now - 2 * DAY).toISOString() },
      effective_from: new Date(+now - 5 * DAY).toISOString(),
      effective_to: new Date(+now + 300 * DAY).toISOString(),
      review_due_at: new Date(+now + 180 * DAY).toISOString(),
      competitive: true,
      application_window: { opens: new Date(+now - 30 * DAY).toISOString(), closes: new Date(+now + 120 * DAY).toISOString() },
    });
  });

  store.tx((db) => {
    audit({ ...base, db, actor: null }, { action: 'seed.completed', tenant_id: null, subject_ref: 'module:student_discovery', meta: { synthetic: true, policy_version: POLICY.policy_version } });
    drainOutbox(db, [journeySubscriber], now);
  });
}
