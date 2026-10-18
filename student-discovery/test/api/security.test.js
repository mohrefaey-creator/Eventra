import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, BASE, ivid } from './helpers.js';
import { verifyAuditChain } from '../../server/audit.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

test('static app is served with strict security headers; traversal is refused', async () => {
  const res = await fetch(`${app.origin}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/../server/store.js', '/%2e%2e/server/store.js', '/..%2fserver%2fstore.js', '/js/../../package.json']) {
    const r = await fetch(`${app.origin}${p}`);
    assert.equal(r.status, 404, p);
  }
  const api = await fetch(`${app.origin}/api/health`);
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('unauthenticated requests are rejected with RFC 7807 problems', async () => {
  const r = await app.anon().get(`${BASE}/students/user-student-a2/discovery-profile`);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('content-type'), 'application/problem+json');
  assert.equal(r.body.code, 'unauthenticated');
  assert.ok(r.body.request_id);
});

test('login sets an HttpOnly SameSite=Strict cookie; mutating calls need the CSRF token', async () => {
  const res = await fetch(`${app.origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona_id: 'user-student-a2' }) });
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const cookie = sc.split(';')[0];
  const noCsrf = await fetch(`${app.origin}${BASE}/students/user-student-a2/consent`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'counselor_sharing', granted: false }) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).reason, 'csrf');
});

