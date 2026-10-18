// Contract tests: docs/api/openapi.yaml and docs/api/events.schema.json against the running server.
//  1. Structure: every registered route is described (and nothing else), with matching security.
//  2. Behaviour: one scenario drives every operation through the real HTTP API; every request the server accepted
//     must satisfy the spec's request schema and every response (success or problem) must satisfy its response schema.
//  3. Events: every outbox event validates against its payload schema, and the schema lists exactly the events the code emits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { startApp, BASE, ivid } from '../api/helpers.js';
import { findChromium } from '../../server/pdf.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = parse(fs.readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8'));
const eventsSchema = JSON.parse(fs.readFileSync(path.join(root, 'docs/api/events.schema.json'), 'utf8'));
const ID = '/api/v1/identity-stub';
const A1 = 'user-student-a1';
const A2 = 'user-student-a2';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(spec, 'openapi');
ajv.addSchema(eventsSchema, 'events');
const validators = new Map();
const validatorFor = (ref) => {
  if (!validators.has(ref)) validators.set(ref, ajv.compile({ $ref: ref }));
  return validators.get(ref);
};
const esc = (s) => s.replaceAll('~', '~0').replaceAll('/', '~1');

// ---------------------------------------------------------------- the spec's operations
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const OPS = [];
for (const [tpl, item] of Object.entries(spec.paths)) {
  for (const m of METHODS) {
    if (!item[m]) continue;
    OPS.push({ id: item[m].operationId, method: m.toUpperCase(), tpl, op: item[m], item, re: new RegExp(`^${tpl.replace(/\{[^}]+\}/g, '[^/]+')}$`) });
  }
}
const findOp = (method, pathname) => OPS.find((o) => o.method === method && o.re.test(pathname));
const toTemplate = (pattern) => pattern.replace(/:([a-zA-Z]+)/g, '{$1}');

// ================================================================ 1. structure
test('the spec is well formed: unique operation ids, summaries, authorization notes, declared path parameters', () => {
  assert.equal(spec.openapi, '3.1.0');
  const ids = OPS.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, 'operationId must be unique');
  for (const o of OPS) {
    assert.ok(o.id, `${o.method} ${o.tpl}: operationId`);
    assert.ok(o.op.summary, `${o.id}: summary`);
    assert.ok(o.op.tags?.length, `${o.id}: tags`);
    assert.ok(o.op.responses?.default, `${o.id}: a default (problem) response`);
    assert.ok(typeof o.op['x-authorization'] === 'string', `${o.id}: x-authorization says who may call it`);
    const declared = new Set([...(o.item.parameters ?? []), ...(o.op.parameters ?? [])].map((p) => (p.$ref ? spec.components.parameters[p.$ref.split('/').pop()].name : p.name)));
    for (const [, name] of o.tpl.matchAll(/\{([^}]+)\}/g)) assert.ok(declared.has(name), `${o.id}: path parameter {${name}} is declared`);
  }
});

test('every registered route is described, and every described operation exists (documentation cannot drift)', async () => {
  const app = await startApp();
  try {
    const routes = app.router.list();
    const registered = routes.map((r) => `${r.method} ${toTemplate(r.pattern)}`).sort();
    const documented = OPS.map((o) => `${o.method} ${o.tpl}`).sort();
    assert.deepEqual(registered.filter((r) => !documented.includes(r)), [], 'routes missing from the spec');
    assert.deepEqual(documented.filter((d) => !registered.includes(d)), [], 'spec operations with no route');

    for (const r of routes) {
      const o = OPS.find((x) => x.method === r.method && x.tpl === toTemplate(r.pattern));
      const schemes = (o.op.security ?? []).flatMap((s) => Object.keys(s));
      if (r.opts.public) assert.deepEqual(o.op.security, [], `${o.id}: a public route declares no security`);
      else assert.ok(schemes.includes('sessionCookie'), `${o.id}: needs the session cookie`);
      const csrf = r.method !== 'GET' && !r.opts.noCsrf;
      assert.equal(schemes.includes('csrfToken'), csrf, `${o.id}: CSRF requirement matches the server (${csrf})`);
    }
  } finally {
    await app.close();
  }
});

