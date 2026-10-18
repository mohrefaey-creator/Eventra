// Server-side authorization (spec §2): identity, tenant, role, relationship to the student,
// purpose, consent scope. UI hiding is never authorization. Every denial can carry a
// `securityEvent` that the request wrapper records AFTER the failed transaction rolls back.
import { CONSENT_SCOPES, POLICY } from './config.js';
import { forbidden } from './errors.js';
import { own } from '../domain/util.js';

/** Age on a given date from an ISO birth date; NaN when the date is missing or invalid. */
export function ageOn(student, now) {
  const b = new Date(student?.date_of_birth);
  if (Number.isNaN(+b)) return Number.NaN;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

/** Fails closed: an unknown age is treated as a minor. */
export function guardianRequired(student, now) {
  const age = ageOn(student, now);
  return Number.isNaN(age) || age < POLICY.guardian_required_below_age;
}

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

/**
 * `reason` is what the audit log records. `publicReason` is what the caller sees: identity-related
 * denials all read "not_available", so a caller cannot tell "no such student" from "someone else's
 * student" (no existence oracle), while the audit trail keeps the true reason.
 */
const deny = (ctx, student, reason, detail, publicReason = reason) => {
  throw forbidden(publicReason, detail, {
    action: 'security.access_denied',
    tenant_id: student?.tenant_id ?? ctx.actor?.tenant_id ?? null,
    subject_ref: student ? `student:${student.id}` : null,
    meta: { reason, intent: ctx.intent ?? null },
  });
};

/** The uniform response for any id the caller may not know about (unknown, other school, someone else's). */
export function denyUnavailable(ctx, auditReason, student = null, subjectRef = null) {
  ctx.intent ??= null;
  throw forbidden('not_available', 'Not found, or not available to you.', {
    action: 'security.access_denied',
    tenant_id: ctx.actor?.tenant_id ?? null, // attributed to the caller's school: probing must not show up in the target school's counters
    subject_ref: subjectRef ?? (student ? `student:${student.id}` : null),
    meta: { reason: auditReason, intent: ctx.intent },
  });
}

/**
 * intent => who may do it and which consent scopes must be active (string, array or null).
 * null = no consent needed (rights of access, consent management, asking for help).
 * Whenever any scope is required, assessment_processing must also be active, for every role.
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
  // Individual answers are a separate visibility class from scored results: the student opts in to each.
  'responses.read_raw': { student: null, counselor: ['counselor_sharing', 'raw_answer_sharing'] },
  'score.read': { student: null, counselor: 'counselor_sharing' },
  'score.replay': { student: null, counselor: 'counselor_sharing' },
  'recommendation.create': { student: 'assessment_processing' },
  'recommendation.read': { student: null, counselor: 'counselor_sharing' },
  'preferences.write': { student: null },
  'aspiration.write': { student: 'assessment_processing' },
  'case.open': { student: null, counselor: 'counselor_sharing' },
  'case.review': { counselor: 'counselor_sharing' },
  'override.create': { counselor: 'counselor_sharing' },
  // Separation of duties: only the student creates a report; only a counselor approves it.
  'report.generate': { student: 'assessment_processing' },
  'report.read': { student: null, counselor: 'counselor_sharing' },
  'report.approve': { counselor: 'counselor_sharing' },
  'report.share': { student: 'assessment_processing' },
  // The explainer reads scores, so a counselor needs the sharing scope as well as the student's explainer opt-in.
  'advisor.explain': { student: 'advisor_explanation', counselor: ['counselor_sharing', 'advisor_explanation'] },
  'guardian.summary': { guardian: 'guardian_summary_sharing' },
  'journey.read': { student: null },
};

export const linkActive = (l, actorId, studentId, now) => l.guardian_id === actorId && l.student_id === studentId && !l.revoked_at && (!l.expires_at || new Date(l.expires_at) > now);

// An assignment row is history once it has ended; only the open one gives a counselor access.
export const activeAssignment = (db, studentId) => db.counselor_assignments.find((a) => a.student_id === studentId && !a.ended_at) ?? null;
export const isAssigned = (db, counselorId, studentId) => db.counselor_assignments.some((a) => a.counselor_id === counselorId && a.student_id === studentId && !a.ended_at);

/**
 * Authorize `ctx.actor` for `intent` on `studentId`. Returns { student, consent }.
 * Order: authenticated → role may ever do this → student exists → tenant → relationship → consent.
 */
export function authorize(ctx, studentId, intent) {
  const { db, actor } = ctx;
  ctx.intent = intent;
  if (!actor) deny(ctx, null, 'unauthenticated');
  const rule = RULES[intent];
  if (!rule) deny(ctx, null, 'unknown_intent');
  // The role check needs no student, so it cannot reveal whether the student exists.
  if (!Object.hasOwn(rule, actor.role)) deny(ctx, null, 'role_not_permitted', 'Your role cannot do this.');

  const student = own(db.users, studentId);
  if (!student || student.role !== 'student') denyUnavailable(ctx, 'not_found');
  if (actor.tenant_id !== student.tenant_id) denyUnavailable(ctx, 'cross_tenant', student); // AC-02

  if (actor.role === 'student' && actor.id !== studentId) deny(ctx, student, 'not_self', undefined, 'not_available');
  if (actor.role === 'guardian') {
    if (!db.guardian_links.some((l) => linkActive(l, actor.id, studentId, ctx.now))) deny(ctx, student, 'no_guardian_relationship', undefined, 'not_available');
    // A guardian decides only for a minor; for an adult student consent belongs to the student alone.
    if ((intent === 'consent.read' || intent === 'consent.write') && !guardianRequired(student, ctx.now)) deny(ctx, student, 'guardian_not_applicable', undefined, 'not_available');
  }
  if (actor.role === 'counselor' && !isAssigned(db, actor.id, studentId)) deny(ctx, student, 'not_assigned_counselor', undefined, 'not_available');

  const consent = consentState(db, studentId, ctx.now);
  const needScopes = [].concat(rule[actor.role] ?? []);
  if (needScopes.length) {
    if (!consent.scopes.assessment_processing.active) {
      deny(ctx, student, actor.role === 'student' ? 'consent_required' : 'consent_processing_inactive', 'Processing consent is not active for this student.');
    }
    for (const scope of needScopes) {
      if (!consent.scopes[scope].active) deny(ctx, student, scope === 'assessment_processing' ? 'consent_required' : 'consent_scope_inactive', 'The required consent is not active.');
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
