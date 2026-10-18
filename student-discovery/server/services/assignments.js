// Counselor assignment lifecycle (conflict of interest and reassignment).
// An assignment row is never deleted: ending one sets ended_at/end_reason, so history survives a handover.
// Only the school admin chooses a new counselor, and never one who declared a conflict for that student.
import { randomUUID } from 'node:crypto';
import { audit, emit } from '../audit.js';
import { activeAssignment, denyUnavailable, isAssigned, requireRole } from '../policy.js';
import { conflict, unprocessable } from '../errors.js';
import { own } from '../../domain/util.js';
import { publicStudent } from './common.js';

const MIN_REASON = 10;
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

const conflictsFor = (db, studentId) => Object.values(db.conflicts).filter((c) => c.student_id === studentId);
const counselorHasConflict = (db, counselorId, studentId) => conflictsFor(db, studentId).some((c) => c.counselor_id === counselorId);

/** Open cases follow the assignment: they are unowned after a conflict and owned by the new counselor after a reassignment. */
function moveOpenCases(db, studentId, assigneeId, now) {
  for (const c of Object.values(db.cases)) {
    if (c.student_id !== studentId || c.status === 'resolved') continue;
    c.assignee_id = assigneeId;
    c.updated_at = now.toISOString();
  }
}

/**
 * The assigned counselor steps away from a student. Needs no consent from the student: stepping away
 * removes access, it never adds any. The stated reason is kept with the conflict record and is not
 * copied into the audit log or any list.
 */
export function declareConflict(ctx, studentId, body) {
  const { db, actor } = ctx;
  ctx.intent = 'assignment.declare';
  requireRole(ctx, 'counselor');
  const student = own(db.users, studentId);
  // Unknown student, another school's student and "not mine" are indistinguishable to the caller.
  if (!student || student.role !== 'student') denyUnavailable(ctx, 'not_found');
  if (student.tenant_id !== actor.tenant_id) denyUnavailable(ctx, 'cross_tenant', student);
  const current = activeAssignment(db, studentId);
  if (!current || current.counselor_id !== actor.id) denyUnavailable(ctx, 'not_assigned_counselor', student);
  const reason = clean(body?.reason, 1000);
  if (reason.length < MIN_REASON) throw unprocessable('reason_required', `State the conflict in at least ${MIN_REASON} characters.`);

  const at = ctx.now.toISOString();
  current.ended_at = at;
  current.end_reason = 'conflict_of_interest';
  const record = { id: randomUUID(), tenant_id: student.tenant_id, student_id: studentId, counselor_id: actor.id, reason, declared_at: at };
  db.conflicts[record.id] = record;
  moveOpenCases(db, studentId, null, ctx.now);
  audit(ctx, { action: 'assignment.conflict_declared', tenant_id: student.tenant_id, subject_ref: `student:${studentId}`, before: { counselor_id: actor.id }, after: { counselor_id: null }, meta: { reason_length: reason.length } });
  emit(ctx, 'discovery.assignment.conflict_declared', record.id, { student_id: studentId }, student.tenant_id);
  return { student_id: studentId, status: 'unassigned', ended_at: at };
}

const person = (u) => (u ? { id: u.id, display_name: u.display_name } : null);

/** The school admin's worklist: who has no counselor, who carries how many students. No student content. */
export function listAssignments(ctx) {
  const { db, actor } = ctx;
  requireRole(ctx, 'tenant_admin');
  const students = Object.values(db.users).filter((u) => u.role === 'student' && u.tenant_id === actor.tenant_id);
  const counselors = Object.values(db.users).filter((u) => u.role === 'counselor' && u.tenant_id === actor.tenant_id);
  const rows = students.map((st) => {
    const current = activeAssignment(db, st.id);
    const latest = conflictsFor(db, st.id).sort((a, b) => b.declared_at.localeCompare(a.declared_at))[0] ?? null;
    return {
      student: publicStudent(st),
      status: current ? 'assigned' : 'unassigned',
      counselor: current ? person(db.users[current.counselor_id]) : null,
      assigned_at: current?.assigned_at ?? null,
      // Who stepped away and when; never why.
      conflict: latest && !current ? { declared_by: person(db.users[latest.counselor_id]), declared_at: latest.declared_at } : null,
      excluded_counselors: conflictsFor(db, st.id).map((c) => c.counselor_id),
    };
  });
  rows.sort((a, b) => (a.status === b.status ? a.student.id.localeCompare(b.student.id) : a.status === 'unassigned' ? -1 : 1));
  return {
    students: rows,
    counselors: counselors.map((c) => ({ id: c.id, display_name: c.display_name, students: students.filter((st) => isAssigned(db, c.id, st.id)).length })),
  };
}

/** Give a student to a counselor of the same school. Repeating the current assignment changes nothing. */
export function reassign(ctx, body) {
  const { db, actor } = ctx;
  ctx.intent = 'assignment.reassign';
  requireRole(ctx, 'tenant_admin');
  const student = own(db.users, body?.student_id);
  if (!student || student.role !== 'student') denyUnavailable(ctx, 'not_found');
  if (student.tenant_id !== actor.tenant_id) denyUnavailable(ctx, 'cross_tenant', student);
  const counselor = own(db.users, body?.counselor_id);
  if (!counselor || counselor.role !== 'counselor') throw unprocessable('not_a_counselor', 'Choose a counselor.');
  if (counselor.tenant_id !== student.tenant_id) throw unprocessable('counselor_other_school', 'The counselor must work at the student\'s school.');
  const reason = clean(body?.reason, 500);
  if (reason.length < 3) throw unprocessable('reason_required', 'Say why the assignment is changing.');
  if (counselorHasConflict(db, counselor.id, student.id)) throw conflict('conflict_of_interest', 'This counselor declared a conflict of interest for this student.');

  const current = activeAssignment(db, student.id);
  if (current?.counselor_id === counselor.id) return { student_id: student.id, counselor_id: counselor.id, status: 'assigned', changed: false };

  const at = ctx.now.toISOString();
  if (current) {
    current.ended_at = at;
    current.end_reason = 'reassigned';
  }
  db.counselor_assignments.push({ counselor_id: counselor.id, student_id: student.id, assigned_at: at, assigned_by: actor.id });
  moveOpenCases(db, student.id, counselor.id, ctx.now);
  audit(ctx, { action: 'assignment.reassigned', tenant_id: student.tenant_id, subject_ref: `student:${student.id}`, before: { counselor_id: current?.counselor_id ?? null }, after: { counselor_id: counselor.id }, meta: { reason } });
  emit(ctx, 'discovery.assignment.changed', student.id, { student_id: student.id }, student.tenant_id);
  return { student_id: student.id, counselor_id: counselor.id, status: 'assigned', changed: true };
}
