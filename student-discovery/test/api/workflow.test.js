import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE } from './helpers.js';
import { drainOutbox, journeySubscriber } from '../../server/audit.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A2 = 'user-student-a2';
const DAY = 86400000;

test('counselor queue shows reasons, hides data when consent is missing, and is scoped to assigned students', async () => {
  const c = await app.as('user-counselor-a');
  const q = (await c.get(`${BASE}/counselor/queue`)).body.items;
  assert.deepEqual(q.map((r) => r.student.id).sort(), ['user-student-a1', 'user-student-a2']);
  const a1 = q.find((r) => r.student.id === 'user-student-a1');
  assert.equal(a1.access, 'no_consent');
  assert.deepEqual(a1.reasons, ['missing_consent']);
  const a2 = q.find((r) => r.student.id === A2);
  assert.equal(a2.access, 'full');
  for (const r of ['unreviewed', 'unverified_evidence', 'appeal', 'stale_catalog']) assert.ok(a2.reasons.includes(r), r);
  assert.equal(JSON.stringify(a1).includes('score'), false);
  assert.equal((await (await app.as('user-student-a2')).get(`${BASE}/counselor/queue`)).status, 403);
  const b = (await (await app.as('user-counselor-b')).get(`${BASE}/counselor/queue`)).body.items;
  assert.deepEqual(b.map((r) => r.student.id), ['user-student-b1']);
});

