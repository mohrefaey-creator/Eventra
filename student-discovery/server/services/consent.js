import { randomUUID } from 'node:crypto';
import { CONSENT_SCOPES, POLICY } from '../config.js';
import { audit, emit } from '../audit.js';
import { authorize, consentState } from '../policy.js';
import { badRequest, forbidden } from '../errors.js';
import { nextSeq } from './common.js';

export function getConsent(ctx, studentId) {
  const { consent } = authorize(ctx, studentId, 'consent.read');
  return consent;
}

/** Sessions follow consent: suspended while processing consent is inactive, resumed when it returns. */
export function reconcileSessions(ctx, studentId) {
  const { db } = ctx;
  const active = consentState(db, studentId, ctx.now).scopes.assessment_processing.active;
  for (const s of Object.values(db.sessions)) {
    if (s.student_id !== studentId) continue;
    if (s.status === 'in_progress' && !active) s.status = 'suspended_consent';
    else if (s.status === 'suspended_consent' && active) s.status = 'in_progress';
  }
}

export function setConsent(ctx, studentId, body) {
  const { db, actor } = ctx;
  authorize(ctx, studentId, 'consent.write');
  const scope = body?.scope;
  if (!CONSENT_SCOPES[scope]) throw badRequest('unknown_scope', `Unknown consent scope: ${scope}`);
  if (typeof body.granted !== 'boolean') throw badRequest('invalid_body', '`granted` must be true or false.');
  // Guardians authorise processing for a minor; every other scope belongs to the student.
  if (actor.role === 'guardian' && scope !== 'assessment_processing') {
    throw forbidden('guardian_scope_not_permitted', 'A guardian can authorise or withdraw only assessment processing.', { action: 'security.access_denied', tenant_id: actor.tenant_id, subject_ref: `student:${studentId}`, meta: { reason: 'guardian_scope_not_permitted', scope } });
  }
  const before = consentState(db, studentId, ctx.now);
  const current = before.scopes[scope].parties[actor.role];
  const nextState = body.granted ? 'granted' : 'withdrawn';
  if (current.state === nextState) return { changed: false, consent: before }; // idempotent

  const record = {
    id: randomUUID(),
    seq: nextSeq(db.consent_records),
    subject_id: studentId,
    tenant_id: db.users[studentId].tenant_id,
    actor_id: actor.id,
    actor_role: actor.role,
    scope,
    state: nextState,
    legal_basis_ref: POLICY.legal_basis_ref,
    policy_version: POLICY.policy_version,
    method: 'in_app_explicit_choice',
    evidence_ref: null,
    created_at: ctx.now.toISOString(),
  };
  db.consent_records[record.id] = record;

  if (!body.granted) {
    // Stop disallowed processing and sharing now; retention outcome is queued for a human/policy decision.
    for (const sh of Object.values(db.shares)) {
      if (sh.student_id === studentId && !sh.revoked_at && (scope === 'assessment_processing' || scope === 'guardian_summary_sharing')) {
        sh.revoked_at = ctx.now.toISOString();
        sh.revoked_reason = `consent_withdrawn:${scope}`;
      }
    }
    const taskId = randomUUID();
    db.retention_tasks[taskId] = { id: taskId, student_id: studentId, tenant_id: record.tenant_id, scope, state: 'queued_for_policy_decision', policy: 'PENDING-RETENTION-SCHEDULE', created_at: record.created_at };
  }
  reconcileSessions(ctx, studentId);
  const after = consentState(db, studentId, ctx.now);
  audit(ctx, { action: body.granted ? 'consent.granted' : 'consent.withdrawn', tenant_id: record.tenant_id, subject_ref: `student:${studentId}`, before: before.scopes[scope], after: after.scopes[scope], meta: { scope, party: actor.role } });
  emit(ctx, body.granted ? 'discovery.consent.granted' : 'discovery.consent.withdrawn', record.id, { student_id: studentId, scope, party: actor.role }, record.tenant_id);
  return { changed: true, consent: after };
}
