// Server-side authorization (spec §2): identity, tenant, role, relationship to the student,
// purpose, consent scope. UI hiding is never authorization. Every denial can carry a
// `securityEvent` that the request wrapper records AFTER the failed transaction rolls back.
import { CONSENT_SCOPES, POLICY } from './config.js';
import { forbidden, notFound } from './errors.js';

/** Age on a given date from an ISO birth date (synthetic students carry one). */
export function ageOn(student, now) {
  const b = new Date(student.date_of_birth);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

export const guardianRequired = (student, now) => ageOn(student, now) < POLICY.guardian_required_below_age;

/** Latest consent record per (scope, party role). */
function latestByParty(db, studentId) {
  const latest = {};
  for (const r of Object.values(db.consent_records)) {
    if (r.subject_id !== studentId) continue;
    const k = `${r.scope}:${r.actor_role}`;
    if (!latest[k] || latest[k].seq < r.seq) latest[k] = r;
  }
  return latest;
}

/**
 * Derived consent state. A scope is active only when every REQUIRED party's latest record is
 * "granted". assessment_processing needs the student's assent plus the guardian's authorization
 * while the student is under the (placeholder) policy age.
 */
export function consentState(db, studentId, now) {
  const student = db.users[studentId];
  const latest = latestByParty(db, studentId);
  const needGuardian = guardianRequired(student, now);
  const scopes = {};
  for (const scope of Object.keys(CONSENT_SCOPES)) {
    const required = ['student'];
    if (scope === 'assessment_processing' && needGuardian) required.push('guardian');
    const parties = {};
    for (const role of ['student', 'guardian']) {
      const r = latest[`${scope}:${role}`];
      parties[role] = r ? { state: r.state, record_id: r.id, at: r.created_at } : { state: 'none', record_id: null, at: null };
    }
    const pending = required.filter((role) => parties[role].state === 'none');
    const withdrawn = required.filter((role) => parties[role].state === 'withdrawn');
    scopes[scope] = {
      required_parties: required,
      parties,
      active: required.every((role) => parties[role].state === 'granted'),
      pending,
      withdrawn,
      status: required.every((role) => parties[role].state === 'granted') ? 'active' : withdrawn.length ? 'withdrawn' : pending.length ? 'pending' : 'inactive',
    };
  }
  return {
    student_id: studentId,
    guardian_required: needGuardian,
    policy_version: POLICY.policy_version,
    legal_basis_ref: POLICY.legal_basis_ref,
    scopes,
  };
}

const deny = (ctx, student, reason, detail) => {
  throw forbidden(reason, detail, {
    action: 'security.access_denied',
    tenant_id: student?.tenant_id ?? ctx.actor?.tenant_id ?? null,
    subject_ref: student ? `student:${student.id}` : null,
    meta: { reason, intent: ctx.intent ?? null },
  });
};

const processingActive = (c) => c.scopes.assessment_processing.active;

/**
 * intent => who may do it and under which consent. `student` rules apply when actor === student.
 * null consent = no consent needed (rights of access / consent management / asking for help).
 */
const RULES = {
  'consent.read': { student: null, guardian: null, counselor: null },
  'consent.write': { student: null, guardian: null },
  'profile.read': { student: null, counselor: 'counselor_sharing' },
  'evidence.read': { student: null, counselor: 'counselor_sharing' },
  'evidence.write': { student: 'assessment_processing' },
  'evidence.verify': { counselor: 'counselor_sharing' },
  'session.create': { student: 'assessment_processing' },
  'session.write': { student: 'assessment_processing' },
  'session.read': { student: null },
  'responses.read_raw': { student: null, counselor: 'counselor_sharing' },
  'score.read': { student: null, counselor: 'counselor_sharing' },
  'score.replay': { student: null, counselor: 'counselor_sharing' },
  'recommendation.create': { student: 'assessment_processing' },
  'recommendation.read': { student: null, counselor: 'counselor_sharing' },
  'preferences.write': { student: null },
  'aspiration.write': { student: 'assessment_processing' },
  'case.open': { student: null, counselor: 'counselor_sharing' },
  'case.review': { counselor: 'counselor_sharing' },
  'override.create': { counselor: 'counselor_sharing' },
  'report.generate': { student: 'assessment_processing', counselor: 'counselor_sharing' },
  'report.read': { student: null, counselor: 'counselor_sharing' },
  'report.approve': { counselor: 'counselor_sharing' },
  'report.share': { student: 'assessment_processing' },
  'advisor.explain': { student: 'advisor_explanation', counselor: 'advisor_explanation' },
  'guardian.summary': { guardian: 'guardian_summary_sharing' },
  'journey.read': { student: null },
};

/**
 * Authorize `ctx.actor` for `intent` on `studentId`. Returns { student, consent }.
 * Throws a 403 AppError (with a securityEvent) or 404.
 */
export function authorize(ctx, studentId, intent) {
  const { db, actor } = ctx;
  ctx.intent = intent;
  const student = db.users[studentId];
  if (!student || student.role !== 'student') throw notFound('student');
  if (!actor) deny(ctx, student, 'unauthenticated');

  // 1. tenant isolation (AC-02)
  if (actor.tenant_id !== student.tenant_id) deny(ctx, student, 'cross_tenant', 'This student belongs to another school.');

  const rule = RULES[intent];
  if (!rule) deny(ctx, student, 'unknown_intent');
  if (!(actor.role in rule)) deny(ctx, student, 'role_not_permitted', 'Your role cannot do this.');

  // 2. relationship
  if (actor.role === 'student' && actor.id !== studentId) deny(ctx, student, 'not_self');
  if (actor.role === 'guardian' && !db.guardian_links.some((l) => l.guardian_id === actor.id && l.student_id === studentId)) deny(ctx, student, 'no_guardian_relationship');
  if (actor.role === 'counselor' && !db.counselor_assignments.some((a) => a.counselor_id === actor.id && a.student_id === studentId)) deny(ctx, student, 'not_assigned_counselor', 'You are not the assigned counselor.');

  // 3. consent scope + purpose
  const consent = consentState(db, studentId, ctx.now);
  const needScope = rule[actor.role];
  if (needScope) {
    if (actor.role !== 'student' && !processingActive(consent)) deny(ctx, student, 'consent_processing_inactive', 'Processing consent is not active for this student.');
    if (!consent.scopes[needScope].active) {
      deny(ctx, student, needScope === 'assessment_processing' ? 'consent_required' : 'consent_scope_inactive', 'The required consent is not active.');
    }
  }
  return { student, consent };
}

/** Roles that never touch student content (platform / governance roles). */
export const PLATFORM_ROLES = ['psychometric_lead', 'catalog_steward', 'tenant_admin', 'platform_security'];

export function requireRole(ctx, ...roles) {
  if (!ctx.actor || !roles.includes(ctx.actor.role)) {
    throw forbidden('role_not_permitted', 'Your role cannot do this.', { action: 'security.access_denied', tenant_id: ctx.actor?.tenant_id ?? null, subject_ref: null, meta: { reason: 'role_not_permitted', needed: roles } });
  }
}