test('events: the schema lists exactly the events the code emits, and the human API summary lists the same ones', () => {
  const emitted = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name));
      else if (f.name.endsWith('.js')) {
        // the first argument may be a conditional ('a' or 'b'), so take every string literal in it
        for (const call of fs.readFileSync(path.join(dir, f.name), 'utf8').matchAll(/\bemit\(ctx,\s*([^,]+),/g)) for (const lit of call[1].matchAll(/'([a-z_.]+)'/g)) emitted.add(lit[1]);
      }
    }
  };
  walk(path.join(root, 'server'));
  const defined = Object.keys(eventsSchema.$defs.events);
  assert.deepEqual([...emitted].sort(), defined.sort());
  assert.deepEqual([...eventsSchema.$defs.Envelope.properties.event_type.enum].sort(), defined.sort(), 'the envelope enum matches the payload schemas');
  const md = fs.readFileSync(path.join(root, 'docs/06_API.md'), 'utf8');
  const section = md.slice(md.indexOf('## Events (outbox)'));
  const listed = [...section.matchAll(/`((?:discovery|catalog)\.[a-z_.]+)`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(listed)].sort(), defined.sort(), 'docs/06_API.md event list');
});

// ================================================================ 2. behaviour
let app;
const log = [];
before(async () => {
  app = await startApp();
});
after(() => app.close());

