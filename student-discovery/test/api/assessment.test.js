import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE, startSession, answerAll, ivid } from './helpers.js';
import { getInstrument } from '../../domain/instruments/registry.js';
import { computeScore } from '../../domain/scoring/index.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A1 = 'user-student-a1';
const A2 = 'user-student-a2';

test('AC-01 without consent the session is refused and the reason is explicit', async () => {
  const a1 = await app.as(A1);
  const r = await startSession(a1, 'interest_exploratory');
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'consent_required');
  assert.equal(Object.values(app.store.db.sessions).filter((s) => s.student_id === A1).length, 0);
  assert.ok(app.store.db.audit.some((e) => e.action === 'security.access_denied' && e.meta.reason === 'consent_required'));
});

test('minor needs student assent AND guardian authorization; guardian cannot grant sharing scopes', async () => {
  const a1 = await app.as(A1);
  const g1 = await app.as('user-guardian-a1');
  const assent = await a1.post(`${BASE}/students/${A1}/consent`, { scope: 'assessment_processing', granted: true });
  assert.equal(assent.body.consent.scopes.assessment_processing.status, 'pending');
  assert.deepEqual(assent.body.consent.scopes.assessment_processing.pending, ['guardian']);
  assert.equal((await startSession(a1, 'interest_exploratory')).status, 403);

  const overreach = await g1.post(`${BASE}/students/${A1}/consent`, { scope: 'counselor_sharing', granted: true });
  assert.equal(overreach.status, 403);
  assert.equal(overreach.body.reason, 'guardian_scope_not_permitted');

  const auth = await g1.post(`${BASE}/students/${A1}/consent`, { scope: 'assessment_processing', granted: true });
  assert.equal(auth.body.consent.scopes.assessment_processing.active, true);
  assert.equal((await startSession(a1, 'interest_exploratory')).status, 201);

  const consentRows = Object.values(app.store.db.consent_records).filter((r) => r.subject_id === A1);
  assert.deepEqual(consentRows.map((r) => r.actor_role).sort(), ['guardian', 'student']);
  for (const r of consentRows) {
    assert.equal(r.policy_version, 'consent-policy-DEMO-0.1');
    assert.ok(r.legal_basis_ref.startsWith('PENDING'), 'legal basis is explicitly unresolved, not invented');
  }
});

test('an adult student (18+) does not need a guardian', async () => {
  const b1 = await app.as('user-student-b1');
  const c = await b1.get(`${BASE}/students/user-student-b1/consent`);
  assert.equal(c.body.guardian_required, false);
  assert.equal(c.body.scopes.assessment_processing.active, true);
});

test('consent choices are explicit: repeating the same choice is a no-op', async () => {
  const a2 = await app.as(A2);
  const n = Object.keys(app.store.db.consent_records).length;
  const r = await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: true });
  assert.equal(r.body.changed, false);
  assert.equal(Object.keys(app.store.db.consent_records).length, n);
  assert.equal((await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'made_up', granted: true })).status, 400);
  assert.equal((await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: 'yes' })).status, 400);
});

test('AC-03 save & resume: answers survive re-login, no duplication, idempotent session create', async () => {
  const a1 = await app.as(A1);
  const key = 'resume-test-key-1';
  const s1 = await startSession(a1, 'work_values_exploratory', key);
  assert.equal(s1.status, 201);
  const id = s1.body.session_id;
  for (const [item, v] of [['VAL-security', 4], ['VAL-helping', 2], ['VAL-security', 5]]) {
    assert.equal((await a1.put(`${BASE}/sessions/${id}/responses/${item}`, { value: v })).status, 200);
  }
  const again = await startSession(a1, 'work_values_exploratory', key);
  assert.equal(again.status, 200);
  assert.equal(again.body.session_id, id);
  const another = await startSession(a1, 'work_values_exploratory', 'a-different-key-2');
  assert.equal(another.body.session_id, id, 'only one open attempt per instrument');

  const relogin = await app.as(A1);
  const resumed = await relogin.get(`${BASE}/sessions/${id}`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.responses['VAL-security'], { value: 5, revision_seq: 2 });
  assert.equal(Object.keys(resumed.body.responses).length, 2);
  assert.equal(Object.values(app.store.db.responses).filter((r) => r.session_id === id).length, 2);
  assert.equal(JSON.stringify(resumed.body).includes('answer_key'), false);
  assert.deepEqual(Object.keys(resumed.body.scales), ['importance']);
});

