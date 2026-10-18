import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE, startSession, answerAll } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A2 = 'user-student-a2';
const item = (run, id) => run.output.items.find((i) => i.program_id === id);

async function latestRun(c, studentId = A2) {
  const r = await c.post(`${BASE}/students/${studentId}/recommendations`, {});
  assert.ok([200, 201].includes(r.status), r.text);
  return r.body;
}

test('program catalog is clearly fictional, filterable and paginated', async () => {
  const c = await app.as(A2);
  const all = await c.get(`${BASE}/programs`);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 15);
  assert.ok(all.body.items.every((p) => p.fictional === true));
  assert.ok(all.body.items.every((p) => /fictional|وهمية/.test(p.university.name.en + p.university.name['ar-SA'])));
  assert.equal((await c.get(`${BASE}/programs?cluster=health`)).body.total, 4);
  assert.equal((await c.get(`${BASE}/programs?q=architecture`)).body.items[0].program_id, 'prog-demo-arch');
  assert.equal((await c.get(`${BASE}/programs?q=${encodeURIComponent('الطب')}`)).body.items[0].program_id, 'prog-demo-med');
  assert.equal((await c.get(`${BASE}/programs?limit=3&offset=3`)).body.items.length, 3);
  assert.equal((await c.get(`${BASE}/programs?source_state=stale`)).body.items[0].program_id, 'prog-demo-nurs');
  assert.equal((await c.get(`${BASE}/programs/nope`)).status, 404);
});

test('admissions endpoint exposes provenance, version and freshness (spec §8)', async () => {
  const c = await app.as(A2);
  const cs = (await c.get(`${BASE}/programs/prog-demo-cs/admissions?cycle=2027`)).body;
  assert.equal(cs.source_state, 'verified_current');
  for (const k of ['publisher', 'source_url', 'published_at', 'captured_at']) assert.ok(cs.rule.source[k], k);
  for (const k of ['effective_from', 'effective_to', 'review_due_at', 'cycle', 'verified_by']) assert.ok(cs.rule[k], k);
  assert.equal(cs.drafts, undefined, 'students do not see drafts');
  assert.equal((await c.get(`${BASE}/programs/prog-demo-cs/admissions?cycle=abc`)).status, 400);
  assert.equal((await c.get(`${BASE}/programs/prog-demo-cs/admissions?cycle=2031`)).body.source_state, 'none');
  assert.equal((await c.get(`${BASE}/programs/prog-demo-nurs/admissions`)).body.source_state, 'stale');
  const steward = await app.as('user-steward-1');
  assert.equal((await steward.get(`${BASE}/programs/prog-demo-nurs/admissions`)).body.drafts.length, 1);
});

test('AC-07 / AC-08 stale, conflicting and absent sources are never "eligible"; missing exam score stays evidence_missing', async () => {
  const c = await app.as(A2);
  const run = await latestRun(c);
  assert.equal(item(run, 'prog-demo-nurs').admission_status.eligibility, 'source_stale');
  assert.equal(item(run, 'prog-demo-psy').admission_status.eligibility, 'manual_review_required');
  assert.equal(item(run, 'prog-demo-psy').admission_status.source_state, 'conflicting');
  assert.equal(item(run, 'prog-demo-media').admission_status.eligibility, 'not_evaluated');
  const cs = item(run, 'prog-demo-cs');
  assert.equal(cs.interest_fit.status, 'ok');
  assert.ok(cs.interest_fit.value > 0.5);
  assert.equal(cs.admission_status.eligibility, 'evidence_missing', 'saat is missing');
  assert.deepEqual(cs.admission_status.required_evidence, ['saat']);
  assert.ok(cs.uncertainties.includes('evidence_unverified'), 'unverified GAT is flagged, not trusted');
  for (const i of run.output.items) {
    assert.equal(i.admission_status.acceptance_probability, null, 'AC-18 / §5.1.6: no admission probability');
    assert.equal(i.composite_fit.status, 'incomplete');
    assert.equal(i.demonstrated_skills_alignment.status, 'not_available');
    assert.equal(i.capability_readiness.aptitude.status, 'on_hold');
  }
});

