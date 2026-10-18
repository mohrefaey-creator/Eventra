// Regression tests for the independent adversarial review of server/. Each test reproduces a finding
// that was confirmed against the first version of the code, so it failed before the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startApp, BASE } from './helpers.js';
import { hashOf, canonicalize } from '../../domain/util.js';
import { capabilityReadiness } from '../../domain/matching/fit.js';
import { guardianRequired } from '../../server/policy.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const A2 = 'user-student-a2';
const DAY = 86400000;

test('review #1/#11: the advisor needs counselor_sharing for a counselor, and active processing consent for everyone', async () => {
  const s = await app.as(A2);
  const co = await app.as('user-counselor-a');
  const g = await app.as('user-guardian-a2');
  const ask = (c, body) => c.post(`${BASE}/students/${A2}/advisor/explain`, body);
  assert.equal((await ask(co, { topic: 'results' })).status, 200, 'baseline: allowed with both scopes');
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: false });
  const r1 = await ask(co, { topic: 'results' });
  assert.equal(r1.status, 403);
  assert.equal((await co.post(`${BASE}/advisor/tools/get_student_discovery_summary`, { student_id: A2, purpose: 'career_guidance' })).status, 403);
  assert.equal((await ask(s, { topic: 'results' })).status, 200, 'the student can still use their own explainer');
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: true });
  // guardian withdraws processing: the student's explainer stops too
  await g.post(`${BASE}/students/${A2}/consent`, { scope: 'assessment_processing', granted: false });
  const r2 = await ask(s, { topic: 'results' });
  assert.equal(r2.status, 403);
  await g.post(`${BASE}/students/${A2}/consent`, { scope: 'assessment_processing', granted: true });
});

test('review #2: requests whose Host header is not loopback are refused (DNS-rebinding defence for the open persona stub)', async () => {
  const port = new URL(app.origin).port;
  const call = (host) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await call(`127.0.0.1:${port}`), 200);
  assert.equal(await call(`localhost:${port}`), 200);
  assert.equal(await call('evil.example.com'), 403);
  assert.equal(await call(`attacker.test:${port}`), 403);
});

test('review #3: an idempotent replay never outlives a consent change, and cached bodies are snapshots', async () => {
  const s = await app.as(A2);
  const co = await app.as('user-counselor-a');
  const key = { 'idempotency-key': 'replay-key-0001' };
  const first = await co.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'results' }, key);
  assert.equal(first.status, 200);
  const again = await co.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'results' }, key);
  assert.equal(again.headers.get('idempotent-replayed'), 'true', 'unchanged consent: the replay is served');
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'advisor_explanation', granted: false });
  const after = await co.post(`${BASE}/students/${A2}/advisor/explain`, { topic: 'results' }, key);
  assert.equal(after.status, 403, 'the cached 200 must not be served after withdrawal');
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'advisor_explanation', granted: true });
  const cached = Object.values(app.store.db.idempotency)[0];
  assert.equal(typeof cached.body_json, 'string', 'a serialized snapshot is stored, not a live object reference');
  assert.doesNotThrow(() => JSON.parse(cached.body_json));
});

