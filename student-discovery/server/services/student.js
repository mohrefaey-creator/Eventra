import { randomUUID } from 'node:crypto';
import { audit, emit } from '../audit.js';
import { authorize, consentState } from '../policy.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { validateEvidenceValue, ValidationError, EVIDENCE_TYPES } from '../../domain/validation.js';
import { RIASEC_META } from '../../domain/instruments/interest.js';
import { getProgram } from '../../domain/catalog/programs.js';
import { VERIFIED_STATES } from '../../domain/admission/gate.js';
import { moduleCards } from './assessments.js';
import { latestScoreRuns, publicStudent, studentEvidenceRecords, studentEvidenceMap, nextSeq } from './common.js';

// ---------------------------------------------------------------- evidence

export function listEvidence(ctx, studentId) {
  authorize(ctx, studentId, 'evidence.read');
  const records = studentEvidenceRecords(ctx.db, studentId).sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1));
  const latest = studentEvidenceMap(ctx.db, studentId);
  return { types: Object.keys(EVIDENCE_TYPES), verified_states: VERIFIED_STATES, latest, history: records };
}

export function putEvidence(ctx, studentId, type, body) {
  const { db } = ctx;
  authorize(ctx, studentId, 'evidence.write');
  let value;
  try {
    value = validateEvidenceValue(type, body?.value);
  } catch (e) {
    if (e instanceof ValidationError) throw unprocessable(e.code, e.message);
    throw e;
  }
  const prev = Object.values(db.evidence).filter((e) => e.student_id === studentId && e.type === type).sort((a, b) => b.seq - a.seq)[0];
  if (prev && prev.value === value) return { changed: false, evidence: prev };
  const rec = {
    id: randomUUID(),
    seq: nextSeq(db.evidence),
    student_id: studentId,
    tenant_id: db.users[studentId].tenant_id,
    type,
    value,
    // A student's own entry is never proof. It stays `unverified` until an authorised human verifies it.
    provenance: { source: 'student_manual_entry', entered_by: ctx.actor.id },
    verification_state: 'unverified',
    verified_by: null,
    verified_at: null,
    captured_at: ctx.now.toISOString(),
    expires_at: null,
    supersedes_id: prev?.id ?? null,
  };
  db.evidence[rec.id] = rec;
  audit(ctx, { action: 'evidence.recorded', tenant_id: rec.tenant_id, subject_ref: `student:${studentId}`, before: prev ? { type, value: prev.value, state: prev.verification_state } : null, after: { type, value, state: 'unverified' }, meta: { type } });
  emit(ctx, 'discovery.profile.updated', rec.id, { student_id: studentId, evidence_type: type }, rec.tenant_id);
  return { changed: true, evidence: rec };
}

export function verifyEvidence(ctx, studentId, evidenceId, body) {
  const { db } = ctx;
  authorize(ctx, studentId, 'evidence.verify');
  const rec = db.evidence[evidenceId];
  if (!rec || rec.student_id !== studentId) throw notFound('evidence');
  const latest = studentEvidenceMap(db, studentId)[rec.type];
  if (!latest || latest.id !== rec.id) throw conflict('evidence_superseded', 'A newer value was entered; verify the latest one.');
  if (rec.verification_state === 'counselor_verified') return { changed: false, evidence: rec };
  const note = String(body?.note ?? '').trim();
  if (note.length < 5) throw unprocessable('note_required', 'Say what was checked (e.g., the document seen), at least 5 characters.');
  const before = { state: rec.verification_state };
  rec.verification_state = 'counselor_verified';
  rec.verified_by = ctx.actor.id;
  rec.verified_at = ctx.now.toISOString();
  rec.verification_note = note.slice(0, 500);
  audit(ctx, { action: 'evidence.verified', tenant_id: rec.tenant_id, subject_ref: `student:${studentId}`, before, after: { state: rec.verification_state, type: rec.type }, meta: { type: rec.type } });
  emit(ctx, 'discovery.profile.updated', rec.id, { student_id: studentId, evidence_type: rec.type }, rec.tenant_id);
  return { changed: true, evidence: rec };
}

// ---------------------------------------------------------------- preferences & aspirations

