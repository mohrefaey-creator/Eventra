// PDF export: approved reports only, same authorization as reading the report, a real tagged PDF, and honest failure modes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, BASE } from './helpers.js';
import { findChromium } from '../../server/pdf.js';

const HAVE_CHROMIUM = Boolean(findChromium());
const have = (bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const HAVE_POPPLER = have('pdfinfo') && have('pdftotext');
const A2 = 'user-student-a2';

let app;
let tmp;
before(async () => {
  app = await startApp();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-pdf-test-'));
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const audits = (action) => app.store.db.audit.filter((e) => e.action === action);
const inspect = (buf, name) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, buf);
  return { info: execFileSync('pdfinfo', [file], { encoding: 'utf8' }), text: execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }) };
};

/** A fresh report for A2 whose content includes a student-visible counselor note, taken through review to approval. */
async function approvedReport(note) {
  const co = await app.as('user-counselor-a');
  const s = await app.as(A2);
  const profile = (await co.get(`${BASE}/students/${A2}/discovery-profile`)).body;
  const run = profile.panels.expressed_interests.score_run_id;
  if (note) assert.equal((await co.post(`${BASE}/students/${A2}/overrides`, { score_run_id: run, text: note, reason: 'Interview notes support this reading.', visibility: 'student' })).status, 201);
  const rep = (await s.post(`${BASE}/students/${A2}/reports`)).body;
  if (rep.status === 'approved') return rep.id; // identical content was already approved earlier in this file
  assert.equal((await s.post(`${BASE}/reports/${rep.id}/review-request`)).status, 200);
  const view = (await co.get(`${BASE}/reports/${rep.id}`)).body;
  assert.equal((await co.post(`${BASE}/reports/${rep.id}/approval`, { action: 'approve', payload_hash: view.payload_hash, reason: 'Checked' })).status, 200);
  return rep.id;
}

test('a report that is not approved cannot be exported, and nothing is recorded as exported', async () => {
  const s = await app.as(A2);
  const draft = Object.values(app.store.db.reports).find((r) => r.student_id === A2 && r.status === 'review_requested');
  const r = await s.get(`${BASE}/reports/${draft.id}/pdf`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'report_not_approved');
  assert.equal(audits('report.exported').length, 0);
});

test('locale must be one of the two supported languages', async () => {
  const s = await app.as(A2);
  const id = Object.values(app.store.db.reports).find((r) => r.student_id === A2).id;
  assert.equal((await s.get(`${BASE}/reports/${id}/pdf?locale=fr`)).status, 400);
});

test('without a browser the export answers 501 and records nothing', async () => {
  const bare = await startApp({ chromiumPath: '/nonexistent/chrome' });
  try {
    const co = await bare.as('user-counselor-a');
    const s = await bare.as(A2);
    const rep = Object.values(bare.store.db.reports).find((r) => r.student_id === A2);
    const view = (await co.get(`${BASE}/reports/${rep.id}`)).body;
    assert.equal((await co.post(`${BASE}/reports/${rep.id}/approval`, { action: 'approve', payload_hash: view.payload_hash, reason: 'ok' })).status, 200);
    const r = await s.get(`${BASE}/reports/${rep.id}/pdf`);
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'pdf_unavailable');
    assert.equal(bare.store.db.audit.some((e) => e.action === 'report.exported'), false);
    assert.equal((await s.get(`${BASE}/reports/${rep.id}`)).status, 200, 'the screen version still works');
  } finally {
    await bare.close();
  }
});

test('a browser that fails produces 502, a recorded failure and no file', async () => {
  const fake = path.join(tmp, 'fake-chrome');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const broken = await startApp({ chromiumPath: fake });
  try {
    const co = await broken.as('user-counselor-a');
    const s = await broken.as(A2);
    const rep = Object.values(broken.store.db.reports).find((r) => r.student_id === A2);
    const view = (await co.get(`${BASE}/reports/${rep.id}`)).body;
    await co.post(`${BASE}/reports/${rep.id}/approval`, { action: 'approve', payload_hash: view.payload_hash, reason: 'ok' });
    const r = await s.get(`${BASE}/reports/${rep.id}/pdf`);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'pdf_failed');
    assert.ok(broken.store.db.audit.some((e) => e.action === 'report.export_failed' && e.subject_ref === `report:${rep.id}`));
  } finally {
    await broken.close();
  }
});