test('explainability payload is complete for every item and the run is marked non-authoritative', async () => {
  const c = await app.as(A2);
  const run = await latestRun(c);
  assert.equal(run.decision_status, 'system_generated_non_authoritative');
  assert.ok(run.catalog_snapshot_id.startsWith('cat-'));
  assert.ok(run.input_snapshot_hash.length === 64);
  assert.ok(run.score_run_ids.interest_exploratory);
  for (const i of run.output.items) {
    for (const k of ['program_id', 'rank_if_available', 'interest_evidence', 'academic_evidence', 'admission_status', 'rule_version', 'missing_inputs', 'uncertainties', 'alternatives', 'human_review_status']) assert.ok(k in i, `${i.program_id}.${k}`);
  }
  const ranks = run.output.items.map((i) => i.rank_if_available).filter((r) => r !== null);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const top3 = run.output.items.slice(0, 3).map((i) => i.program_id);
  assert.ok(top3.some((p) => ['prog-demo-cs', 'prog-demo-se', 'prog-demo-me', 'prog-demo-bio'].includes(p)), `investigative+realistic profile should surface technical programs, got ${top3}`);
});

test('re-running with identical inputs returns the same run (idempotent); history lists it once', async () => {
  const c = await app.as(A2);
  const a = await c.post(`${BASE}/students/${A2}/recommendations`, {});
  const b = await c.post(`${BASE}/students/${A2}/recommendations`, {});
  assert.equal(b.status, 200);
  assert.equal(b.body.reused, true);
  assert.equal(a.body.id, b.body.id);
  const list = (await c.get(`${BASE}/students/${A2}/recommendations`)).body;
  assert.equal(new Set(list.map((r) => r.id)).size, list.length);
});

test('AC-16 a new verified rule produces a new, labelled-as-recomputed run while the old run stays reproducible', async () => {
  const c = await app.as(A2);
  const before = await latestRun(c);
  const frozen = JSON.stringify((await c.get(`${BASE}/recommendations/${before.id}`)).body);
  assert.equal(item(before, 'prog-demo-nurs').admission_status.eligibility, 'source_stale');

  const s2 = await app.as('user-steward-2');
  const draftId = (await (await app.as('user-steward-1')).get(`${BASE}/admin/program-rules`)).body.items.find((i) => i.program_id === 'prog-demo-nurs').drafts[0].id;
  const pub = await s2.post(`${BASE}/admin/program-rules/${draftId}/publish`, {});
  assert.equal(pub.status, 200);
  assert.equal(pub.body.state, 'published');
  assert.equal(pub.body.verified_by, 'user-steward-2');
  assert.ok(app.store.db.outbox.some((e) => e.event_type === 'catalog.admission_rule.published'));

  const after = await latestRun(c);
  assert.notEqual(after.id, before.id);
  assert.equal(after.recomputed, true);
  assert.equal(after.supersedes_run_id, before.id);
  assert.notEqual(after.catalog_snapshot_id, before.catalog_snapshot_id);
  assert.equal(item(after, 'prog-demo-nurs').admission_status.source_state, 'verified_current');
  assert.notEqual(item(after, 'prog-demo-nurs').admission_status.eligibility, 'source_stale');
  assert.ok(after.changes_since_previous.some((x) => x.program_id === 'prog-demo-nurs' && x.field === 'rule_snapshot'));
  assert.ok(after.changes_since_previous.some((x) => x.program_id === 'prog-demo-nurs' && x.field === 'eligibility'));

  assert.equal(JSON.stringify((await c.get(`${BASE}/recommendations/${before.id}`)).body), frozen, 'the old run is byte-identical');
  const hist = (await c.get(`${BASE}/programs/prog-demo-nurs/admissions`)).body.versions;
  assert.deepEqual(hist.map((v) => v.state), ['published', 'superseded']);
});