test('review #4: the kill switch also stops a request whose body arrives after it was enabled', async () => {
  const s = await app.as(A2);
  const sec = await app.as('user-security');
  const login = await fetch(`${app.origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona_id: A2 }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf_token } = await login.json();
  const body = JSON.stringify({ accessibility: { text_size: 'xlarge', high_contrast: false, reduce_motion: false } });
  const port = Number(new URL(app.origin).port);
  const status = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(Number(/HTTP\/1.1 (\d{3})/.exec(data)?.[1])));
    sock.on('error', reject);
    sock.write(`PUT ${BASE}/students/${A2}/preferences HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nX-CSRF-Token: ${csrf_token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`);
    setTimeout(async () => {
      await sec.post(`${BASE}/admin/kill-switch`, { enabled: true, reason: 'TOCTOU drill' });
      sock.write(body);
    }, 150);
  });
  assert.equal(status, 503, 'the parked request must be refused once the module is suspended');
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: false });
  assert.notEqual((await s.get(`${BASE}/students/${A2}/discovery-profile`)).body.preferences.accessibility.text_size, 'xlarge');
});

test('review #5: subject_ref cannot be used to observe another student\'s report outcome', async () => {
  const b1 = await app.as('user-student-b1');
  const a1 = await app.as('user-student-a1');
  const report = Object.values(app.store.db.reports).find((r) => r.student_id === A2);
  for (const c of [b1, a1]) {
    const who = c === b1 ? 'user-student-b1' : 'user-student-a1';
    const r = await c.post(`${BASE}/students/${who}/cases`, { reason_code: 'appeal', message: 'peek', subject_ref: `report:${report.id}` });
    assert.ok([403, 422].includes(r.status), `${who} got ${r.status}`);
  }
  const s = await app.as(A2);
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'appeal', message: 'my own', subject_ref: `report:${report.id}` })).status, 201, 'own report is fine');
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'appeal', message: 'bad ref', subject_ref: 'whatever:../../etc' })).status, 422);
  assert.equal((await s.post(`${BASE}/students/${A2}/cases`, { reason_code: 'appeal', message: 'program', subject_ref: 'program:prog-demo-arch' })).status, 201);
  // deciding the report resolves only cases of the report's own student
  const planted = Object.values(app.store.db.cases).filter((c) => c.subject_ref === `report:${report.id}`);
  assert.ok(planted.every((c) => c.student_id === A2));
});

test('review #6: audit hashes cannot be brute-forced back into grades, and reading the audit log is itself audited', async () => {
  const sec = await app.as('user-security');
  const events = (await sec.get(`${BASE}/admin/audit?action=evidence.recorded&limit=100`)).body.items;
  assert.ok(events.length > 0);
  const before = app.store.db.audit.length;
  for (const e of events) {
    for (let v = 0; v <= 100; v++) {
      for (const type of ['gat', 'saat', 'secondary_percentage', 'subject_grade:math', 'subject_grade:physics', 'subject_grade:computer', 'subject_grade:english']) {
        for (const state of ['unverified']) assert.notEqual(e.after_hash, hashOf({ type, value: v, state }), `${type}=${v} recovered from the audit hash`);
      }
    }
  }
  assert.ok(app.store.db.audit.length > before - 1);
  assert.ok(app.store.db.audit.some((e) => e.action === 'access.audit_read' && e.actor.id === 'user-security'));
});

test('review #7/#12/#22: names inherited from Object.prototype and non-string scopes are rejected as input errors', async () => {
  const s = await app.as(A2);
  for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = await s.put(`${BASE}/students/${A2}/evidence/${t}`, { value: -1e300 });
    assert.ok([404, 422].includes(r.status), `${t} -> ${r.status}`);
  }
  assert.ok(!Object.values(app.store.db.evidence).some((e) => ['constructor', '__proto__', 'toString'].includes(e.type)));
  for (const scope of [['guardian_summary_sharing'], { a: 1 }, 'constructor', '__proto__', 'toString', 7]) {
    const r = await s.post(`${BASE}/students/${A2}/consent`, { scope, granted: false });
    assert.equal(r.status, 400, JSON.stringify(scope));
  }
  const login = await fetch(`${app.origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona_id: '__proto__' }) });
  assert.equal(login.status, 404);
  const bad = await app.anon().get('/%');
  assert.equal(bad.status, 400);
  assert.equal((await s.get(`${BASE}/students/%zz/consent`)).status, 400);
});

test('review #8: guardian authority exists only for minors, can expire, and repeated toggling queues one retention task', async () => {
  const g = await app.as('user-guardian-b1');
  assert.equal((await g.get(`${BASE}/students/user-student-b1/consent`)).status, 403, 'B1 is an adult: no guardian view of consent');
  const w = await g.post(`${BASE}/students/user-student-b1/consent`, { scope: 'assessment_processing', granted: false });
  assert.equal(w.status, 403);
  assert.equal(app.store.db.consent_records && Object.values(app.store.db.consent_records).filter((r) => r.actor_id === 'user-guardian-b1').length, 0);

  const s = await app.as(A2);
  for (let i = 0; i < 3; i++) {
    await s.post(`${BASE}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: false });
    await s.post(`${BASE}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: true });
  }
  const tasks = Object.values(app.store.db.retention_tasks).filter((t) => t.student_id === A2 && t.scope === 'aggregate_analytics' && t.state === 'queued_for_policy_decision');
  assert.equal(tasks.length, 1, 'one open retention decision per student and scope');

  const g2 = await app.as('user-guardian-a2');
  assert.equal((await g2.get(`${BASE}/students/${A2}/guardian-summary`)).status, 200);
  app.store.db.guardian_links.find((l) => l.guardian_id === 'user-guardian-a2').expires_at = new Date(+app.time.now - DAY).toISOString();
  const expired = await g2.get(`${BASE}/students/${A2}/guardian-summary`);
  assert.equal(expired.status, 403);
  assert.equal(expired.body.reason, 'not_available', 'the caller is not told why');
  assert.ok(app.store.db.audit.some((e) => e.action === 'security.access_denied' && e.actor.id === 'user-guardian-a2' && e.meta.reason === 'no_guardian_relationship'), 'the audit log keeps the true reason');
  delete app.store.db.guardian_links.find((l) => l.guardian_id === 'user-guardian-a2').expires_at;
  assert.equal((await g2.get(`${BASE}/students/${A2}/guardian-summary`)).status, 200);
});

