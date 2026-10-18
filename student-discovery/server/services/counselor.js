import { randomUUID } from 'node:crypto';
import { audit } from '../audit.js';
import { activeAssignment, authorize, consentState, requireRole } from '../policy.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { VERIFIED_STATES } from '../../domain/admission/gate.js';
import { discoveryProfile } from './student.js';
import { listEvidence } from './student.js';
import { latestScoreRuns, nextSeq, studentEvidenceMap, publicStudent, byId, auditCounselorRead } from './common.js';
import { getProgram } from '../../domain/catalog/programs.js';

const STUDENT_REASONS = ['help_request', 'appeal', 'interpretation_dispute'];
const COUNSELOR_REASONS = ['safeguarding_referral', 'parent_inquiry', 'report_review', 'interpretation_dispute', 'help_request', 'appeal', 'unverified_evidence', 'follow_up'];

const clean = (s, max) => String(s ?? '').trim().slice(0, max);

const PURPOSES = ['case_review', 'parent_inquiry', 'appeal_review', 'follow_up', 'safeguarding'];

/**
 * A case may point at one thing the student is entitled to ask about. Free text here would let a student
 * attach their case to someone else's report (and later read its outcome), so it must name an object they own.
 */
function validSubjectRef(db, studentId, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  const m = /^(program|session|score_run|recommendation_run|report):([A-Za-z0-9._-]{1,80})$/.exec(String(ref));
  if (!m) throw unprocessable('invalid_subject_ref', 'subject_ref must name a program, session, score, recommendation or report.');
  const [, kind, id] = m;
  const coll = { session: db.sessions, score_run: db.score_runs, recommendation_run: db.recommendation_runs, report: db.reports }[kind];
  const ok = kind === 'program' ? Boolean(getProgram(id)) : Boolean(coll && Object.hasOwn(coll, id) && coll[id].student_id === studentId);
  if (!ok) throw unprocessable('invalid_subject_ref', 'subject_ref does not refer to one of your own records.');
  return `${kind}:${id}`;
}

export function openCase(ctx, studentId, body) {
  const { db, actor } = ctx;
  const { student } = authorize(ctx, studentId, 'case.open');
  const allowed = actor.role === 'student' ? STUDENT_REASONS : COUNSELOR_REASONS;
  const reason = body?.reason_code;
  if (!allowed.includes(reason)) throw badRequest('invalid_reason', `reason_code must be one of: ${allowed.join(', ')}`);
  const message = clean(body?.message, 2000);
  if (actor.role === 'student' && reason !== 'help_request' && message.length < 3) throw unprocessable('message_required', 'Tell your counselor briefly what you would like reviewed.');
  const assignee = activeAssignment(db, studentId)?.counselor_id ?? null;
  const c = {
    id: randomUUID(),
    seq: nextSeq(db.cases),
    tenant_id: student.tenant_id,
    student_id: studentId,
    reason_code: reason,
    status: 'open',
    opened_by: { id: actor.id, role: actor.role },
    assignee_id: assignee,
    student_message: actor.role === 'student' ? message : null,
    subject_ref: validSubjectRef(db, studentId, body?.subject_ref), // e.g. recommendation_run:<id> or program:<id> being challenged
    created_at: ctx.now.toISOString(),
    updated_at: ctx.now.toISOString(),
    resolved_at: null,
    resolution: null,
    next_review_at: null,
  };
  db.cases[c.id] = c;
  audit(ctx, { action: 'case.opened', tenant_id: c.tenant_id, subject_ref: `case:${c.id}`, after: { reason_code: reason, status: 'open' } });
  return c;
}

export function listStudentCases(ctx, studentId) {
  const { student } = authorize(ctx, studentId, 'case.open');
  auditCounselorRead(ctx, student, 'access.cases_read');
  const isCounselor = ctx.actor.role === 'counselor';
  return Object.values(ctx.db.cases)
    .filter((c) => c.student_id === studentId)
    .sort((a, b) => b.seq - a.seq)
    .map((c) => ({ ...c, assignee_id: isCounselor ? c.assignee_id : undefined }));
}