test('body must be JSON, size-limited, and syntactically valid', async () => {
  const login = await fetch(`${app.origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona_id: 'user-student-a2' }) });
  const { csrf_token } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const form = await fetch(`${app.origin}${BASE}/sessions`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf_token, 'content-type': 'text/plain' }, body: 'instrument_version_id=x' });
  assert.equal(form.status, 415);
  const malformed = await fetch(`${app.origin}${BASE}/sessions`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf_token, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'invalid_json');
  const bad = await fetch(`${app.origin}${BASE}/sessions`, { method: 'POST', headers: { cookie: 'sd_session=' + 'a'.repeat(64), 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 401, 'authentication is checked before the body is parsed');
  const me = await app.as('user-student-a2');
  const r = await me.raw('POST', `${BASE}/sessions`, { instrument_version_id: 'x'.repeat(100000) });
  assert.equal(r.status, 413);
});

test('AC-02 cross-tenant access is denied and recorded as a security event', async () => {
  const before = app.store.db.audit.filter((e) => e.action === 'security.access_denied').length;
  const b1 = await app.as('user-student-b1');
  const a2sessionId = Object.values(app.store.db.sessions).find((s) => s.student_id === 'user-student-a2').id;
  for (const path of [`${BASE}/sessions/${a2sessionId}`, `${BASE}/sessions/${a2sessionId}/responses`, `${BASE}/students/user-student-a2/discovery-profile`, `${BASE}/students/user-student-a2/evidence`]) {
    const r = await b1.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.reason, 'not_available', 'the caller cannot tell "other school" from "does not exist"');
  }
  const cB = await app.as('user-counselor-b');
  assert.equal((await cB.get(`${BASE}/students/user-student-a2/case360`)).status, 403);
  const cA = await app.as('user-counselor-a');
  assert.equal((await cA.get(`${BASE}/students/user-student-b1/case360`)).status, 403);
  const events = app.store.db.audit.filter((e) => e.action === 'security.access_denied');
  assert.ok(events.length >= before + 6);
  assert.ok(events.some((e) => e.meta.reason === 'cross_tenant' && e.actor.id === 'user-student-b1' && e.subject_ref === 'student:user-student-a2'));
});

test('a student cannot read or write another student in the same school', async () => {
  const a1 = await app.as('user-student-a1');
  const r = await a1.get(`${BASE}/students/user-student-a2/discovery-profile`);
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'not_available');
  assert.ok(app.store.db.audit.some((e) => e.action === 'security.access_denied' && e.actor.id === 'user-student-a1' && e.meta.reason === 'not_self'), 'the audit log keeps the true reason');
  assert.equal((await a1.put(`${BASE}/students/user-student-a2/evidence/gat`, { value: 99 })).status, 403);
});

test('a counselor can only reach assigned students; platform roles never see student content', async () => {
  const sec = await app.as('user-security');
  assert.equal((await sec.get(`${BASE}/students/user-student-a2/discovery-profile`)).status, 403);
  const steward = await app.as('user-steward-1');
  assert.equal((await steward.get(`${BASE}/students/user-student-a2/discovery-profile`)).status, 403);
  const ta = await app.as('user-tenant-admin-a');
  assert.equal((await ta.get(`${BASE}/students/user-student-a2/discovery-profile`)).status, 403);
  assert.equal((await ta.get(`${BASE}/students/user-student-a2/case360`)).status, 403);
  const student = await app.as('user-student-a2');
  assert.equal((await student.get(`${BASE}/admin/audit`)).status, 403);
  assert.equal((await student.get(`${BASE}/admin/instruments`)).status, 403);
  assert.equal((await student.post(`${BASE}/admin/kill-switch`, { enabled: true, reason: 'nope nope' })).status, 403);
});

test('idempotency-key: replay returns the stored response; reuse with a different body is refused', async () => {
  const c = await app.as('user-student-a2');
  const k = { 'idempotency-key': 'idem-key-0001' };
  const body = { scope: 'aggregate_analytics', granted: true };
  const first = await c.post(`${BASE}/students/user-student-a2/consent`, body, k);
  const again = await c.post(`${BASE}/students/user-student-a2/consent`, body, k);
  assert.equal(again.status, first.status);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  const clash = await c.post(`${BASE}/students/user-student-a2/consent`, { scope: 'aggregate_analytics', granted: false }, k);
  assert.equal(clash.status, 422);
  assert.equal(clash.body.code, 'idempotency_key_reuse');
});

test('NFR-08 audit chain verifies; tampering with any event is detected', async () => {
  assert.equal(verifyAuditChain(app.store.db).ok, true);
  const sec = await app.as('user-security');
  const r = await sec.get(`${BASE}/admin/audit?limit=5`);
  assert.equal(r.status, 200);
  assert.equal(r.body.chain.ok, true);
  const copy = structuredClone(app.store.db);
  copy.audit[3].actor.id = 'someone-else';
  assert.equal(verifyAuditChain(copy).ok, false);
  assert.equal(verifyAuditChain(copy).broken_at_seq, 4);
  const del = structuredClone(app.store.db);
  del.audit.splice(5, 1);
  assert.equal(verifyAuditChain(del).ok, false);
});

test('audit events never contain answers, evidence values or note text (no PII in the log)', async () => {
  const dump = JSON.stringify(app.store.db.audit);
  assert.doesNotMatch(dump, /Wants to explore both computing/);
  assert.doesNotMatch(dump, /Interested in software/);
  assert.doesNotMatch(dump, /Demo Student A2/);
});

test('NFR-08 every consequential action writes an audit event', async () => {
  const db = app.store.db;
  const actions = new Set(db.audit.map((e) => e.action));
  for (const a of ['consent.granted', 'session.started', 'session.submitted', 'score.computed', 'evidence.recorded', 'evidence.verified', 'recommendation.generated', 'case.opened', 'report.generated', 'report.review_requested', 'rule.draft_created', 'note.added', 'aspiration.pinned']) {
    assert.ok(actions.has(a), `missing audit action ${a}`);
  }
});

test('rate limiting returns 429 with a problem body', async () => {
  const limited = await startApp({ rateLimitPerMinute: 5 });
  try {
    const c = await limited.as('user-student-a2');
    let last;
    for (let i = 0; i < 8; i++) last = await c.get(`${BASE}/assessments`);
    assert.equal(last.status, 429);
    assert.equal(last.body.code, 'rate_limited');
  } finally {
    await limited.close();
  }
});

test('kill switch: student operations get 503, governance stays reachable, recovery works', async () => {
  const sec = await app.as('user-security');
  const student = await app.as('user-student-a2');
  const on = await sec.post(`${BASE}/admin/kill-switch`, { enabled: true, reason: 'Incident drill: stale source' });
  assert.equal(on.status, 200);
  const blocked = await student.get(`${BASE}/assessments`);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, 'module_suspended');
  assert.equal((await student.post(`${BASE}/students/user-student-a2/consent`, { scope: 'counselor_sharing', granted: true })).status, 503);
  assert.equal((await sec.get(`${BASE}/admin/control-tower`)).status, 200);
  assert.equal((await fetch(`${app.origin}/api/health`)).status, 200);
  assert.equal((await sec.post(`${BASE}/admin/kill-switch`, { enabled: false })).status, 200);
  assert.equal((await student.get(`${BASE}/assessments`)).status, 200);
  const actions = app.store.db.audit.map((e) => e.action);
  assert.ok(actions.includes('killswitch.enabled') && actions.includes('killswitch.disabled'));
});

test('failed requests roll back every partial write (all-or-nothing)', async () => {
  assert.equal(Object.values(app.store.db.consent_records).filter((r) => r.subject_id === 'user-student-a1').length, 0, 'precondition: A1 has no consent');
  const c = await app.as('user-student-a1');
  const before = JSON.stringify({ s: app.store.db.sessions, c: app.store.db.consent_records, a: app.store.db.audit.length });
  const r = await c.post(`${BASE}/sessions`, { instrument_version_id: ivid('interest_exploratory'), locale: 'en', idempotency_key: 'rollback-test-1' });
  assert.equal(r.status, 403);
  assert.equal(JSON.stringify({ s: app.store.db.sessions, c: app.store.db.consent_records, a: app.store.db.audit.length - 1 }), before, 'only the post-rollback denial audit event is added');
});
