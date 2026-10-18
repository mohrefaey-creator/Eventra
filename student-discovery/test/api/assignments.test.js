// Counselor assignment: conflict of interest cuts access immediately; only a school admin reassigns; history is kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A1 = 'user-student-a1';
const A2 = 'user-student-a2';
const REASON = 'The student is a relative of mine, so I should not advise them.';

const assignmentsOf = (studentId) => app.store.db.counselor_assignments.filter((a) => a.student_id === studentId);
const active = (studentId) => assignmentsOf(studentId).find((a) => !a.ended_at);

test('seed: a second school-A counselor exists with no students, and every assignment has a start date', () => {
  assert.ok(app.store.db.users['user-counselor-a2']);
  assert.equal(app.store.db.counselor_assignments.filter((a) => a.counselor_id === 'user-counselor-a2').length, 0);
  assert.ok(app.store.db.counselor_assignments.every((a) => a.assigned_at && !a.ended_at));
});

test('declaring a conflict needs a real reason, an assigned counselor, and nobody else can do it', async () => {
  const co = await app.as('user-counselor-a');
  assert.equal((await co.post(`${BASE}/students/${A2}/conflict-of-interest`, { reason: 'short' })).status, 422);
  assert.equal((await (await app.as('user-counselor-b')).post(`${BASE}/students/${A2}/conflict-of-interest`, { reason: REASON })).status, 403);
  assert.equal((await (await app.as(A2)).post(`${BASE}/students/${A2}/conflict-of-interest`, { reason: REASON })).status, 403);
  assert.equal((await (await app.as('user-tenant-admin-a')).post(`${BASE}/students/${A2}/conflict-of-interest`, { reason: REASON })).status, 403);
  const other = await (await app.as('user-counselor-a2')).post(`${BASE}/students/${A2}/conflict-of-interest`, { reason: REASON });
  assert.equal(other.status, 403, 'a counselor who is not assigned cannot declare for someone else\'s student');
  assert.equal(other.body.reason, 'not_available');
  assert.ok(active(A2), 'nothing changed');
});

test('a declared conflict removes the counselor\'s access at once, even for a student who never consented', async () => {
  const co = await app.as('user-counselor-a');
  // A1 has not consented: the counselor can still step away from the case
  const a1 = await co.post(`${BASE}/students/${A1}/conflict-of-interest`, { reason: REASON });
  assert.equal(a1.status, 200);
  assert.equal(active(A1), undefined);

  const s = await app.as(A2);
  const help = await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'help_request' });
  assert.equal(help.body.assignee_id, 'user-counselor-a', 'before: the open case belongs to the counselor');

  const r = await co.post(`${BASE}/students/${A2}/conflict-of-interest`, { reason: REASON });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'unassigned');
  assert.equal(active(A2), undefined);
  const ended = assignmentsOf(A2).at(-1);
  assert.equal(ended.end_reason, 'conflict_of_interest');
  assert.ok(ended.ended_at);

  for (const path of [`/students/${A2}/case360`, `/students/${A2}/discovery-profile`, `/students/${A2}/evidence`, `/students/${A2}/cases`]) {
    const x = await co.get(`${BASE}${path}`);
    assert.equal(x.status, 403, path);
    assert.equal(x.body.reason, 'not_available');
  }
  assert.ok(!(await co.get(`${BASE}/counselor/queue`)).body.items.some((i) => i.student.id === A2));
  assert.ok(Object.values(app.store.db.cases).filter((c) => c.student_id === A2 && c.status !== 'resolved').every((c) => c.assignee_id === null), 'open cases are unowned until reassigned');

  const audit = app.store.db.audit.find((e) => e.action === 'assignment.conflict_declared' && e.subject_ref === `student:${A2}`);
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes('relative'), false, 'the stated reason is not copied into the audit log');
  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'discovery.assignment.conflict_declared' && e.payload.student_id === A2));
});

test('the school admin sees who needs a counselor, without any student content, and only for their own school', async () => {
  const ta = await app.as('user-tenant-admin-a');
  const r = await ta.get(`${BASE}/admin/assignments`);
  assert.equal(r.status, 200);
  const row = r.body.students.find((x) => x.student.id === A2);
  assert.equal(row.status, 'unassigned');
  assert.equal(row.counselor, null);
  assert.equal(row.conflict.declared_by.id, 'user-counselor-a');
  assert.equal(JSON.stringify(row).includes('relative'), false, 'the reason stays with the declaring counselor and the audit trail');
  assert.equal(JSON.stringify(r.body).includes('construct_scores'), false);
  assert.ok(r.body.students.every((x) => ['user-student-a1', 'user-student-a2'].includes(x.student.id)), 'only school A');
  assert.deepEqual(r.body.counselors.map((c) => c.id).sort(), ['user-counselor-a', 'user-counselor-a2']);
  assert.equal(r.body.students[0].status, 'unassigned', 'those needing attention come first');
  assert.equal((await (await app.as('user-counselor-a')).get(`${BASE}/admin/assignments`)).status, 403);
  assert.equal((await (await app.as(A2)).get(`${BASE}/admin/assignments`)).status, 403);
});