const TEXT_SIZES = ['normal', 'large', 'xlarge'];
export function putPreferences(ctx, studentId, body) {
  const { db } = ctx;
  authorize(ctx, studentId, 'preferences.write');
  const out = {};
  const acc = body?.accessibility;
  if (acc !== undefined) {
    if (typeof acc !== 'object' || acc === null) throw badRequest('invalid_body', '`accessibility` must be an object.');
    const val = {
      text_size: TEXT_SIZES.includes(acc.text_size) ? acc.text_size : 'normal',
      high_contrast: acc.high_contrast === true,
      reduce_motion: acc.reduce_motion === true,
    };
    db.preferences[`${studentId}:accessibility`] = { student_id: studentId, category: 'accessibility', value: val, effective_at: ctx.now.toISOString(), source_actor: ctx.actor.id, visibility_scope: 'student_only' };
    out.accessibility = val;
  }
  if (body?.locale !== undefined) {
    if (!['ar-SA', 'en'].includes(body.locale)) throw badRequest('invalid_body', 'Unsupported locale.');
    db.preferences[`${studentId}:locale`] = { student_id: studentId, category: 'locale', value: body.locale, effective_at: ctx.now.toISOString(), source_actor: ctx.actor.id, visibility_scope: 'student_only' };
    out.locale = body.locale;
  }
  return out;
}

export function getPreferences(db, studentId) {
  return { accessibility: db.preferences[`${studentId}:accessibility`]?.value ?? { text_size: 'normal', high_contrast: false, reduce_motion: false }, locale: db.preferences[`${studentId}:locale`]?.value ?? null };
}

export function putAspiration(ctx, studentId, programId, body) {
  const { db } = ctx;
  authorize(ctx, studentId, 'aspiration.write');
  if (!getProgram(programId)) throw notFound('program');
  const key = `${studentId}:${programId}`;
  const mine = Object.values(db.aspirations).filter((a) => a.student_id === studentId);
  if (!db.aspirations[key] && mine.length >= 5) throw conflict('aspiration_limit', 'You can pin up to 5 majors.');
  db.aspirations[key] = { student_id: studentId, program_id: programId, note: String(body?.note ?? '').slice(0, 500), pinned_at: db.aspirations[key]?.pinned_at ?? ctx.now.toISOString() };
  audit(ctx, { action: 'aspiration.pinned', tenant_id: db.users[studentId].tenant_id, subject_ref: `student:${studentId}`, after: { program_id: programId } });
  return db.aspirations[key];
}

export function deleteAspiration(ctx, studentId, programId) {
  const { db } = ctx;
  authorize(ctx, studentId, 'aspiration.write');
  const key = `${studentId}:${programId}`;
  const existed = Boolean(db.aspirations[key]);
  delete db.aspirations[key];
  if (existed) audit(ctx, { action: 'aspiration.unpinned', tenant_id: db.users[studentId].tenant_id, subject_ref: `student:${studentId}`, after: { program_id: programId } });
  return { removed: existed };
}

export const listAspirations = (db, studentId) => Object.values(db.aspirations).filter((a) => a.student_id === studentId);

// ---------------------------------------------------------------- aggregated profile

const SCORE_PANEL = {
  interest_exploratory: 'expressed_interests',
  subject_preference_exploratory: 'subject_preferences',
  work_values_exploratory: 'work_values',
  skills_confidence_selfreport: 'self_reported_confidence',
};

function panelFor(run) {
  if (!run) return { status: 'incomplete_evidence', score_run_id: null };
  return {
    status: 'sealed',
    score_run_id: run.id,
    executed_at: run.executed_at,
    algorithm_version: run.algorithm_version,
    construct_scores: run.construct_scores,
    ranking: run.ranking ?? null,
    norm_reference: null,
  };
}