test('response validation is server-side; stale If-Match yields 412; unknown item 404', async () => {
  const a1 = await app.as(A1);
  const id = (await startSession(a1, 'work_values_exploratory')).body.session_id;
  const put = (item, v, h) => a1.put(`${BASE}/sessions/${id}/responses/${item}`, { value: v }, h);
  for (const bad of [0, 6, 'x', null, 2.5, 'na']) assert.equal((await put('VAL-income', bad)).status, 422, String(bad));
  assert.equal((await put('NOPE', 3)).status, 404);
  const ok = await put('VAL-income', 3);
  assert.equal(ok.headers.get('etag'), '"1"');
  assert.equal((await put('VAL-income', 4, { 'if-match': '"1"' })).status, 200);
  const stale = await put('VAL-income', 5, { 'if-match': '"1"' });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.current_revision, 2, 'the problem tells the client which revision is current');
  assert.equal(stale.body.code, 'precondition_failed');
});

test('AC-04 submitted interest scores equal an independent hand computation', async () => {
  const b1 = await app.as('user-student-b1');
  // B1 was seeded with a completed interest module; start a fresh attempt with known values
  const s = await startSession(b1, 'interest_exploratory');
  assert.equal(s.status, 201);
  assert.equal(s.body.attempt_no, 2);
  const fixture = { R: [5, 4, 3, 2, 1, 5], I: [3, 3, 3, 3, 3, 3], A: [1, 1, 1, 1, 1, 1], S: [5, 5, 5, 5, 5, 5], E: [2, 2, 2, 2, 4, 4], C: [3, 3, 3, 3, 5, 1] };
  const val = (it) => fixture[it.construct.slice(-1)][Number(it.item_id.slice(-3)) - 1];
  const sub = await answerAll(b1, s.body.session_id, 'interest_exploratory', val);
  assert.equal(sub.status, 201);
  const score = await b1.get(`${BASE}/sessions/${s.body.session_id}/score`);
  assert.equal(score.status, 200);
  const hand = { R: 25 * (20 / 6 - 1), I: 50, A: 0, S: 100, E: 25 * (16 / 6 - 1), C: 25 * (18 / 6 - 1) };
  for (const d of 'RIASEC') assert.ok(Math.abs(score.body.construct_scores[`RIASEC_${d}`].display_0_100 - hand[d]) < 1e-3, d);
  assert.equal(score.body.norm_reference, null, 'AC-18: no percentile/norm');
  const keys = [];
  JSON.stringify(score.body, (k, v) => (keys.push(k), v));
  assert.deepEqual(keys.filter((k) => /percentile|norm_score|stanine|iq/i.test(k)), [], 'no percentile-like fields exist');
  assert.deepEqual(score.body.ranking.order.map((o) => o.dimension), ['S', 'R', 'I', 'C', 'E', 'A'], 'I and C tie at 50: disclosed fixed order R,I,A,S,E,C');
  assert.deepEqual(score.body.ranking.order.find((o) => o.dimension === 'I').tied_with, ['C']);
  assert.deepEqual(score.body.ranking.top, ['S', 'R', 'I', 'C'], 'a tie at the top-3 boundary is not silently broken');
  const direct = computeScore(getInstrument('interest_exploratory'), Object.fromEntries(getInstrument('interest_exploratory').items.map((it) => [it.item_id, val(it)])));
  assert.equal(score.body.execution_hash, direct.execution_hash, 'server result equals the pure domain function');
});