/** Wrap a client so every call is recorded for validation. */
function recorded(c) {
  const rec = (method) => async (p, b, h) => {
    const r = method === 'GET' || method === 'DELETE' ? await c[method === 'GET' ? 'get' : 'del'](p, b) : await c[method.toLowerCase()](p, b, h);
    log.push({ method, path: p.split('?')[0], status: r.status, body: r.body, headers: r.headers, reqBody: method === 'GET' || method === 'DELETE' ? undefined : b });
    return r;
  };
  return { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), del: rec('DELETE') };
}
const as = async (persona) => recorded(await app.as(persona));
const anon = () => recorded(app.anon());
const ok = (r, ...statuses) => {
  assert.ok(statuses.includes(r.status), `expected ${statuses.join('/')} but got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

test('scenario: drive every operation through the real API', async () => {
  const D = BASE;
  const a = anon();
  ok(await a.get('/api/health'), 200);
  ok(await a.get(`${ID}/personas`), 200);
  ok(await a.get(`${ID}/me`), 200);
  ok(await a.get(`${D}/assessments`), 401);
  const login = await a.post(`${ID}/login`, { persona_id: 'user-student-a2' });
  ok(login, 200);
  ok(await a.post(`${ID}/login`, { persona_id: 'nobody' }), 404);
  ok(await a.post(`${ID}/logout`, {}), 200);

  const s = await as(A2);
  const co = await as('user-counselor-a');
  const co2 = await as('user-counselor-a2');
  const g = await as('user-guardian-a2');
  const ta = await as('user-tenant-admin-a');
  const sec = await as('user-security');
  const st1 = await as('user-steward-1');
  const st2 = await as('user-steward-2');
  const pl = await as('user-psych-1');

  // ---- student reads
  ok(await s.get(`${ID}/me`), 200);
  const mods = ok(await s.get(`${D}/assessments`), 200);
  ok(await s.get(`${D}/students/${A2}/assessments`), 200);
  const interest = mods.modules.find((m) => m.instrument_id === 'interest_exploratory');
  const sessionId = interest.last_session_id;
  const sess = ok(await s.get(`${D}/sessions/${sessionId}`), 200);
  ok(await s.get(`${D}/sessions/${sessionId}/score`), 200);
  ok(await s.post(`${D}/sessions/${sessionId}/replay`, {}), 200);
  ok(await s.get(`${D}/sessions/${sessionId}/responses`), 200);
  ok(await s.get(`${D}/students/${A2}/discovery-profile`), 200);
  ok(await s.get(`${D}/students/${A2}/consent`), 200);
  ok(await s.post(`${D}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: false }), 200);
  ok(await s.post(`${D}/students/${A2}/consent`, { scope: 'aggregate_analytics', granted: true }), 200);
  ok(await s.post(`${D}/students/${A2}/consent`, { scope: 'nonsense', granted: true }), 400);
  ok(await s.get(`${D}/students/${A2}/evidence`), 200);
  ok(await s.put(`${D}/students/${A2}/preferences`, { locale: 'en', accessibility: { text_size: 'large', high_contrast: false, reduce_motion: true } }), 200);
  ok(await s.put(`${D}/students/${A2}/aspirations/prog-demo-me`, { note: 'Curious about this.' }), 200);
  ok(await s.del(`${D}/students/${A2}/aspirations/prog-demo-me`), 200);
  ok(await s.get(`${D}/programs?limit=3&q=engineering`), 200);
  ok(await s.get(`${D}/programs/prog-demo-cs`), 200);
  ok(await s.get(`${D}/programs/prog-demo-cs/admissions?cycle=2027`), 200);

  // ---- recommendations: same inputs reuse the run (200); new evidence makes a new one (201)
  const reuse = ok(await s.post(`${D}/students/${A2}/recommendations`, {}), 200);
  assert.equal(reuse.reused, true);
  ok(await s.put(`${D}/students/${A2}/evidence/saat`, { value: 71 }), 200);
  ok(await s.post(`${D}/students/${A2}/recommendations`, {}), 201);
  const runs = ok(await s.get(`${D}/students/${A2}/recommendations`), 200);
  ok(await s.get(`${D}/recommendations/${runs[0].id}`), 200);

  // ---- counselor side
  ok(await co.get(`${D}/counselor/queue`), 200);
  ok(await co.get(`${D}/students/${A2}/case360?purpose=follow_up`), 200);
  ok(await co.get(`${D}/students/${A2}/case360?purpose=gossip`), 400);
  const ev = ok(await co.get(`${D}/students/${A2}/evidence`), 200);
  const [first, second] = Object.values(ev.latest).filter((e) => e.verification_state === 'unverified');
  ok(await co.post(`${D}/students/${A2}/evidence/${first.id}/verify`, {}), 422);
  ok(await co.post(`${D}/students/${A2}/evidence/${second.id}/verify`, { note: 'Saw the transcript (synthetic)' }), 200);
  ok(await co.post(`${D}/students/${A2}/notes`, { body: 'Follow up next week.', visibility: 'student' }), 201);
  ok(await co.get(`${D}/sessions/${sessionId}/responses`), 200);
  ok(await co.get(`${D}/sessions/${sessionId}/score`), 200);
  const score = ok(await s.get(`${D}/sessions/${sessionId}/score`), 200);
  ok(await co.post(`${D}/students/${A2}/overrides`, { score_run_id: score.score_run_id, text: 'Social interest looks under-reported.', reason: 'Interview supports this reading.', visibility: 'student' }), 201);
  ok(await s.get(`${D}/students/${A2}/cases`), 200);
  const opened = ok(await s.post(`${D}/students/${A2}/cases`, { reason_code: 'help_request' }), 201);
  ok(await s.post(`${D}/students/${A2}/counselor-review`, { reason_code: 'appeal', message: 'Why is Architecture not higher?', subject_ref: 'program:prog-demo-arch' }), 201);
  ok(await co.patch(`${D}/cases/${opened.id}`, { status: 'in_review' }), 200);
  ok(await co.patch(`${D}/cases/${opened.id}`, { status: 'resolved' }), 422);
  ok(await co.patch(`${D}/cases/${opened.id}`, { status: 'resolved', resolution: 'Explained the three axes.' }), 200);

  // ---- reports: the seeded one is in review; approve it, share it, export it
  const list = ok(await s.get(`${D}/students/${A2}/reports`), 200);
  const inReview = list.find((r) => r.status === 'review_requested');
  const draftView = ok(await co.get(`${D}/reports/${inReview.id}`), 200);
  assert.equal(draftView.watermark, 'DRAFT');
  ok(await s.get(`${D}/reports/${inReview.id}/pdf`), 409);
  ok(await s.get(`${D}/reports/${inReview.id}/pdf?locale=fr`), 400);
  ok(await co.post(`${D}/reports/${inReview.id}/approval`, { action: 'approve', payload_hash: '0'.repeat(64) }), 409);
  ok(await co.post(`${D}/reports/${inReview.id}/approval`, { action: 'approve', payload_hash: draftView.payload_hash, reason: 'Checked against the sealed results.' }), 200);
  const approved = ok(await s.get(`${D}/reports/${inReview.id}`), 200);
  assert.equal(approved.watermark, null);
  assert.ok(approved.approval);
  const share = ok(await s.post(`${D}/reports/${inReview.id}/shares`, { days: 7 }), 201);
  const viaShare = ok(await g.get(`${D}/reports/${inReview.id}`), 200);
  assert.ok(viaShare.share, 'a guardian sees the share');
  ok(await g.get(`${D}/students/${A2}/guardian-summary`), 200);
  ok(await g.get(`${D}/sessions/${sessionId}/responses`), 403);
  ok(await s.del(`${D}/shares/${share.id}`), 200);
  ok(await g.get(`${D}/reports/${inReview.id}`), 403);
  const pdf = await s.get(`${D}/reports/${inReview.id}/pdf?locale=en`);
  ok(pdf, findChromium() ? 200 : 501);
  // a changed payload gives a new draft, which can then be sent for review
  const fresh = ok(await s.post(`${D}/students/${A2}/reports`, {}), 201);
  ok(await s.post(`${D}/students/${A2}/reports`, {}), 200);
  ok(await s.post(`${D}/reports/${fresh.id}/review-request`, {}), 200);

  // ---- attempt lifecycle: new attempt, save, incomplete submit refused, acknowledged submit seals, repeat is a no-op
  const attempt = ok(await s.post(`${D}/sessions`, { instrument_version_id: ivid('interest_exploratory'), locale: 'en', idempotency_key: 'contract-attempt-1' }), 201);
  ok(await s.post(`${D}/sessions`, { instrument_version_id: ivid('interest_exploratory'), locale: 'en', idempotency_key: 'contract-attempt-1' }), 200);
  const open = ok(await s.get(`${D}/sessions/${attempt.session_id}`), 200);
  ok(await s.put(`${D}/sessions/${attempt.session_id}/responses/${open.items[0].item_id}`, { value: 4 }), 200);
  ok(await s.put(`${D}/sessions/${attempt.session_id}/responses/${open.items[1].item_id}`, { value: 99 }), 422);
  ok(await s.post(`${D}/sessions/${attempt.session_id}/submit`, {}), 422);
  ok(await s.post(`${D}/sessions/${attempt.session_id}/submit`, { acknowledge_incomplete: true }), 201);
  ok(await s.post(`${D}/sessions/${attempt.session_id}/submit`, {}), 200);
  assert.ok(sess.items.length > 0);

  // ---- advisor
  ok(await s.post(`${D}/advisor/tools/get_student_discovery_summary`, { student_id: A2, purpose: 'career_guidance' }), 200);
  ok(await s.post(`${D}/advisor/tools/get_student_discovery_summary`, { student_id: A2, purpose: 'marketing' }), 400);
  ok(await s.post(`${D}/students/${A2}/advisor/explain`, { topic: 'results' }), 200);
  ok(await s.post(`${D}/students/${A2}/advisor/explain`, { topic: 'missing_evidence' }), 200);
  ok(await s.post(`${D}/students/${A2}/advisor/explain`, { topic: 'program', program_id: 'prog-demo-cs' }), 200);
  ok(await s.post(`${D}/students/${A2}/advisor/explain`, { topic: 'program', program_id: 'prog-demo-psy' }), 200); // conflicting source: abstains
  ok(await s.post(`${D}/students/${A2}/advisor/explain`, { topic: 'astrology' }), 200, 400);

  // ---- assignments: step away from an unconsented student, reassign, repeat
  ok(await co.post(`${D}/students/${A1}/conflict-of-interest`, { reason: 'short' }), 422);
  ok(await co.post(`${D}/students/${A1}/conflict-of-interest`, { reason: 'The student is a relative of mine.' }), 200);
  ok(await co2.post(`${D}/students/${A1}/conflict-of-interest`, { reason: 'The student is a relative of mine.' }), 403);
  const asg = ok(await ta.get(`${D}/admin/assignments`), 200);
  assert.equal(asg.students.find((x) => x.student.id === A1).status, 'unassigned');
  ok(await ta.post(`${D}/admin/assignments`, { student_id: A1, counselor_id: 'user-counselor-a', reason: 'Trying to give them back' }), 409);
  ok(await ta.post(`${D}/admin/assignments`, { student_id: A1, counselor_id: 'user-counselor-b', reason: 'Wrong school' }), 422);
  assert.equal(ok(await ta.post(`${D}/admin/assignments`, { student_id: A1, counselor_id: 'user-counselor-a2', reason: 'Covering after a conflict' }), 200).changed, true);
  assert.equal(ok(await ta.post(`${D}/admin/assignments`, { student_id: A1, counselor_id: 'user-counselor-a2', reason: 'Same again' }), 200).changed, false);

  // ---- governance
  ok(await pl.get(`${D}/admin/instruments`), 200);
  const pub = ok(await pl.post(`${D}/admin/instruments/interest_exploratory/publish`, { target_state: 'approved_for_pilot' }), 409);
  assert.equal(pub.code, 'publication_blocked');
  ok(await pl.post(`${D}/admin/instruments/interest_exploratory/suspend`, { reason: 'Contract test: checking suspension' }), 200);
  ok(await pl.post(`${D}/admin/instruments/interest_exploratory/resume`, { reason: 'Contract test: resuming' }), 200);
  ok(await st1.get(`${D}/admin/program-rules`), 200);
  const rules = ok(await st1.get(`${D}/admin/program-rules`), 200);
  const draft = rules.items.flatMap((i) => i.drafts)[0];
  ok(await st1.post(`${D}/admin/program-rules/${draft.id}/publish`, {}), 403); // the author cannot publish
  ok(await st2.post(`${D}/admin/program-rules/${draft.id}/publish`, {}), 200);
  const day = 86400000;
  const iso = (n) => new Date(+app.time.now + n * day).toISOString();
  ok(await st1.post(`${D}/admin/program-rules`, { program_id: 'prog-demo-cs', conditions: [{ key: 'gat', value: 80 }], source: { publisher: 'Demo (fictional)', source_url: 'https://example.invalid/r', published_at: iso(-3), captured_at: iso(-1) }, effective_from: iso(-3), effective_to: iso(300), review_due_at: iso(120) }), 201);
  ok(await st1.post(`${D}/admin/program-rules`, { program_id: 'prog-demo-cs' }), 422);
  ok(await ta.get(`${D}/admin/control-tower`), 200);
  ok(await sec.get(`${D}/admin/control-tower`), 200);
  ok(await sec.get(`${D}/admin/audit?limit=5&action=assignment`), 200);
  ok(await sec.post(`${D}/admin/kill-switch`, { enabled: true, reason: 'Contract test drill' }), 200);
  ok(await s.get(`${D}/students/${A2}/discovery-profile`), 503);
  ok(await sec.post(`${D}/admin/kill-switch`, { enabled: false }), 200);

  // identity-related denials stay uniform
  const probe = ok(await (await as('user-student-b1')).get(`${D}/students/${A2}/discovery-profile`), 403);
  assert.equal(probe.reason, 'not_available');
});