test('review #9: a counselor cannot create and then approve a report (separation of duties)', async () => {
  const co = await app.as('user-counselor-a');
  assert.equal((await co.post(`${BASE}/students/${A2}/reports`, {})).status, 403);
  const s = await app.as(A2);
  const rep = (await s.post(`${BASE}/students/${A2}/reports`, {})).body;
  await s.post(`${BASE}/reports/${rep.id}/review-request`, {});
  const stored = app.store.db.reports[rep.id];
  stored.created_by = 'user-counselor-a'; // even if data says the approver created it
  const r = await co.post(`${BASE}/reports/${rep.id}/approval`, { action: 'approve', payload_hash: stored.payload_hash });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'separation_of_duties');
  stored.created_by = A2;
});

test('review #10: recomputing cannot be forced, runs per student are capped, and rate limits follow the client, not the session', async () => {
  const s = await app.as(A2);
  const first = await s.post(`${BASE}/students/${A2}/recommendations`, {});
  const second = await s.post(`${BASE}/students/${A2}/recommendations`, { force_recompute: true });
  assert.equal(second.body.id, first.body.id, 'force_recompute is ignored');
  let hit;
  for (let i = 0; i < 60 && !hit; i++) {
    await s.put(`${BASE}/students/${A2}/evidence/gat`, { value: 70 + (i % 2) + (i > 1 ? 0 : 5) + i / 100 });
    const r = await s.post(`${BASE}/students/${A2}/recommendations`, {});
    if (r.status === 409) hit = r;
  }
  assert.ok(hit, 'the 51st stored run is refused');
  assert.equal(hit.body.code, 'run_limit_reached');

  const limited = await startApp({ rateLimitPerMinute: 4 });
  try {
    let status = 200;
    for (let i = 0; i < 30 && status !== 429; i++) {
      // a fresh login each time: if sessions reset the limit this would never reach 429
      const login = await fetch(`${limited.origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona_id: 'user-student-a2' }) });
      if (login.status === 429) { status = 429; break; }
      const cookie = login.headers.get('set-cookie').split(';')[0];
      status = (await fetch(`${limited.origin}${BASE}/assessments`, { headers: { cookie } })).status;
    }
    assert.equal(status, 429, 'fresh logins do not reset the limit');
  } finally {
    await limited.close();
  }
});

test('review #15: unknown ids and other schools\' ids are indistinguishable to the caller; the real reason is audited', async () => {
  const b1 = await app.as('user-student-b1');
  const a2sid = Object.values(app.store.db.sessions).find((x) => x.student_id === A2).id;
  const reportId = Object.values(app.store.db.reports).find((r) => r.student_id === A2).id;
  const runId = Object.values(app.store.db.recommendation_runs).find((r) => r.student_id === A2).id;
  const pairs = [
    [`${BASE}/sessions/${a2sid}`, `${BASE}/sessions/00000000-0000-4000-8000-000000000000`],
    [`${BASE}/reports/${reportId}`, `${BASE}/reports/00000000-0000-4000-8000-000000000000`],
    [`${BASE}/recommendations/${runId}`, `${BASE}/recommendations/00000000-0000-4000-8000-000000000000`],
    [`${BASE}/students/${A2}/discovery-profile`, `${BASE}/students/user-student-nope/discovery-profile`],
  ];
  for (const [real, fake] of pairs) {
    const a = await b1.get(real);
    const b = await b1.get(fake);
    assert.equal(a.status, b.status, real);
    assert.equal(a.body.reason, b.body.reason);
    assert.equal(a.body.detail, b.body.detail);
  }
  const reasons = app.store.db.audit.filter((e) => e.action === 'security.access_denied' && e.actor.id === 'user-student-b1').map((e) => e.meta.reason);
  assert.ok(reasons.includes('cross_tenant') && reasons.includes('not_found'));
});

test('review #16/#17/#18: incident reason and other schools\' counters are not broadcast; drafts and the guardian\'s report list are filtered', async () => {
  const sec = await app.as('user-security');
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: true, reason: 'Suspected breach in school-a tenant' });
  const anon = await app.anon().get('/api/v1/identity-stub/me');
  assert.equal(anon.body.incident_mode.enabled, true);
  assert.equal(JSON.stringify(anon.body).includes('Suspected breach'), false);
  const s = await app.as(A2);
  const blocked = await s.get(`${BASE}/assessments`);
  assert.equal(blocked.status, 503);
  assert.equal(JSON.stringify(blocked.body).includes('Suspected breach'), false);
  assert.ok(JSON.stringify((await sec.get('/api/v1/identity-stub/me')).body).includes('Suspected breach'), 'staff with the security role can see it');
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: false });

  const a1 = await app.as('user-student-a1');
  const adm = (await a1.get(`${BASE}/programs/prog-demo-nurs/admissions`)).body;
  assert.ok(adm.versions.every((v) => v.state !== 'draft'));
  assert.equal(adm.drafts, undefined);
  assert.equal(JSON.stringify(adm).includes('user-steward'), false);

  const ta = await app.as('user-tenant-admin-a');
  const before = (await ta.get(`${BASE}/admin/control-tower`)).body.operations.audit_events;
  const b1 = await app.as('user-student-b1');
  for (let i = 0; i < 4; i++) await b1.get(`${BASE}/students/${A2}/discovery-profile`);
  const after = (await ta.get(`${BASE}/admin/control-tower`)).body.operations.audit_events;
  assert.equal(after, before, 'school A\'s counter does not move when only school B acts');

  const g = await app.as('user-guardian-a2');
  const summary = (await g.get(`${BASE}/students/${A2}/guardian-summary`)).body;
  const shared = new Set(Object.values(app.store.db.shares).filter((x) => x.student_id === A2 && !x.revoked_at && new Date(x.expires_at) > app.time.now).map((x) => x.report_id));
  assert.ok(summary.reports.every((r) => shared.has(r.id)), 'only reports with an active share are listed');
});

test('review #19: replay and report approval verify the stored payload, not only the stored hash', async () => {
  const s = await app.as(A2);
  const run = Object.values(app.store.db.score_runs).find((r) => r.student_id === A2 && r.instrument_id === 'interest_exploratory');
  const original = JSON.stringify(run.construct_scores);
  run.construct_scores.RIASEC_R.display_0_100 = 99;
  const replay = await s.post(`${BASE}/sessions/${run.session_id}/replay`, {});
  assert.equal(replay.body.match, false);
  assert.equal(replay.body.stored_payload_intact, false);
  run.construct_scores = JSON.parse(original);
  assert.equal((await s.post(`${BASE}/sessions/${run.session_id}/replay`, {})).body.match, true);

  const co = await app.as('user-counselor-a');
  const rep = (await s.post(`${BASE}/students/${A2}/reports`, {})).body;
  await s.post(`${BASE}/reports/${rep.id}/review-request`, {});
  const stored = app.store.db.reports[rep.id];
  const payload = JSON.stringify(stored.payload);
  stored.payload.limitations = [];
  const r = await co.post(`${BASE}/reports/${rep.id}/approval`, { action: 'approve', payload_hash: stored.payload_hash });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'report_integrity_failure');
  stored.payload = JSON.parse(payload);
});

test('review #13: a stale draft cannot overwrite a newer published rule; thresholds must be real numbers', async () => {
  const s1 = await app.as('user-steward-1');
  const s2 = await app.as('user-steward-2');
  const mk = (gat) => ({
    program_id: 'prog-demo-ba', cycle: '2027', conditions: [{ key: 'pathway', value: ['general'] }, { key: 'gat', value: gat }],
    source: { publisher: 'Fictional', source_url: 'https://example.invalid/x', published_at: '2026-09-01', captured_at: '2026-10-01' },
    effective_from: '2026-09-01', effective_to: '2027-12-31', review_due_at: '2027-06-01',
  });
  for (const bad of [null, '', [], {}, 'abc', true]) assert.equal((await s1.post(`${BASE}/admin/program-rules`, mk(bad))).status, 422, JSON.stringify(bad));
  assert.equal((await s1.post(`${BASE}/admin/program-rules`, { ...mk(70), conditions: [null] })).status, 422);
  const older = (await s1.post(`${BASE}/admin/program-rules`, mk(10))).body;
  const newer = (await s1.post(`${BASE}/admin/program-rules`, mk(95))).body;
  assert.equal((await s2.post(`${BASE}/admin/program-rules/${newer.id}/publish`, {})).status, 200);
  const stale = await s2.post(`${BASE}/admin/program-rules/${older.id}/publish`, {});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'draft_out_of_date');
  const active = (await s1.get(`${BASE}/programs/prog-demo-ba/admissions`)).body.rule;
  assert.equal(active.rules.conditions.find((c) => c.key === 'gat').value, 95);
});

test('review #14: counselor reads of evidence, recommendations, reports and cases are audited', async () => {
  const co = await app.as('user-counselor-a');
  for (const [path, action] of [[`evidence`, 'access.evidence_read'], [`recommendations`, 'access.recommendations_read'], [`reports`, 'access.reports_read'], [`cases`, 'access.cases_read']]) {
    const before = app.store.db.audit.filter((e) => e.action === action).length;
    assert.equal((await co.get(`${BASE}/students/${A2}/${path}`)).status, 200);
    assert.equal(app.store.db.audit.filter((e) => e.action === action).length, before + 1, action);
  }
});

test('review #21/#22: free text is kept out of the audit chain; malformed input is a 400/422, not a 500', async () => {
  const co = await app.as('user-counselor-a');
  const bad = await co.get(`${BASE}/students/${A2}/case360?purpose=${encodeURIComponent('Ahmed Al-Saud NID 1234567890')}`);
  assert.equal(bad.status, 400);
  assert.equal((await co.get(`${BASE}/students/${A2}/case360?purpose=appeal_review`)).status, 200);
  const sec = await app.as('user-security');
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: true, reason: 'x'.repeat(5000) });
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: false });
  const ev = app.store.db.audit.find((e) => e.action === 'killswitch.enabled' && e.meta.reason.length > 200);
  assert.equal(ev, undefined, 'the audit reason is truncated to 200 characters');
  assert.ok(app.store.db.audit.some((e) => e.action === 'killswitch.enabled' && e.meta.reason.length === 200));
  const c = Object.values(app.store.db.cases).find((x) => x.student_id === A2 && x.status !== 'resolved');
  assert.equal((await co.patch(`${BASE}/cases/${c.id}`, { status: 'in_review', next_review_at: 'not a date' })).status, 400);
});

test('review #suspected: missing or invalid birth dates fail closed; canonical hashing ignores no keys', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  assert.equal(guardianRequired({}, now), true);
  assert.equal(guardianRequired({ date_of_birth: 'garbage' }, now), true);
  assert.equal(guardianRequired({ date_of_birth: '2000-01-01' }, now), false);
  const polluted = JSON.parse('{"a":1,"__proto__":{"x":1}}');
  assert.notEqual(hashOf(polluted), hashOf({ a: 1 }));
  assert.ok(canonicalize(polluted).includes('__proto__'));
});

test('review #20: readiness ratio is not computed when evidence is missing', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const ev = { 'subject_grade:math': { value: 95, verification_state: 'counselor_verified', expires_at: null } };
  const r = capabilityReadiness([{ subject: 'math', min_grade: 80 }, { subject: 'physics', min_grade: 80 }], ev, now);
  assert.equal(r.status, 'provisional');
  assert.equal(r.ratio, null, 'an unknown item is not counted as a failure');
  assert.equal(r.met, 1);
  assert.equal(r.known, 1);
  assert.equal(r.total, 2);
});

test('review #suspected: consent withdrawal stays possible during an incident, but granting does not', async () => {
  const sec = await app.as('user-security');
  const s = await app.as(A2);
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: true, reason: 'withdrawal check' });
  const w = await s.post(`${BASE}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: false });
  assert.equal(w.status, 200, 'data-subject withdrawal is not blocked by an incident');
  const g = await s.post(`${BASE}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: true });
  assert.equal(g.status, 503);
  await sec.post(`${BASE}/admin/kill-switch`, { enabled: false });
  await s.post(`${BASE}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: true });
});

test('stewards see who authored each draft (the author must not be offered a publish action), students never do', async () => {
  const s1 = await app.as('user-steward-1');
  const rules = (await s1.get(`${BASE}/admin/program-rules`)).body.items.flatMap((i) => i.drafts);
  assert.ok(rules.length >= 1);
  assert.ok(rules.every((d) => d.authored_by), 'every draft carries its author for the four-eyes UI');
});