test('evidence: a student entry is never proof; verifying needs a counselor and a note; edits reset verification', async () => {
  const a2 = await app.as(A2);
  const counselor = await app.as('user-counselor-a');
  const ev = (await a2.get(`${BASE}/students/${A2}/evidence`)).body;
  assert.equal(ev.latest.gat.verification_state, 'unverified');
  assert.equal(ev.latest.secondary_percentage.verification_state, 'counselor_verified');

  assert.equal((await a2.post(`${BASE}/students/${A2}/evidence/${ev.latest.gat.id}/verify`, { note: 'I checked myself' })).status, 403);
  assert.equal((await counselor.post(`${BASE}/students/${A2}/evidence/${ev.latest.gat.id}/verify`, {})).status, 422);
  const v = await counselor.post(`${BASE}/students/${A2}/evidence/${ev.latest.gat.id}/verify`, { note: 'Saw the official score report (synthetic).' });
  assert.equal(v.body.evidence.verification_state, 'counselor_verified');

  const saat = await a2.put(`${BASE}/students/${A2}/evidence/saat`, { value: '٨٨٫٥' }); // Arabic-Indic digits
  assert.equal(saat.body.evidence.value, 88.5);
  assert.equal(saat.body.evidence.verification_state, 'unverified');
  const edit = await a2.put(`${BASE}/students/${A2}/evidence/secondary_percentage`, { value: 92 });
  assert.equal(edit.body.changed, true);
  assert.equal(edit.body.evidence.verification_state, 'unverified', 'changing a verified value resets verification');
  assert.equal((await counselor.post(`${BASE}/students/${A2}/evidence/${ev.latest.secondary_percentage.id}/verify`, { note: 'old record check' })).status, 409);

  for (const [t, v] of [['gat', 150], ['gat', 'abc'], ['pathway', 'invalid'], ['nope', 1]]) assert.ok([404, 422].includes((await a2.put(`${BASE}/students/${A2}/evidence/${t}`, { value: v })).status), `${t}=${v}`);
  const same = await a2.put(`${BASE}/students/${A2}/evidence/gat`, { value: 84 });
  assert.equal(same.body.changed, false, 'the same value is a no-op and keeps its verification');
  assert.equal(same.body.evidence.verification_state, 'counselor_verified');
  const diff = await a2.put(`${BASE}/students/${A2}/evidence/gat`, { value: 85 });
  assert.equal(diff.body.changed, true);
  assert.equal(diff.body.evidence.verification_state, 'unverified');
});

test('eligibility moves through the gate as evidence is supplied and verified', async () => {
  const a2 = await app.as(A2);
  const counselor = await app.as('user-counselor-a');
  const ev = async () => (await a2.get(`${BASE}/students/${A2}/evidence`)).body.latest;
  for (const t of ['secondary_percentage', 'gat', 'saat', 'pathway']) {
    const e = (await ev())[t];
    if (e.verification_state !== 'counselor_verified') await counselor.post(`${BASE}/students/${A2}/evidence/${e.id}/verify`, { note: 'Verified against synthetic documents.' });
  }
  const run = await latestRun(a2);
  const cs = item(run, 'prog-demo-cs');
  assert.equal(cs.admission_status.eligibility, 'verified_eligible');
  assert.equal(cs.admission_status.acceptance_probability, null);
  assert.equal(cs.admission_status.competitive, true, 'eligibility is not acceptance');
  assert.equal(item(run, 'prog-demo-med').admission_status.eligibility, 'verified_ineligible', 'pathway/scores are below the (fictional) medicine rule');
  assert.ok(item(run, 'prog-demo-med').tensions.some((t) => t.key === 'admission_condition_not_met'));
});

test('AC-05 a profile with an insufficient dimension yields no interest fit (never a zero fit)', async () => {
  const a1 = await app.as('user-student-a1');
  const g1 = await app.as('user-guardian-a1');
  await a1.post(`${BASE}/students/user-student-a1/consent`, { scope: 'assessment_processing', granted: true });
  await g1.post(`${BASE}/students/user-student-a1/consent`, { scope: 'assessment_processing', granted: true });
  const s = await startSession(a1, 'interest_exploratory');
  await answerAll(a1, s.body.session_id, 'interest_exploratory', (it) => (it.construct === 'RIASEC_S' ? undefined : 3 + (it.construct.endsWith('R') ? 2 : 0)), { ack: true });
  const run = await latestRun(a1, 'user-student-a1');
  assert.ok(run.output.items.every((i) => i.interest_fit.status === 'insufficient_data' && i.interest_fit.value === null && i.rank_if_available === null));
  assert.ok(run.output.items.every((i) => i.missing_inputs.includes('riasec:S')));
  assert.ok(run.output.items.every((i) => i.admission_status.eligibility !== undefined), 'eligibility is still evaluated independently');
});