test('every request the server accepted satisfies the spec, and every response (success or problem) matches its schema', () => {
  assert.ok(log.length > 100, `the scenario should be substantial, got ${log.length} calls`);
  const problems = [];
  for (const r of log) {
    const label = `${r.method} ${r.path} -> ${r.status}`;
    const o = findOp(r.method, r.path);
    if (!o) {
      problems.push(`${label}: not in the spec`);
      continue;
    }
    const base = `openapi#/paths/${esc(o.tpl)}/${o.method.toLowerCase()}`;
    const declared = o.op.responses[String(r.status)] ?? o.op.responses.default;
    const content = (declared.$ref ? spec.components.responses[declared.$ref.split('/').pop()] : declared).content ?? {};
    const type = String(r.headers.get('content-type') ?? '').split(';')[0];
    if (!content[type]) {
      problems.push(`${label}: content-type "${type}" is not declared (${Object.keys(content).join(', ') || 'none'})`);
      continue;
    }
    if (content[type].schema && type !== 'application/pdf') {
      const ref = declared.$ref ? `openapi#/components/responses/${declared.$ref.split('/').pop()}/content/${esc(type)}/schema` : `${base}/responses/${r.status}/content/${esc(type)}/schema`;
      const v = validatorFor(ref);
      if (!v(r.body)) problems.push(`${label}: response ${JSON.stringify(v.errors.slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`))}`);
    }
    if (r.status < 300 && o.op.requestBody?.content?.['application/json']?.schema && r.reqBody !== undefined) {
      const v = validatorFor(`${base}/requestBody/content/application~1json/schema`);
      if (!v(r.reqBody)) problems.push(`${label}: accepted request body does not match the spec ${JSON.stringify(v.errors.slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`))}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every operation was exercised, and every operation with a success response was seen succeeding', () => {
  const seen = new Set(log.map((r) => findOp(r.method, r.path)?.id));
  const never = OPS.filter((o) => !seen.has(o.id)).map((o) => o.id);
  assert.deepEqual(never, [], 'operations the scenario never called');
  // The one success the prototype cannot produce: instrument promotion is blocked (409) because no instrument has
  // licence or validation evidence. The 409 IS the contract, and it is asserted in the scenario.
  const succeeded = new Set(log.filter((r) => r.status < 300).map((r) => findOp(r.method, r.path)?.id));
  const neverSucceeded = OPS.filter((o) => !succeeded.has(o.id)).map((o) => o.id);
  assert.deepEqual(neverSucceeded, ['publishInstrument']);
  if (!findChromium()) return;
  assert.ok(succeeded.has('downloadReportPdf'));
});

test('invariants hold across everything the API returned: no probability, no percentile, no norms, no birth dates, no secrets', () => {
  const forbidden = new Set(['percentile', 'percentiles', 'admission_probability', 'date_of_birth', 'audit_key', 'dob']);
  const hits = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (forbidden.has(k)) hits.push(`${where}.${k}`);
        if (k === 'acceptance_probability' && x !== null) hits.push(`${where}.${k}=${x}`);
        if (k === 'norm_reference' && x !== null) hits.push(`${where}.${k}`);
        walk(x, `${where}.${k}`);
      }
    }
  };
  for (const r of log) walk(r.body, `${r.method} ${r.path}`);
  assert.deepEqual(hits, []);
});

// ================================================================ 3. events
test('every outbox event validates against its payload schema; the expiry sweep adds the last event type', async () => {
  await app.anon().get('/api/health');
  app.advance(2 * 365 * 86400000); // past every rule's review date
  await app.anon().get('/api/health'); // any request runs the maintenance sweep
  const events = app.store.db.outbox;
  assert.ok(events.length > 20);
  const envelope = validatorFor('events#/$defs/Envelope');
  const problems = [];
  const types = new Set();
  for (const e of events) {
    if (!envelope(e)) problems.push(`${e.event_type}: envelope ${JSON.stringify(envelope.errors.slice(0, 2).map((x) => `${x.instancePath} ${x.message}`))}`);
    const def = eventsSchema.$defs.events[e.event_type];
    if (!def) {
      problems.push(`${e.event_type}: no payload schema`);
      continue;
    }
    types.add(e.event_type);
    const v = validatorFor(`events#/$defs/events/${esc(e.event_type)}`);
    if (!v(e.payload)) problems.push(`${e.event_type}: payload ${JSON.stringify(v.errors.slice(0, 2).map((x) => `${x.instancePath} ${x.message}`))}`);
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(eventsSchema.$defs.events).filter((t) => !types.has(t)), [], 'event types the scenario never produced');
});