test('only the school admin can reassign; the conflicted counselor cannot be chosen; other schools are off limits', async () => {
  const ta = await app.as('user-tenant-admin-a');
  const body = { student_id: A2, counselor_id: 'user-counselor-a2', reason: 'Covering after a conflict of interest' };
  assert.equal((await (await app.as('user-counselor-a')).post(`${BASE}/admin/assignments`, body)).status, 403);
  assert.equal((await (await app.as('user-tenant-admin-a')).post(`${BASE}/admin/assignments`, { ...body, reason: '' })).status, 422);

  const same = await ta.post(`${BASE}/admin/assignments`, { ...body, counselor_id: 'user-counselor-a' });
  assert.equal(same.status, 409);
  assert.equal(same.body.code, 'conflict_of_interest');
  const elsewhere = await ta.post(`${BASE}/admin/assignments`, { ...body, counselor_id: 'user-counselor-b' });
  assert.equal(elsewhere.status, 422);
  assert.equal(elsewhere.body.code, 'counselor_other_school');
  const notCounselor = await ta.post(`${BASE}/admin/assignments`, { ...body, counselor_id: 'user-steward-1' });
  assert.equal(notCounselor.status, 422);
  const tb = await app.as('user-tenant-admin-a');
  assert.equal((await tb.post(`${BASE}/admin/assignments`, { ...body, student_id: 'user-student-b1' })).status, 403, 'another school\'s student is not available');
  assert.equal((await tb.post(`${BASE}/admin/assignments`, { ...body, student_id: 'nobody' })).status, 403);
  assert.equal(active(A2), undefined, 'none of the refused attempts changed anything');
});

test('reassignment gives the new counselor access, moves open cases, keeps history, and leaves the old counselor out', async () => {
  const ta = await app.as('user-tenant-admin-a');
  const r = await ta.post(`${BASE}/admin/assignments`, { student_id: A2, counselor_id: 'user-counselor-a2', reason: 'Covering after a conflict of interest' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'assigned');
  assert.equal(active(A2).counselor_id, 'user-counselor-a2');
  assert.equal(assignmentsOf(A2).length, 2, 'the earlier assignment is kept as history');
  assert.equal(assignmentsOf(A2)[0].end_reason, 'conflict_of_interest');

  const co2 = await app.as('user-counselor-a2');
  assert.equal((await co2.get(`${BASE}/students/${A2}/case360?purpose=follow_up`)).status, 200);
  const view = (await co2.get(`${BASE}/students/${A2}/case360?purpose=follow_up`)).body;
  assert.ok(view.notes.length > 0, 'handover: earlier notes and cases stay with the student record');
  assert.ok(view.cases.filter((c) => c.status !== 'resolved').every((c) => c.assignee_id === 'user-counselor-a2'));
  assert.ok((await co2.get(`${BASE}/counselor/queue`)).body.items.some((i) => i.student.id === A2));

  const old = await (await app.as('user-counselor-a')).get(`${BASE}/students/${A2}/case360`);
  assert.equal(old.status, 403);

  const s = await app.as(A2);
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'help_request' })).body.assignee_id, 'user-counselor-a2', 'new cases go to the new counselor');
  assert.ok(app.store.db.audit.some((e) => e.action === 'assignment.reassigned' && e.subject_ref === `student:${A2}`));
  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'discovery.assignment.changed'));

  const again = await ta.post(`${BASE}/admin/assignments`, { student_id: A2, counselor_id: 'user-counselor-a2', reason: 'Same again' });
  assert.equal(again.body.changed, false, 'repeating the same assignment is a no-op');
  assert.equal(assignmentsOf(A2).length, 2);
});

test('the counselor who declared a conflict for A1 can never be chosen for A1, but can be for others', async () => {
  const ta = await app.as('user-tenant-admin-a');
  const refused = await ta.post(`${BASE}/admin/assignments`, { student_id: A1, counselor_id: 'user-counselor-a', reason: 'Trying to give them back' });
  assert.equal(refused.status, 409);
  const ok = await ta.post(`${BASE}/admin/assignments`, { student_id: A1, counselor_id: 'user-counselor-a2', reason: 'Covering after a conflict of interest' });
  assert.equal(ok.status, 200);
  const list = (await ta.get(`${BASE}/admin/assignments`)).body;
  assert.ok(list.students.every((x) => x.status === 'assigned'));
  assert.equal(list.counselors.find((c) => c.id === 'user-counselor-a2').students, 2);
});