test('approved report: a real, tagged PDF in Arabic and English; escaped content; cached; audited', { skip: !HAVE_CHROMIUM && 'no Chromium on this machine' }, async () => {
  const note = '<script>alert(1)</script> Social interest looks under-reported.';
  const id = await approvedReport(note);
  const s = await app.as(A2);

  const ar = await s.get(`${BASE}/reports/${id}/pdf`);
  assert.equal(ar.status, 200);
  assert.equal(ar.headers.get('content-type'), 'application/pdf');
  assert.match(ar.headers.get('content-disposition'), /^attachment; filename="discovery-report-[0-9a-f]{8}-ar\.pdf"$/);
  assert.equal(ar.headers.get('cache-control'), 'no-store');
  assert.equal(ar.buf.subarray(0, 5).toString('latin1'), '%PDF-');

  const en = await s.get(`${BASE}/reports/${id}/pdf?locale=en`);
  assert.equal(en.status, 200);
  assert.match(en.headers.get('content-disposition'), /-en\.pdf"$/);

  const again = await s.get(`${BASE}/reports/${id}/pdf?locale=en`);
  assert.ok(again.buf.equals(en.buf), 'the same approved content is rendered once');

  const log = audits('report.exported').filter((e) => e.subject_ref === `report:${id}`);
  assert.equal(log.length, 3, 'every download is recorded, cached or not');
  assert.deepEqual(log.map((e) => e.meta.locale), ['ar-SA', 'en', 'en']);
  assert.ok(log.every((e) => e.actor.id === A2 && e.meta.format === 'pdf'));

  if (!HAVE_POPPLER) return;
  const a = inspect(ar.buf, 'ar.pdf');
  const e = inspect(en.buf, 'en.pdf');
  assert.match(a.info, /Tagged:\s+yes/);
  assert.match(e.info, /Tagged:\s+yes/);
  assert.match(e.info, /Title:\s+.*Discovery report|Title:\s+.*report/i);
  assert.match(a.text, /[؀-ۿ]{3,}/, 'Arabic text is extractable');
  assert.ok(!/�/.test(a.text), 'no replacement characters (missing glyphs)');
  assert.match(e.text, /Demo Student A2/);
  assert.match(e.text, /<script>alert\(1\)<\/script>/, 'markup in a note is printed as text, never interpreted');
  assert.match(e.text, /Synthetic prototype/);
  assert.match(e.text, /Content fingerprint/);
  assert.match(e.text, /not an admission decision and shows no chance of acceptance/);
  assert.ok(!/%|٪/.test(e.text + a.text), 'no percentage that could be read as a probability');
});

test('who can export follows who can read: owner, assigned counselor, guardian only through an active share; nobody else', { skip: !HAVE_CHROMIUM && 'no Chromium on this machine' }, async () => {
  const id = await approvedReport(null);
  const url = `${BASE}/reports/${id}/pdf`;
  assert.equal((await app.anon().get(url)).status, 401);
  assert.equal((await (await app.as('user-student-b1')).get(url)).status, 403);
  assert.equal((await (await app.as('user-counselor-b')).get(url)).status, 403);
  assert.equal((await (await app.as('user-counselor-a2')).get(url)).status, 403, 'a counselor of the same school who is not assigned');
  assert.equal((await (await app.as('user-steward-1')).get(url)).status, 403);
  const unknown = await (await app.as(A2)).get(`${BASE}/reports/00000000-0000-0000-0000-000000000000/pdf`);
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.reason, 'not_available');

  const co = await app.as('user-counselor-a');
  assert.equal((await co.get(url)).status, 200);

  const g = await app.as('user-guardian-a2');
  const before = await g.get(url);
  assert.equal(before.status, 403);
  assert.equal(before.body.reason, 'report_not_shared');
  assert.equal((await (await app.as(A2)).post(`${BASE}/reports/${id}/shares`, { days: 7 })).status, 201);
  assert.equal((await g.get(url)).status, 200);
  const other = await (await app.as('user-guardian-a1')).get(url);
  assert.equal(other.status, 403, 'a guardian of a different student');
});

test('withdrawing counselor sharing closes the counselor\'s PDF export at once', { skip: !HAVE_CHROMIUM && 'no Chromium on this machine' }, async () => {
  const id = await approvedReport(null);
  const s = await app.as(A2);
  const co = await app.as('user-counselor-a');
  assert.equal((await co.get(`${BASE}/reports/${id}/pdf`)).status, 200);
  assert.equal((await s.post(`${BASE}/students/${A2}/consent`, { scope: 'counselor_sharing', granted: false })).status, 200);
  const r = await co.get(`${BASE}/reports/${id}/pdf`);
  assert.equal(r.status, 403);
  assert.equal((await s.get(`${BASE}/reports/${id}/pdf`)).status, 200, 'the student keeps their own copy');
});