test('advisor: explains deterministic results with sources, never authoritative; refuses disallowed purposes', async () => {
  const a2 = await app.as(A2);
  const r = await a2.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'results' });
  assert.equal(r.status, 200);
  assert.equal(r.body.authoritative, false);
  assert.equal(r.body.abstained, false);
  assert.ok(r.body.sources.score_run_ids.length === 1);
  assert.ok(r.body.blocks.some((b) => b.key === 'advisor.not_holland_code'));
  assert.ok(r.body.blocks.some((b) => b.key === 'advisor.low_interest_not_inability'));
  assert.equal((await a2.post(`${BASE}/advisor/tools/get_student_discovery_summary`, { student_id: A2, purpose: 'marketing' })).status, 400);
  const tool = await a2.post(`${BASE}/advisor/tools/get_student_discovery_summary`, { student_id: A2, purpose: 'career_guidance' });
  assert.deepEqual(Object.keys(tool.body).sort(), ['admission_source_snapshot_ids', 'approved_score_run_ids', 'recommendation_run_id', 'warning_flags']);
  assert.ok(tool.body.warning_flags.includes('aptitude_on_hold'));
  assert.equal(JSON.stringify(tool.body).includes('INT-'), false, 'no raw answers in the tool response');
});

test('AC-10 the advisor abstains and routes to a human when no verified source exists', async () => {
  await latestRun(await app.as(A2));
  const a2 = await app.as(A2);
  const conflicting = await a2.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'program', program_id: 'prog-demo-psy' });
  assert.equal(conflicting.body.abstained, true);
  assert.equal(conflicting.body.reason, 'source_conflicting');
  assert.equal(conflicting.body.route_to, 'catalog_review');
  assert.deepEqual(conflicting.body.blocks, []);
  const none = await a2.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'program', program_id: 'prog-demo-media' });
  assert.equal(none.body.abstained, true);
  assert.equal(none.body.reason, 'source_none');

  // the advisor needs its own consent scope: B1 never granted advisor_explanation
  const b1 = await app.as('user-student-b1');
  const denied = await b1.post(`${BASE}/students/user-student-b1/advisor/explain`, { topic: 'results' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, 'consent_scope_inactive');

  // a student with consent but no sealed results gets an abstention, not an invented explanation
  const a1 = await app.as('user-student-a1');
  await a1.post(`${BASE}/students/user-student-a1/consent`, { scope: 'advisor_explanation', granted: true });
  for (const run of Object.values(app.store.db.score_runs).filter((r) => r.student_id === 'user-student-a1')) delete app.store.db.score_runs[run.id];
  const empty = await a1.post(`${BASE}/students/user-student-a1/advisor/explain`, { topic: 'results' });
  assert.equal(empty.body.abstained, true);
  assert.equal(empty.body.reason, 'no_verified_source');
  assert.equal(empty.body.route_to, 'counselor');

  const ok = await a2.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'program', program_id: 'prog-demo-cs' });
  assert.equal(ok.body.abstained, false);
  assert.ok(ok.body.blocks.some((b) => b.key === 'advisor.no_acceptance_probability'));
  assert.equal((await a2.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'fortune' })).status, 400);
});

test('aspirations: a student can pin a major regardless of constraints; max 5', async () => {
  const a2 = await app.as(A2);
  assert.equal((await a2.put(`${BASE}/students/${A2}/aspirations/prog-demo-med`, { note: 'Dream' })).status, 200);
  assert.equal((await a2.put(`${BASE}/students/${A2}/aspirations/prog-demo-arch`, {})).status, 200);
  assert.equal((await a2.put(`${BASE}/students/${A2}/aspirations/prog-demo-gd`, {})).status, 200);
  assert.equal((await a2.put(`${BASE}/students/${A2}/aspirations/prog-demo-ba`, {})).status, 409);
  assert.equal((await a2.put(`${BASE}/students/${A2}/aspirations/nope`, {})).status, 404);
  assert.equal((await a2.del(`${BASE}/students/${A2}/aspirations/prog-demo-gd`)).body.removed, true);
});
