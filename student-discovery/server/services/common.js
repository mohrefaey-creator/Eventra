import { PROGRAMS } from '../../domain/catalog/programs.js';
import { audit } from '../audit.js';
import { denyUnavailable } from '../policy.js';
import { buildProfile, latestEvidence } from '../../domain/matching/recommend.js';
import { getInstrumentByVersionId, getInstrument } from '../../domain/instruments/registry.js';

export const CURRENT_CYCLE = '2027';

export const publicStudent = (u) => ({ id: u.id, display_name: u.display_name, grade: u.grade, tenant_id: u.tenant_id });

/** The most recent SEALED, final score_run per instrument for a student. */
export function latestScoreRuns(db, studentId) {
  const out = {};
  for (const r of Object.values(db.score_runs)) {
    if (r.student_id !== studentId || r.status !== 'final') continue;
    if (!out[r.instrument_id] || out[r.instrument_id].executed_at < r.executed_at || (out[r.instrument_id].executed_at === r.executed_at && out[r.instrument_id].seq < r.seq)) out[r.instrument_id] = r;
  }
  return out;
}

export const studentEvidenceRecords = (db, studentId) => Object.values(db.evidence).filter((e) => e.student_id === studentId);
export const studentEvidenceMap = (db, studentId) => latestEvidence(studentEvidenceRecords(db, studentId));
export const studentProfile = (db, studentId) => buildProfile(latestScoreRuns(db, studentId));

export const activePrograms = (db) => PROGRAMS.filter((p) => (db.programs[p.program_id]?.status ?? p.status) === 'active');

/** The snapshot that governs a program for a cycle: highest published version, else a conflicting one. */
export function activeRuleFor(db, programId, cycle = CURRENT_CYCLE) {
  const all = Object.values(db.rule_snapshots).filter((r) => r.program_id === programId && r.cycle === cycle);
  const published = all.filter((r) => r.state === 'published').sort((a, b) => b.version - a.version)[0];
  if (published) return published;
  return all.filter((r) => r.state === 'conflicting').sort((a, b) => b.version - a.version)[0] ?? null;
}

export const instrumentOf = (session) => getInstrumentByVersionId(session.instrument_version_id) ?? getInstrument(session.instrument_id);

export function sessionResponses(db, sessionId) {
  const out = {};
  for (const r of Object.values(db.responses)) if (r.session_id === sessionId) out[r.item_id] = r;
  return out;
}

export const nextSeq = (collection) => Object.keys(collection).length + 1;

/** Look up an object by a caller-supplied id. Unknown ids get the same denial as ids the caller may not see. */
export function byId(ctx, collection, id, label) {
  const row = Object.hasOwn(collection, id) ? collection[id] : undefined;
  if (!row) denyUnavailable(ctx, 'not_found', null, `${label}:${String(id).slice(0, 60)}`);
  return row;
}

/** A counselor's read of a student's data is always recorded, with its purpose. */
export function auditCounselorRead(ctx, student, action) {
  if (ctx.actor?.role !== 'counselor') return;
  audit(ctx, { action, tenant_id: student.tenant_id, subject_ref: `student:${student.id}`, meta: { purpose: 'counselor_review' } });
}