export function updateCase(ctx, caseId, body) {
  const { db } = ctx;
  const c = byId(ctx, db.cases, caseId, 'case');
  authorize(ctx, c.student_id, 'case.review');
  const status = body?.status;
  if (!['open', 'in_review', 'resolved'].includes(status)) throw badRequest('invalid_status', 'status must be open, in_review or resolved.');
  if (status === 'resolved' && clean(body.resolution, 2000).length < 5) throw unprocessable('resolution_required', 'Add a short resolution (at least 5 characters).');
  const before = { status: c.status };
  c.status = status;
  c.updated_at = ctx.now.toISOString();
  c.resolution = status === 'resolved' ? clean(body.resolution, 2000) : null;
  c.resolved_at = status === 'resolved' ? c.updated_at : null;
  if (body.next_review_at) {
    const when = new Date(body.next_review_at);
    if (Number.isNaN(+when)) throw badRequest('invalid_date', 'next_review_at must be a valid date.');
    c.next_review_at = when.toISOString();
  }
  audit(ctx, { action: 'case.updated', tenant_id: c.tenant_id, subject_ref: `case:${c.id}`, before, after: { status } });
  return c;
}

export function addNote(ctx, studentId, body) {
  const { db } = ctx;
  authorize(ctx, studentId, 'case.review');
  const text = clean(body?.body, 4000);
  if (text.length < 2) throw unprocessable('note_required', 'Write a note.');
  const visibility = body?.visibility === 'student' ? 'student' : 'counselor_only';
  if (body?.case_id && db.cases[body.case_id]?.student_id !== studentId) throw notFound('case');
  const n = { id: randomUUID(), seq: nextSeq(db.case_notes), tenant_id: db.users[studentId].tenant_id, student_id: studentId, case_id: body?.case_id ?? null, author_id: ctx.actor.id, body: text, visibility, created_at: ctx.now.toISOString() };
  db.case_notes[n.id] = n;
  audit(ctx, { action: 'note.added', tenant_id: n.tenant_id, subject_ref: `student:${studentId}`, meta: { visibility } });
  return { ...n };
}

/**
 * Signed interpretation override: an annotation layered over a sealed score_run (AC-11).
 * It never edits answers, keys or scores; the original result stays visible and replayable.
 */
export function createOverride(ctx, studentId, body) {
  const { db } = ctx;
  authorize(ctx, studentId, 'override.create');
  const run = db.score_runs[body?.score_run_id];
  if (!run || run.student_id !== studentId) throw notFound('score_run');
  const text = clean(body?.text, 1000);
  const reason = clean(body?.reason, 1000);
  if (text.length < 5) throw unprocessable('text_required', 'Describe the interpretation change (at least 5 characters).');
  if (reason.length < 10) throw unprocessable('reason_required', 'A signed reason of at least 10 characters is required.');
  const o = {
    id: randomUUID(),
    seq: nextSeq(db.overrides),
    tenant_id: run.tenant_id,
    student_id: studentId,
    score_run_id: run.id,
    kind: 'interpretation_note',
    text,
    reason,
    visibility: body?.visibility === 'student' ? 'student' : 'counselor_only',
    counselor_id: ctx.actor.id,
    score_run_execution_hash: run.execution_hash, // proves the sealed result was untouched when signed
    created_at: ctx.now.toISOString(),
  };
  db.overrides[o.id] = o;
  audit(ctx, { action: 'override.signed', tenant_id: o.tenant_id, subject_ref: `score_run:${run.id}`, after: { override_id: o.id, visibility: o.visibility }, meta: { reason_length: reason.length } });
  return o;
}

// ---------------------------------------------------------------- queue & Case 360