/** Aggregated evidence/results (spec: GET /students/{id}/discovery-profile) with role-based field filtering. */
export function discoveryProfile(ctx, studentId) {
  const { db, actor } = ctx;
  const { student, consent } = authorize(ctx, studentId, 'profile.read');
  const runs = latestScoreRuns(db, studentId);
  const evidence = studentEvidenceMap(db, studentId);
  const runsAll = Object.values(db.recommendation_runs).filter((r) => r.student_id === studentId).sort((a, b) => b.seq - a.seq);
  const lastReco = runsAll[0] ?? null;

  const panels = {
    expressed_interests: panelFor(runs.interest_exploratory),
    subject_preferences: panelFor(runs.subject_preference_exploratory),
    work_values: panelFor(runs.work_values_exploratory),
    self_reported_confidence: panelFor(runs.skills_confidence_selfreport),
    // Demonstrated capabilities are NOT inferred from interest or self-report (spec §5.1).
    demonstrated_capabilities: { status: 'not_available', reason: 'aptitude_on_hold' },
    admission_readiness: lastReco
      ? { status: 'computed', recommendation_run_id: lastReco.id, generated_at: lastReco.created_at, by_eligibility: lastReco.output.summary.by_eligibility, catalog_snapshot_id: lastReco.catalog_snapshot_id }
      : { status: 'not_evaluated' },
  };

  const modulesDone = Object.keys(SCORE_PANEL).filter((id) => runs[id]).length;
  const evidenceTypes = ['pathway', 'secondary_percentage', 'gat', 'saat'];
  const completeness = {
    modules_sealed: modulesDone,
    modules_total: Object.keys(SCORE_PANEL).length,
    aptitude: 'on_hold',
    academic_evidence_present: evidenceTypes.filter((t) => evidence[t]).length,
    academic_evidence_total: evidenceTypes.length,
    academic_evidence_verified: evidenceTypes.filter((t) => evidence[t] && VERIFIED_STATES.includes(evidence[t].verification_state)).length,
  };

  const notes = Object.values(db.case_notes).filter((n) => n.student_id === studentId && (actor.role === 'counselor' || n.visibility === 'student'));
  const out = {
    student: publicStudent(student),
    consent,
    modules: moduleCards(ctx, studentId),
    panels,
    completeness,
    evidence: Object.entries(evidence).map(([type, e]) => ({ type, ...e })),
    aspirations: listAspirations(db, studentId),
    preferences: getPreferences(db, studentId),
    journey: db.journey[studentId] ?? [],
    notes: notes.map((n) => ({ id: n.id, case_id: n.case_id, body: n.body, visibility: n.visibility, author_id: actor.role === 'counselor' ? n.author_id : undefined, created_at: n.created_at })),
    attempts: attemptHistory(db, studentId),
  };
  if (actor.role === 'counselor') audit(ctx, { action: 'access.profile_read', tenant_id: student.tenant_id, subject_ref: `student:${studentId}`, meta: { purpose: 'counselor_review' } });
  return out;
}

/** Past sealed attempts per instrument, for the "current vs. historical" view (J-06). */
function attemptHistory(db, studentId) {
  const out = {};
  for (const r of Object.values(db.score_runs).filter((x) => x.student_id === studentId && x.status === 'final').sort((a, b) => a.seq - b.seq)) {
    (out[r.instrument_id] ??= []).push({ score_run_id: r.id, session_id: r.session_id, executed_at: r.executed_at, construct_scores: r.instrument_id === 'interest_exploratory' ? r.construct_scores : undefined });
  }
  return out;
}

/** Guardian: an explicit allow-list. No raw answers, no item-level data, no counselor notes, no evidence values. */
export function guardianSummary(ctx, studentId) {
  const { db } = ctx;
  const { student } = authorize(ctx, studentId, 'guardian.summary');
  const runs = latestScoreRuns(db, studentId);
  const interest = runs.interest_exploratory;
  const cards = moduleCards(ctx, studentId);
  const reports = Object.values(db.reports).filter((r) => r.student_id === studentId && r.status === 'approved');
  const activeShares = Object.values(db.shares).filter((s) => s.student_id === studentId && s.recipient_role === 'guardian' && !s.revoked_at && new Date(s.expires_at) > ctx.now);
  audit(ctx, { action: 'access.guardian_summary', tenant_id: student.tenant_id, subject_ref: `student:${studentId}`, meta: { purpose: 'guardian_summary' } });
  return {
    student: { id: student.id, display_name: student.display_name, grade: student.grade },
    modules: cards.map((c) => ({ instrument_id: c.instrument_id, name: c.name, status: c.status })),
    top_interests: interest?.ranking?.top?.map((d) => ({ dimension: d, name: RIASEC_META[d].name })) ?? null,
    top_interests_note: interest ? (interest.ranking.complete ? null : 'partial') : null,
    reports: reports.map((r) => ({ id: r.id, created_at: r.created_at, shared: activeShares.some((s) => s.report_id === r.id) })),
    consent: Object.fromEntries(Object.entries(consentState(db, studentId, ctx.now).scopes).map(([k, v]) => [k, v.status])),
  };
}
