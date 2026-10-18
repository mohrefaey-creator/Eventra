// Spec §11.7: raw answers, scored attributes and counselor notes are distinct visibility classes.
// Raw answers therefore have their own consent scope, separate from sharing scored results.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A2 = 'user-student-a2';
const sessionOf = (studentId, instrument = 'interest_exploratory') => Object.values(app.store.db.sessions).find((s) => s.student_id === studentId && s.instrument_id === instrument).id;

test('raw answers need their own consent scope; scores and the profile do not', async () => {
  const co = await app.as('user-counselor-a');
  const s = await app.as(A2);
  const sid = sessionOf(A2);
  assert.equal((await co.get(`${BASE}/sessions/${sid}/responses`)).status, 200, 'baseline: all scopes granted');

  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'raw_answer_sharing', granted: false });
  const raw = await co.get(`${BASE}/sessions/${sid}/responses`);
  assert.equal(raw.status, 403);
  assert.equal(raw.body.reason, 'consent_scope_inactive');
  assert.equal(JSON.stringify(raw.body).includes('INT-R-001'), false);
  assert.equal((await co.get(`${BASE}/sessions/${sid}/score`)).status, 200, 'scored results stay visible under counselor_sharing');
  assert.equal((await co.get(`${BASE}/students/${A2}/discovery-profile`)).status, 200);
  assert.equal((await co.get(`${BASE}/students/${A2}/case360`)).status, 200);
  assert.equal((await s.get(`${BASE}/sessions/${sid}/responses`)).status, 200, 'the student always reads their own answers');

  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'raw_answer_sharing', granted: true });
  assert.equal((await co.get(`${BASE}/sessions/${sid}/responses`)).status, 200);
});

test('raw-answer sharing alone is not enough: counselor_sharing is still required', async () => {
  const co = await app.as('user-counselor-a');
  const s = await app.as(A2);
  const sid = sessionOf(A2);
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: false });
  assert.equal((await co.get(`${BASE}/sessions/${sid}/responses`)).status, 403);
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: true });
  assert.equal((await co.get(`${BASE}/sessions/${sid}/responses`)).status, 200);
});

test('the seeded adult student B1 never granted raw-answer sharing, so their counselor sees scores but not answers', async () => {
  const cb = await app.as('user-counselor-b');
  const sid = sessionOf('user-student-b1');
  assert.equal((await cb.get(`${BASE}/sessions/${sid}/score`)).status, 200);
  const raw = await cb.get(`${BASE}/sessions/${sid}/responses`);
  assert.equal(raw.status, 403);
  assert.equal(raw.body.reason, 'consent_scope_inactive');
  assert.equal((await cb.get(`${BASE}/counselor/queue`)).body.items[0].access, 'full');
});

test('a guardian can neither grant nor withdraw this scope, and still never reads raw answers', async () => {
  const g = await app.as('user-guardian-a2');
  const sid = sessionOf(A2);
  const r = await g.post(`${BASE}/students/${A2}/consent`, { scope: 'raw_answer_sharing', granted: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'guardian_scope_not_permitted');
  assert.equal((await g.get(`${BASE}/sessions/${sid}/responses`)).status, 403);
});

test('the consent state lists the new scope and withdrawing it is recorded and audited like any other', async () => {
  const s = await app.as(A2);
  const state = (await s.get(`${BASE}/students/${A2}/consent`)).body;
  assert.ok('raw_answer_sharing' in state.scopes);
  assert.deepEqual(state.scopes.raw_answer_sharing.required_parties, ['student']);
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'raw_answer_sharing', granted: false });
  assert.ok(app.store.db.audit.some((e) => e.action === 'consent.withdrawn' && e.meta.scope === 'raw_answer_sharing'));
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'raw_answer_sharing', granted: true });
});