test('AC-05 incomplete submit needs explicit acknowledgement; an unanswered dimension is insufficient_data', async () => {
  const a1 = await app.as(A1);
  const s = await startSession(a1, 'interest_exploratory');
  const id = s.body.session_id;
  const noA = (it) => (it.construct === 'RIASEC_A' ? undefined : 4);
  const refused = await answerAll(a1, id, 'interest_exploratory', noA);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'incomplete');
  assert.equal(refused.body.unanswered, 6);
  assert.equal((await a1.get(`${BASE}/sessions/${id}`)).body.status, 'in_progress', 'still editable after refusal');
  const done = await a1.post(`${BASE}/sessions/${id}/submit`, { acknowledge_incomplete: true });
  assert.equal(done.status, 201);
  const score = (await a1.get(`${BASE}/sessions/${id}/score`)).body;
  assert.equal(score.construct_scores.RIASEC_A.status, 'insufficient_data');
  assert.equal(score.construct_scores.RIASEC_A.display_0_100, null);
  assert.equal(score.ranking.complete, false);
});

test('sealed attempts cannot change; a retake is a new attempt and the history is kept', async () => {
  const a1 = await app.as(A1);
  const first = Object.values(app.store.db.sessions).find((s) => s.student_id === A1 && s.instrument_id === 'interest_exploratory');
  const r = await a1.put(`${BASE}/sessions/${first.id}/responses/INT-R-001`, { value: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'session_sealed');
  const retake = await startSession(a1, 'interest_exploratory');
  assert.equal(retake.status, 201);
  assert.equal(retake.body.attempt_no, 2);
  const profile = (await a1.get(`${BASE}/students/${A1}/discovery-profile`)).body;
  assert.equal(profile.attempts.interest_exploratory.length, 1);
  assert.equal(profile.modules.find((m) => m.instrument_id === 'interest_exploratory').status, 'in_progress');
});

test('AC-09 replay reproduces the stored hash; a tampered stored answer is detected', async () => {
  const a2 = await app.as(A2);
  const sid = Object.values(app.store.db.sessions).find((s) => s.student_id === A2 && s.instrument_id === 'interest_exploratory').id;
  const ok = await a2.post(`${BASE}/sessions/${sid}/replay`, {});
  assert.equal(ok.body.match, true);
  const key = `${sid}:INT-R-001`;
  const original = app.store.db.responses[key].normalized_response;
  app.store.db.responses[key].normalized_response = original === 5 ? 4 : 5;
  const bad = await a2.post(`${BASE}/sessions/${sid}/replay`, {});
  assert.equal(bad.body.match, false);
  app.store.db.responses[key].normalized_response = original;
  assert.equal((await a2.post(`${BASE}/sessions/${sid}/replay`, {})).body.match, true);
});

test('AC-12 a guardian cannot read raw answers, scores, or the full profile', async () => {
  const g2 = await app.as('user-guardian-a2');
  const sid = Object.values(app.store.db.sessions).find((s) => s.student_id === A2 && s.instrument_id === 'interest_exploratory').id;
  for (const p of [`${BASE}/sessions/${sid}/responses`, `${BASE}/sessions/${sid}`, `${BASE}/sessions/${sid}/score`, `${BASE}/students/${A2}/discovery-profile`, `${BASE}/students/${A2}/evidence`]) {
    const r = await g2.get(p);
    assert.equal(r.status, 403, p);
    assert.equal(r.body.reason, 'role_not_permitted');
    assert.equal(JSON.stringify(r.body).includes('INT-R-001'), false);
  }
  const summary = await g2.get(`${BASE}/students/${A2}/guardian-summary`);
  assert.equal(summary.status, 200);
  const dump = JSON.stringify(summary.body);
  assert.equal(dump.includes('INT-'), false);
  assert.equal(dump.includes('display_0_100'), false);
  assert.equal(dump.includes('secondary_percentage'), false);
  assert.equal(dump.includes('Wants to explore'), false);
  assert.ok(summary.body.top_interests.length >= 3);
});

test('guardian summary disappears when the student withdraws that scope', async () => {
  const a2 = await app.as(A2);
  const g2 = await app.as('user-guardian-a2');
  assert.equal((await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'guardian_summary_sharing', granted: false })).status, 200);
  const r = await g2.get(`${BASE}/students/${A2}/guardian-summary`);
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'consent_scope_inactive');
  await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'guardian_summary_sharing', granted: true });
  assert.equal((await g2.get(`${BASE}/students/${A2}/guardian-summary`)).status, 200);
});

