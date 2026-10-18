// A guardian can be linked to several students; every call is still authorized per student.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A1 = 'user-student-a1';
const A2 = 'user-student-a2';

test('the guardian persona with two children lists both, and a single-child guardian lists one', async () => {
  const g = await app.as('user-guardian-a12');
  const me = (await g.get('/api/v1/identity-stub/me')).body;
  assert.deepEqual(me.linked_students.map((s) => s.id).sort(), [A1, A2]);
  const single = (await (await app.as('user-guardian-a2')).get('/api/v1/identity-stub/me')).body;
  assert.deepEqual(single.linked_students.map((s) => s.id), [A2]);
});

test('each child is authorized separately: consent for one child does not touch the other', async () => {
  const g = await app.as('user-guardian-a12');
  const s1 = await app.as(A1);
  await s1.post(`${BASE}/students/${A1}/consent`, { scope: 'assessment_processing', granted: true });
  const before2 = (await g.get(`${BASE}/students/${A2}/consent`)).body.scopes.assessment_processing.parties.guardian.state;
  const r = await g.post(`${BASE}/students/${A1}/consent`, { scope: 'assessment_processing', granted: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.consent.scopes.assessment_processing.active, true);
  assert.equal((await g.get(`${BASE}/students/${A2}/consent`)).body.scopes.assessment_processing.parties.guardian.state, before2, 'the other child is unchanged');
  const records = Object.values(app.store.db.consent_records).filter((c) => c.actor_id === 'user-guardian-a12');
  assert.ok(records.every((c) => c.subject_id === A1));
});

test('the summary follows each child\'s own sharing choice', async () => {
  const g = await app.as('user-guardian-a12');
  assert.equal((await g.get(`${BASE}/students/${A2}/guardian-summary`)).status, 200, 'A2 shares a summary');
  const a1 = await g.get(`${BASE}/students/${A1}/guardian-summary`);
  assert.equal(a1.status, 403, 'A1 has not shared');
  assert.equal(a1.body.reason, 'consent_scope_inactive');
});

test('a linked guardian still has no reach beyond their own children, raw answers included', async () => {
  const g = await app.as('user-guardian-a12');
  const b1 = await g.get(`${BASE}/students/user-student-b1/guardian-summary`);
  assert.equal(b1.status, 403);
  assert.equal(b1.body.reason, 'not_available');
  const sid = Object.values(app.store.db.sessions).find((s) => s.student_id === A2).id;
  assert.equal((await g.get(`${BASE}/sessions/${sid}/responses`)).status, 403);
  assert.equal((await g.get(`${BASE}/students/${A2}/discovery-profile`)).status, 403);
});

test('revoking the link to one child leaves the other intact', async () => {
  const g = await app.as('user-guardian-a12');
  const link = app.store.db.guardian_links.find((l) => l.guardian_id === 'user-guardian-a12' && l.student_id === A1);
  link.revoked_at = new Date(+app.time.now - 1000).toISOString();
  assert.equal((await g.get(`${BASE}/students/${A1}/consent`)).status, 403);
  assert.equal((await g.get(`${BASE}/students/${A2}/guardian-summary`)).status, 200);
  const me = (await g.get('/api/v1/identity-stub/me')).body;
  assert.deepEqual(me.linked_students.map((s) => s.id), [A2], 'a revoked link is no longer offered as a child');
  delete link.revoked_at;
});