export function counselorQueue(ctx) {
  const { db, actor } = ctx;
  requireRole(ctx, 'counselor');
  const assigned = db.counselor_assignments.filter((a) => a.counselor_id === actor.id && !a.ended_at).map((a) => db.users[a.student_id]).filter((u) => u && u.tenant_id === actor.tenant_id);
  const rows = assigned.map((st) => {
    const consent = consentState(db, st.id, ctx.now);
    const openCases = Object.values(db.cases).filter((c) => c.student_id === st.id && c.status !== 'resolved');
    const reasons = new Set(openCases.map((c) => c.reason_code));
    const access = consent.scopes.assessment_processing.active && consent.scopes.counselor_sharing.active ? 'full' : 'no_consent';
    if (access === 'no_consent') {
      // Do not look at the student's data without consent; only the roster fact is shown.
      reasons.add('missing_consent');
    } else {
      if (Object.values(db.reports).some((r) => r.student_id === st.id && r.status === 'review_requested')) reasons.add('unreviewed');
      const runs = latestScoreRuns(db, st.id);
      const rk = runs.interest_exploratory?.ranking;
      if (rk && (!rk.complete || rk.top.length > 3)) reasons.add('ambiguous_profile');
      const ev = studentEvidenceMap(db, st.id);
      if (Object.values(ev).some((e) => !VERIFIED_STATES.includes(e.verification_state))) reasons.add('unverified_evidence');
      const lastRun = Object.values(db.recommendation_runs).filter((r) => r.student_id === st.id).sort((a, b) => b.seq - a.seq)[0];
      if (lastRun) {
        const pinned = new Set(Object.values(db.aspirations).filter((a) => a.student_id === st.id).map((a) => a.program_id));
        const staleHit = lastRun.output.items.some((i) => pinned.has(i.program_id) && ['source_stale', 'not_evaluated'].includes(i.admission_status.eligibility));
        if (staleHit) reasons.add('stale_catalog');
      }
    }
    return { student: publicStudent(st), access, reasons: [...reasons].sort(), open_cases: openCases.length };
  });
  rows.sort((a, b) => b.reasons.length - a.reasons.length || a.student.id.localeCompare(b.student.id));
  return { items: rows };
}

export function caseView(ctx, studentId, query) {
  const { db } = ctx;
  authorize(ctx, studentId, 'case.review');
  const purpose = query?.purpose ?? 'case_review';
  if (!PURPOSES.includes(purpose)) throw badRequest('invalid_purpose', `purpose must be one of: ${PURPOSES.join(', ')}`);
  const profile = discoveryProfile(ctx, studentId); // counselor-filtered + audited as profile read
  const lastReco = Object.values(db.recommendation_runs).filter((r) => r.student_id === studentId).sort((a, b) => b.seq - a.seq)[0] ?? null;
  const out = {
    profile,
    evidence: listEvidence(ctx, studentId),
    cases: Object.values(db.cases).filter((c) => c.student_id === studentId).sort((a, b) => b.seq - a.seq),
    notes: Object.values(db.case_notes).filter((n) => n.student_id === studentId).sort((a, b) => b.seq - a.seq),
    overrides: Object.values(db.overrides).filter((o) => o.student_id === studentId).sort((a, b) => b.seq - a.seq),
    reports: Object.values(db.reports).filter((r) => r.student_id === studentId).sort((a, b) => b.seq - a.seq).map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, payload_hash: r.payload_hash })),
    latest_recommendation: lastReco ? { id: lastReco.id, created_at: lastReco.created_at, catalog_snapshot_id: lastReco.catalog_snapshot_id, summary: lastReco.output.summary, recomputed: lastReco.recomputed, changes_since_previous: lastReco.changes_since_previous } : null,
    sessions: Object.values(db.sessions).filter((s) => s.student_id === studentId).sort((a, b) => a.seq - b.seq).map((s) => ({ id: s.id, instrument_id: s.instrument_id, status: s.status, attempt_no: s.attempt_no, submitted_at: s.submitted_at })),
  };
  audit(ctx, { action: 'access.case360', tenant_id: db.users[studentId].tenant_id, subject_ref: `student:${studentId}`, meta: { purpose } });
  return out;
}