test('AC-14 two concurrent submits produce one sealed attempt and one score_run', async () => {
  const a1 = await app.as(A1);
  const s = await startSession(a1, 'subject_preference_exploratory');
  const id = s.body.session_id;
  await answerAll(a1, id, 'subject_preference_exploratory', (it, i) => (i % 5 === 0 ? 'na' : 1 + (i % 5)), { submit: false });
  const [x, y] = await Promise.all([a1.post(`${BASE}/sessions/${id}/submit`, {}), a1.post(`${BASE}/sessions/${id}/submit`, {})]);
  assert.deepEqual([x.status, y.status].sort(), [200, 201]);
  assert.equal(x.body.score_run_id, y.body.score_run_id);
  assert.equal([x, y].filter((r) => r.body.already_submitted).length, 1);
  assert.equal(Object.values(app.store.db.score_runs).filter((r) => r.session_id === id).length, 1);
  const submittedEvents = app.store.db.outbox.filter((e) => e.event_type === 'discovery.session.submitted' && e.aggregate_id === id);
  assert.equal(submittedEvents.length, 1);
});

test('"not applicable" subjects stay missing, never zero', async () => {
  const a1 = await app.as(A1);
  const sid = Object.values(app.store.db.sessions).find((s) => s.student_id === A1 && s.instrument_id === 'subject_preference_exploratory').id;
  const score = (await a1.get(`${BASE}/sessions/${sid}/score`)).body;
  const na = Object.values(score.construct_scores).filter((c) => c.status === 'not_applicable');
  assert.ok(na.length >= 2);
  for (const c of na) assert.equal(c.value_0_1, null);
});

test('AC-06 suspended, retired and on-hold instruments cannot start; resuming restores them', async () => {
  const psych = await app.as('user-psych-1');
  const a1 = await app.as(A1);
  const apt = await startSession(a1, 'aptitude_reasoning');
  assert.equal(apt.status, 409);
  assert.equal(apt.body.reason, 'instrument_on_hold');
  const cards = (await a1.get(`${BASE}/assessments`)).body.modules;
  const aptCard = cards.find((m) => m.instrument_id === 'aptitude_reasoning');
  assert.equal(aptCard.status, 'unavailable');
  assert.ok(aptCard.hold_reason['ar-SA'].length > 10 && aptCard.hold_reason.en.length > 10);

  const open = (await startSession(a1, 'skills_confidence_selfreport')).body.session_id;
  assert.equal((await psych.post(`${BASE}/admin/instruments/skills_confidence_selfreport/suspend`, { reason: 'Translation defect found' })).status, 200);
  const blockedStart = await startSession(a1, 'skills_confidence_selfreport', 'new-key-xyz-123');
  assert.equal(blockedStart.status, 409);
  assert.equal(blockedStart.body.reason, 'instrument_suspended');
  const blockedWrite = await a1.put(`${BASE}/sessions/${open}/responses/SKL-analytical`, { value: 3 });
  assert.equal(blockedWrite.status, 409);
  assert.equal(blockedWrite.body.reason, 'instrument_suspended');
  assert.equal((await a1.get(`${BASE}/assessments`)).body.modules.find((m) => m.instrument_id === 'skills_confidence_selfreport').status, 'needs_review');
  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'discovery.instrument.suspended'));

  assert.equal((await psych.post(`${BASE}/admin/instruments/skills_confidence_selfreport/resume`, { reason: 'Fixed and re-reviewed' })).status, 200);
  assert.equal((await a1.put(`${BASE}/sessions/${open}/responses/SKL-analytical`, { value: 3 })).status, 200);
  assert.equal((await psych.post(`${BASE}/admin/instruments/skills_confidence_selfreport/suspend`, { reason: 'x' })).status, 422);
});

test('exploratory instruments fail closed when synthetic mode is off', async () => {
  const strict = await startApp({ syntheticMode: false });
  try {
    const a2 = await strict.as(A2);
    const r = await startSession(a2, 'work_values_exploratory');
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'not_approved_for_live_use');
  } finally {
    await strict.close();
  }
});