test('Case 360 bundles evidence and provenance, records an access-reason audit event, and is blocked without consent', async () => {
  const c = await app.as('user-counselor-a');
  const r = await c.get(`${BASE}/students/${A2}/case360?purpose=${encodeURIComponent('weekly review')}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.profile.panels.expressed_interests.score_run_id);
  assert.ok(r.body.evidence.history.length >= 5);
  assert.ok(r.body.notes.some((n) => n.visibility === 'counselor_only'));
  const ev = app.store.db.audit.filter((e) => e.action === 'access.case360').at(-1);
  assert.equal(ev.meta.purpose, 'weekly review');
  assert.equal(ev.actor.id, 'user-counselor-a');
  assert.equal((await c.get(`${BASE}/students/user-student-a1/case360`)).status, 403);
});

test('counselor-only notes are never shown to the student; student-visible ones are', async () => {
  const c = await app.as('user-counselor-a');
  const s = await app.as(A2);
  await c.post(`${BASE}/students/${A2}/notes`, { body: 'PRIVATE concern about family pressure', visibility: 'counselor_only' });
  await c.post(`${BASE}/students/${A2}/notes`, { body: 'Great progress — see you Thursday.', visibility: 'student' });
  const p = (await s.get(`${BASE}/students/${A2}/discovery-profile`)).body;
  const texts = p.notes.map((n) => n.body);
  assert.ok(texts.includes('Great progress — see you Thursday.'));
  assert.equal(texts.some((t) => t.includes('PRIVATE')), false);
  assert.equal(p.notes[0].author_id, undefined);
  assert.equal((await c.post(`${BASE}/students/${A2}/notes`, { body: '' })).status, 422);
  assert.equal((await s.post(`${BASE}/students/${A2}/notes`, { body: 'x y z' })).status, 403, 'students cannot write counselor notes');
  const g = await (await app.as('user-guardian-a2')).get(`${BASE}/students/${A2}/guardian-summary`);
  assert.equal(JSON.stringify(g.body).includes('PRIVATE'), false);
});

test('AC-11 a signed interpretation override leaves sealed answers and scores untouched', async () => {
  const c = await app.as('user-counselor-a');
  const s = await app.as(A2);
  const run = Object.values(app.store.db.score_runs).find((r) => r.student_id === A2 && r.instrument_id === 'interest_exploratory');
  const snapshot = JSON.stringify([run, Object.values(app.store.db.responses).filter((r) => r.session_id === run.session_id)]);

  assert.equal((await c.post(`${BASE}/students/${A2}/overrides`, { score_run_id: run.id, text: 'Treat Social as a secondary interest', reason: 'short' })).status, 422);
  const o = await c.post(`${BASE}/students/${A2}/overrides`, { score_run_id: run.id, text: 'Social interest is likely under-reported (student reports volunteering weekly).', reason: 'Student interview on 2026-10-10 contradicts item pattern.', visibility: 'student' });
  assert.equal(o.status, 201);
  assert.equal(o.body.score_run_execution_hash, run.execution_hash);
  assert.equal(JSON.stringify([run, Object.values(app.store.db.responses).filter((r) => r.session_id === run.session_id)]), snapshot, 'nothing sealed changed');

  const score = (await s.get(`${BASE}/sessions/${run.session_id}/score`)).body;
  assert.equal(score.overrides.length, 1);
  assert.equal(score.overrides[0].reason, undefined, 'the signed reason is for counselors/auditors');
  assert.equal(score.execution_hash, run.execution_hash);
  assert.equal((await s.post(`${BASE}/students/${A2}/overrides`, { score_run_id: run.id, text: 'hack hack', reason: 'long enough reason here' })).status, 403);
  assert.ok(app.store.db.audit.some((e) => e.action === 'override.signed' && e.subject_ref === `score_run:${run.id}`));
  const replay = await s.post(`${BASE}/sessions/${run.session_id}/replay`, {});
  assert.equal(replay.body.match, true, 'the original result still replays after an override');
});

test('AC-17 a student can challenge a suggestion and ask for review; a counselor resolves it with a reason', async () => {
  const s = await app.as(A2);
  const c = await app.as('user-counselor-a');
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'appeal', message: '' })).status, 422);
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'safeguarding_referral', message: 'x' })).status, 400, 'students use student reasons');
  const open = await s.post(`${BASE}/students/${A2}/counselor-review`, { reason_code: 'interpretation_dispute', message: 'I do not think my Social score reflects me.', subject_ref: 'score_run:abc' });
  assert.equal(open.status, 201);
  assert.equal(open.body.status, 'open');
  assert.equal(open.body.assignee_id, 'user-counselor-a');
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'help_request' })).status, 201, 'asking for help needs no message');
  const mine = (await s.get(`${BASE}/students/${A2}/cases`)).body;
  assert.ok(mine.length >= 3);
  assert.equal(mine[0].assignee_id, undefined);

  assert.equal((await c.patch(`${BASE}/cases/${open.body.id}`, { status: 'resolved' })).status, 422);
  assert.equal((await c.patch(`${BASE}/cases/${open.body.id}`, { status: 'weird' })).status, 400);
  const done = await c.patch(`${BASE}/cases/${open.body.id}`, { status: 'resolved', resolution: 'Discussed; added an interpretation note.' });
  assert.equal(done.body.status, 'resolved');
  assert.ok(done.body.resolved_at);
  assert.equal((await s.patch(`${BASE}/cases/${open.body.id}`, { status: 'open' })).status, 403);
  const a1 = await app.as('user-student-a1');
  assert.equal((await a1.patch(`${BASE}/cases/${open.body.id}`, { status: 'open' })).status, 403);
});

test('counselor-opened safeguarding referral appears in the queue', async () => {
  const c = await app.as('user-counselor-a');
  const r = await c.post(`${BASE}/students/${A2}/cases`, { reason_code: 'safeguarding_referral', message: 'Referral raised per school policy (synthetic).' });
  assert.equal(r.status, 201);
  const q = (await c.get(`${BASE}/counselor/queue`)).body.items.find((x) => x.student.id === A2);
  assert.ok(q.reasons.includes('safeguarding_referral'));
});

test('report: hash-bound approval, DRAFT watermark until approved, guardian only via an unexpired share', async () => {
  const s = await app.as(A2);
  const c = await app.as('user-counselor-a');
  const g = await app.as('user-guardian-a2');

  const gen = await s.post(`${BASE}/students/${A2}/reports`, {});
  assert.ok([200, 201].includes(gen.status));
  const id = gen.body.id;
  const again = await s.post(`${BASE}/students/${A2}/reports`, {});
  assert.equal(again.body.id, id, 'identical content is the same report');

  const view = (await s.get(`${BASE}/reports/${id}`)).body;
  assert.equal(view.watermark, 'DRAFT');
  assert.equal(view.payload.sections.demonstrated_capabilities.status, 'not_available');
  assert.ok(view.payload.limitations.includes('no_norms_or_percentiles'));
  assert.ok(view.payload.limitations.includes('not_an_admission_decision'));
  assert.equal(view.payload.sections.recommendations.items.every((i) => !('acceptance_probability' in i)), true);

  // not in review yet => cannot be decided
  assert.equal((await c.post(`${BASE}/reports/${id}/approval`, { action: 'approve', payload_hash: view.payload_hash })).status, 409);
  const rr = await s.post(`${BASE}/reports/${id}/review-request`, {});
  assert.equal(rr.body.status, 'review_requested');
  assert.equal((await g.get(`${BASE}/reports/${id}`)).status, 403);

  const wrong = await c.post(`${BASE}/reports/${id}/approval`, { action: 'approve', payload_hash: 'f'.repeat(64) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'payload_hash_mismatch');
  assert.equal((await s.post(`${BASE}/reports/${id}/approval`, { action: 'approve', payload_hash: view.payload_hash })).status, 403, 'a student cannot approve');
  const ok = await c.post(`${BASE}/reports/${id}/approval`, { action: 'approve', payload_hash: view.payload_hash });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.report.status, 'approved');
  assert.equal(ok.body.approval.exact_payload_hash, view.payload_hash);
  assert.equal(ok.body.approval.approver_id, 'user-counselor-a');
  assert.equal((await s.get(`${BASE}/reports/${id}`)).body.watermark, null);
  assert.equal((await c.post(`${BASE}/reports/${id}/approval`, { action: 'approve', payload_hash: view.payload_hash })).status, 409, 'decided once');

  // approved but not shared => guardian still blocked
  const blocked = await g.get(`${BASE}/reports/${id}`);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.reason, 'report_not_shared');

  const share = await s.post(`${BASE}/reports/${id}/shares`, { days: 7 });
  assert.equal(share.status, 201);
  assert.equal((await s.post(`${BASE}/reports/${id}/shares`, { days: 999 })).status, 400);
  const gv = await g.get(`${BASE}/reports/${id}`);
  assert.equal(gv.status, 200);
  assert.equal(JSON.stringify(gv.body).includes('INT-'), false);
  assert.ok(app.store.db.audit.some((e) => e.action === 'access.report_guardian'));

  app.advance(8 * DAY);
  assert.equal((await g.get(`${BASE}/reports/${id}`)).status, 401, 'the 8-hour login itself has expired');
  const expired = await (await app.as('user-guardian-a2')).get(`${BASE}/reports/${id}`);
  assert.equal(expired.status, 403);
  assert.equal(expired.body.reason, 'report_not_shared', 'the 7-day share has expired');
  app.advance(-8 * DAY);
  assert.equal((await (await app.as('user-guardian-a2')).get(`${BASE}/reports/${id}`)).status, 200);
  assert.equal((await s.del(`${BASE}/shares/${share.body.id}`)).body.revoked_reason, 'revoked_by_student');
  assert.equal((await (await app.as('user-guardian-a2')).get(`${BASE}/reports/${id}`)).status, 403);

  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'discovery.report.approved'));
  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'discovery.report.review_requested'));
});

test('a report change after generation is a different report; the approved one is immutable', async () => {
  const s = await app.as(A2);
  const c = await app.as('user-counselor-a');
  const approved = Object.values(app.store.db.reports).find((r) => r.status === 'approved');
  const frozen = JSON.stringify(approved);
  const run = Object.values(app.store.db.score_runs).find((r) => r.student_id === A2 && r.instrument_id === 'interest_exploratory');
  await c.post(`${BASE}/students/${A2}/overrides`, { score_run_id: run.id, text: 'Another visible interpretation note.', reason: 'Follow-up conversation outcome recorded.', visibility: 'student' });
  const next = await s.post(`${BASE}/students/${A2}/reports`, {});
  assert.equal(next.status, 201);
  assert.notEqual(next.body.id, approved.id);
  assert.notEqual(next.body.payload_hash, approved.payload_hash);
  assert.equal(next.body.status, 'draft');
  assert.equal(JSON.stringify(app.store.db.reports[approved.id]), frozen);
});

test('report generation requires at least one sealed result', async () => {
  const a1 = await app.as('user-student-a1');
  const g1 = await app.as('user-guardian-a1');
  await a1.post(`${BASE}/students/user-student-a1/consent`, { scope: 'assessment_processing', granted: true });
  await g1.post(`${BASE}/students/user-student-a1/consent`, { scope: 'assessment_processing', granted: true });
  const r = await a1.post(`${BASE}/students/user-student-a1/reports`, {});
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'no_sealed_results');
});

test('four-eyes rule publication: the author cannot publish; a second steward can; sources are mandatory', async () => {
  const s1 = await app.as('user-steward-1');
  const s2 = await app.as('user-steward-2');
  const draftBody = {
    program_id: 'prog-demo-media', cycle: '2027',
    conditions: [{ key: 'pathway', value: ['general'] }, { key: 'secondary_percentage', value: 76 }, { key: 'gat', value: 65 }],
    source: { publisher: 'Demo University Admissions Office (fictional)', source_url: 'https://example.invalid/media', published_at: '2026-09-01', captured_at: '2026-10-01' },
    effective_from: '2026-09-01', effective_to: '2027-12-31', review_due_at: '2027-03-31',
  };
  const noSource = await s1.post(`${BASE}/admin/program-rules`, { ...draftBody, source: { publisher: 'x' } });
  assert.equal(noSource.status, 422);
  assert.equal(noSource.body.code, 'source_required');
  assert.equal((await s1.post(`${BASE}/admin/program-rules`, { ...draftBody, conditions: [{ key: 'gat', value: 500 }] })).status, 422);
  assert.equal((await s1.post(`${BASE}/admin/program-rules`, { ...draftBody, conditions: [{ key: 'height', value: 5 }] })).status, 422);
  assert.equal((await s1.post(`${BASE}/admin/program-rules`, { ...draftBody, effective_to: '2025-01-01' })).status, 422);
  assert.equal((await (await app.as('user-psych-1')).post(`${BASE}/admin/program-rules`, draftBody)).status, 403);

  const draft = await s1.post(`${BASE}/admin/program-rules`, draftBody);
  assert.equal(draft.status, 201);
  assert.equal(draft.body.state, 'draft');
  assert.equal((await (await app.as(A2)).get(`${BASE}/programs/prog-demo-media/admissions`)).body.source_state, 'none', 'a draft is not a source');

  const self = await s1.post(`${BASE}/admin/program-rules/${draft.body.id}/publish`, {});
  assert.equal(self.status, 403);
  assert.equal(self.body.reason, 'four_eyes_required');
  assert.ok(app.store.db.audit.some((e) => e.action === 'security.access_denied' && e.meta.reason === 'four_eyes_required'));
  const pub = await s2.post(`${BASE}/admin/program-rules/${draft.body.id}/publish`, {});
  assert.equal(pub.status, 200);
  assert.equal((await (await app.as(A2)).get(`${BASE}/programs/prog-demo-media/admissions`)).body.source_state, 'verified_current');
  assert.equal((await s2.post(`${BASE}/admin/program-rules/${draft.body.id}/publish`, {})).status, 409);
});

test('catalog.admission_rule.expired is emitted once when a published rule passes its review date', async () => {
  const before = app.store.db.outbox.filter((e) => e.event_type === 'catalog.admission_rule.expired').length;
  app.advance(200 * DAY);
  const c = await app.as('user-steward-1');
  await c.get(`${BASE}/admin/program-rules`);
  await c.post(`${BASE}/admin/program-rules`, {}); // any request triggers maintenance
  const mid = app.store.db.outbox.filter((e) => e.event_type === 'catalog.admission_rule.expired').length;
  assert.ok(mid > before);
  await c.get(`${BASE}/admin/program-rules`);
  await c.post(`${BASE}/admin/program-rules`, {});
  assert.equal(app.store.db.outbox.filter((e) => e.event_type === 'catalog.admission_rule.expired').length, mid, 'emitted once per rule');
  const rules = (await c.get(`${BASE}/admin/program-rules`)).body.items;
  assert.ok(rules.filter((r) => r.source_state === 'stale').length >= 10);
  app.advance(-200 * DAY);
});

test('outbox delivery is at-least-once: a failing consumer keeps the event for retry', async () => {
  const db = app.store.db;
  db.outbox.push({ id: 'ev-test-1', event_type: 'discovery.score.ready', aggregate_id: 'x', payload: { student_id: A2 }, idempotency_key: 'k', created_at: app.clock().toISOString(), published_at: null, retry_count: 0, last_error: null });
  let fail = true;
  const flaky = () => { if (fail) throw new Error('queue outage'); };
  assert.equal(drainOutbox(db, [flaky, journeySubscriber], app.clock()), 0);
  const ev = db.outbox.find((e) => e.id === 'ev-test-1');
  assert.equal(ev.published_at, null);
  assert.equal(ev.retry_count, 1);
  fail = false;
  assert.equal(drainOutbox(db, [flaky, journeySubscriber], app.clock()), 1);
  assert.ok(ev.published_at);
  drainOutbox(db, [journeySubscriber], app.clock());
  assert.equal(db.journey[A2].filter((m) => m.event_id === 'ev-test-1').length, 1, 'consumer is idempotent');
});

test('control tower: small cohorts are suppressed; roles are enforced; tenant admin sees only their school', async () => {
  const t = await app.as('user-tenant-admin-a');
  const r = await t.get(`${BASE}/admin/control-tower`);
  assert.equal(r.status, 200);
  assert.equal(r.body.min_cell_size, 5);
  assert.equal(r.body.cohort.opted_in_students.suppressed, true);
  assert.equal(r.body.cohort.opted_in_students.value, null);
  assert.ok(r.body.modules.every((m) => m.started.suppressed && m.median_completion_seconds.suppressed));
  assert.equal(r.body.catalog_freshness.programs, 15);
  assert.equal(r.body.operations.audit_chain.ok, true);
  assert.equal(JSON.stringify(r.body).includes('user-student'), false, 'no identifiers in aggregates');
  assert.equal((await (await app.as(A2)).get(`${BASE}/admin/control-tower`)).status, 403);
  assert.equal((await (await app.as('user-counselor-a')).get(`${BASE}/admin/control-tower`)).status, 403);

  // with enough opted-in students the numbers appear
  const db = app.store.db;
  for (let i = 0; i < 5; i++) {
    const id = `user-synth-${i}`;
    db.users[id] = { id, role: 'student', tenant_id: 'school-a', display_name: { en: id, 'ar-SA': id }, grade: 12, date_of_birth: '2000-01-01', synthetic: true };
    db.consent_records[`c${i}`] = { id: `c${i}`, seq: 1000 + i, subject_id: id, actor_id: id, actor_role: 'student', scope: 'aggregate_analytics', state: 'granted', created_at: app.clock().toISOString() };
  }
  const t2 = (await t.get(`${BASE}/admin/control-tower`)).body;
  assert.equal(t2.cohort.opted_in_students.suppressed, false);
  assert.equal(t2.cohort.opted_in_students.value, 6);
});

test('audit log is readable only by the security role and is filterable', async () => {
  const sec = await app.as('user-security');
  const r = await sec.get(`${BASE}/admin/audit?action=consent.&limit=5`);
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length > 0 && r.body.items.every((e) => e.action.startsWith('consent.')));
  assert.equal(r.body.chain.ok, true);
  assert.equal((await (await app.as('user-tenant-admin-a')).get(`${BASE}/admin/audit`)).status, 403);
});

test('preferences: accessibility settings are validated and stored per student', async () => {
  const s = await app.as(A2);
  const r = await s.put(`${BASE}/students/${A2}/preferences`, { accessibility: { text_size: 'xlarge', high_contrast: true, reduce_motion: 'yes', evil: '<script>' }, locale: 'ar-SA' });
  assert.deepEqual(r.body, { accessibility: { text_size: 'xlarge', high_contrast: true, reduce_motion: false }, locale: 'ar-SA' });
  assert.equal((await s.put(`${BASE}/students/${A2}/preferences`, { locale: 'fr' })).status, 400);
  const p = (await s.get(`${BASE}/students/${A2}/discovery-profile`)).body;
  assert.equal(p.preferences.accessibility.text_size, 'xlarge');
  assert.equal((await (await app.as('user-student-a1')).put(`${BASE}/students/${A2}/preferences`, { locale: 'en' })).status, 403);
});