test('publishing an instrument is blocked, with reasons, while licence / validation evidence is missing', async () => {
  const psych = await app.as('user-psych-1');
  const r = await psych.post(`${BASE}/admin/instruments/interest_exploratory/publish`, { target_state: 'approved_for_pilot' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'publication_blocked');
  assert.ok(r.body.blockers.includes('license_not_confirmed'));
  assert.ok(r.body.blockers.includes('cognitive_interviews_missing'));
  assert.ok(app.store.db.audit.some((e) => e.action === 'instrument.publish_blocked'), 'the block itself is audited');
  const list = (await psych.get(`${BASE}/admin/instruments`)).body.items;
  assert.equal(list.find((i) => i.instrument_id === 'interest_exploratory').governance.license.status, 'original_content_no_third_party_rights_claimed');
  assert.equal(list.find((i) => i.instrument_id === 'aptitude_reasoning').usability.reason, 'instrument_on_hold');
});

test('AC-15 withdrawing consent stops processing and sharing, keeps the student\'s own access, and is reversible', async () => {
  const a2 = await app.as(A2);
  const counselor = await app.as('user-counselor-a');
  const g2 = await app.as('user-guardian-a2');
  const s = await startSession(a2, 'student_constraints');
  assert.equal(s.status, 201);
  const before = await counselor.get(`${BASE}/students/${A2}/case360`);
  assert.equal(before.status, 200);

  const w = await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'assessment_processing', granted: false });
  assert.equal(w.status, 200);
  assert.equal(w.body.consent.scopes.assessment_processing.active, false);
  assert.equal(app.store.db.sessions[s.body.session_id].status, 'suspended_consent');
  for (const [client, path] of [[counselor, `${BASE}/students/${A2}/case360`], [counselor, `${BASE}/students/${A2}/discovery-profile`], [g2, `${BASE}/students/${A2}/guardian-summary`]]) {
    const r = await client.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.reason, 'consent_processing_inactive');
  }
  assert.equal((await startSession(a2, 'work_values_exploratory', 'after-withdraw-1')).status, 403);
  assert.equal((await a2.post(`${BASE}/students/${A2}/recommendations`, {})).status, 403);
  assert.equal((await a2.get(`${BASE}/students/${A2}/discovery-profile`)).status, 200, 'rights of access stay');
  assert.ok(Object.values(app.store.db.retention_tasks).some((t) => t.student_id === A2 && t.state === 'queued_for_policy_decision'));
  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'discovery.consent.withdrawn' && e.payload.student_id === A2));
  assert.ok(app.store.db.audit.some((e) => e.action === 'consent.withdrawn'), 'withdrawal does not delete audit records');

  // guardian can also withdraw; student re-grant alone is not enough
  await a2.post(`${BASE}/students/${A2}/consent`, { scope: 'assessment_processing', granted: true });
  assert.equal(app.store.db.sessions[s.body.session_id].status, 'in_progress', 'restored once active again');
  assert.equal((await g2.post(`${BASE}/students/${A2}/consent`, { scope: 'assessment_processing', granted: false })).status, 200);
  assert.equal(app.store.db.sessions[s.body.session_id].status, 'suspended_consent');
  await g2.post(`${BASE}/students/${A2}/consent`, { scope: 'assessment_processing', granted: true });
  assert.equal((await counselor.get(`${BASE}/students/${A2}/case360`)).status, 200);
});

test('the journey stand-in receives milestones from the outbox (idempotently)', async () => {
  const m = app.store.db.journey[A2];
  assert.ok(m.length > 5);
  assert.equal(new Set(m.map((x) => x.event_id)).size, m.length);
  assert.ok(m.some((x) => x.key === 'journey.profile_updated'));
  assert.ok(app.store.db.outbox.every((e) => e.published_at || e.retry_count >= 0));
});

test('instrument version ids resolve; unknown ones are rejected', async () => {
  const a2 = await app.as(A2);
  assert.equal((await a2.post(`${BASE}/sessions`, { instrument_version_id: 'nope@1', idempotency_key: 'abcdefgh1' })).status, 400);
  assert.equal((await a2.post(`${BASE}/sessions`, { instrument_version_id: ivid('work_values_exploratory'), locale: 'fr', idempotency_key: 'abcdefgh2' })).status, 400);
  assert.equal((await a2.post(`${BASE}/sessions`, { instrument_version_id: ivid('work_values_exploratory') })).status, 400);
});
