// End-to-end browser checks against the real app (CSP intact). Run: npm run test:e2e
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x))) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* fall through to playwright's own lookup */
  }
  return undefined;
}

const { server } = createApp({ dataFile: null });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });

const problems = []; // console / page errors from every page, reported at the end
const results = [];

async function newUser(personaId, { locale = 'ar-SA', width = 1180, height = 900, colorScheme = 'light', bypassCSP = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, bypassCSP });
  await context.addInitScript((l) => {
    try { if (!localStorage.getItem('sd.locale')) localStorage.setItem('sd.locale', l); } catch { /* ignore */ }
  }, locale);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type())) return;
    if (/Failed to load resource: the server responded with a status of (4\d\d|503)/.test(m.text())) return; // expected negative paths
    if (/ERR_INTERNET_DISCONNECTED/.test(m.text())) return; // the offline step cuts the network on purpose
    problems.push(`[${personaId}] console.${m.type()}: ${m.text()}`);
  });
  page.on('response', (r) => { if (r.status() >= 500 && r.status() !== 503) problems.push(`[${personaId}] HTTP ${r.status()} ${r.url()}`); });
  page.on('pageerror', (e) => problems.push(`[${personaId}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (!/net::ERR_ABORTED|ERR_INTERNET_DISCONNECTED/.test(r.failure()?.errorText ?? '')) problems.push(`[${personaId}] request failed: ${r.url()} ${r.failure()?.errorText}`); });
  await page.goto(`${base}/#/login`);
  await page.waitForSelector('[data-persona]');
  await page.click(`[data-persona="${personaId}"]`);
  await page.waitForFunction(() => !location.hash.includes('login'));
  await page.waitForSelector('#app[data-route]');
  return { context, page, personaId };
}

async function go(page, route) {
  const pathOnly = route.split('?')[0];
  const target = `${base}/#${route}`;
  if (page.url() === target) await page.reload(); // same hash: force a fresh render
  else await page.goto(target);
  await page.waitForSelector(`#app[data-route="${pathOnly}"]`, { timeout: 10000 });
}

/** Every page we visit must be free of escaped markup, unreplaced placeholders and horizontal overflow. */
async function sane(page, label) {
  const info = await page.evaluate(() => ({
    text: document.body.innerText,
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));
  const bad = info.text.match(/&lt;|&gt;|&amp;|<\/?(div|span|svg|li|ul|article|section|button)\b|undefined|\[object|\bNaN\b|\{[a-z_]{2,}\}/);
  assert.equal(bad, null, `${label}: page shows broken text "${bad?.[0]}"`);
  assert.ok(info.over <= 1, `${label}: horizontal overflow of ${info.over}px`);
  assert.equal(info.dir, info.lang === 'en' ? 'ltr' : 'rtl', `${label}: dir matches lang`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
}

async function step(name, fn) {
  const t0 = Date.now();
  const before = problems.length;
  try {
    await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`browser reported problems:\n  ${fresh.join('\n  ')}`);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    const where = String(e.stack ?? '').split('\n').filter((l) => l.includes('run.mjs')).slice(0, 1).join('').trim();
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 14).join('\n      ')}\n      at ${where}`);
  }
}

const text = (page, sel) => page.locator(sel).first().innerText();
const answerPage = async (page, pick = (i) => i % 5) => {
  const items = page.locator('#page-form fieldset.item');
  const n = await items.count();
  for (let i = 0; i < n; i++) await items.nth(i).locator('.scale label, .choices label').nth(pick(i)).click();
  return n;
};

console.log(`\nE2E against ${base}\n`);

// ------------------------------------------------------------------ language, direction
await step('Arabic-first RTL shell; switching to English flips dir and persists', async () => {
  const u = await newUser('user-student-a1', { locale: 'ar-SA' });
  const { page } = u;
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
  assert.match(await page.title(), /اكتشف|نكست/);
  await page.waitForSelector('.hero');
  await sane(page, 'landing ar');
  await shot(page, 'landing-ar');
  await page.click('[data-action="toggle-locale"]');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'ltr');
  assert.match(await text(page, '.hero h1'), /Discover my strengths/i);
  await sane(page, 'landing en');
  await page.reload();
  await page.waitForSelector('.hero');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', 'the choice survives a reload');
  await page.click('[data-action="toggle-locale"]');
  await page.waitForFunction(() => document.documentElement.lang === 'ar-SA');
  await u.context.close();
});

// ------------------------------------------------------------------ consent with guardian (AC-01, minor)
const a1 = await newUser('user-student-a1', { locale: 'ar-SA' });
await step('AC-01 no consent: dashboard is locked with a clear way forward; consent form needs guardian for a minor', async () => {
  const { page } = a1;
  await go(page, '/dashboard');
  await sane(page, 'dashboard no consent');
  assert.ok(await page.locator('.card.warn[role=alert]').count(), 'consent warning is shown');
  assert.equal(await page.locator('[data-start]').first().isDisabled(), true, 'start is disabled');
  await go(page, '/consent');
  const proc = page.locator('#sc-assessment_processing');
  assert.equal(await proc.isChecked(), false, 'nothing is pre-ticked');
  for (const s of ['counselor_sharing', 'guardian_summary_sharing', 'advisor_explanation', 'aggregate_analytics']) assert.equal(await page.locator(`#sc-${s}`).isChecked(), false);
  await proc.check();
  await page.click('#consent-form button[type=submit]');
  await page.waitForSelector('text=بالانتظار');
  await sane(page, 'consent pending');
  await shot(page, 'consent-ar');
  await go(page, '/dashboard');
  assert.equal(await page.locator('[data-start]').first().isDisabled(), true, 'still locked while the guardian has not authorized');
});

await step('guardian authorizes; student can now start', async () => {
  const g = await newUser('user-guardian-a1', { locale: 'ar-SA' });
  await go(g.page, '/guardian');
  await sane(g.page, 'guardian pending');
  await g.page.click('[data-grant="true"]');
  await g.page.waitForSelector('[data-grant="false"]');
  assert.match(await g.page.locator('main').innerText(), /لا يوجد وصول إلى الملخص/, 'no summary access until the student opts in');
  await g.context.close();
  await go(a1.page, '/dashboard');
  assert.equal(await a1.page.locator('[data-start]').first().isDisabled(), false);
});

// ------------------------------------------------------------------ runner: autosave, resume, offline, submit (AC-03, AC-14)
await step('runner: accessible radio groups, keyboard selection, autosave and resume after reload', async () => {
  const { page } = a1;
  await go(page, '/dashboard');
  await page.locator('[data-start]').first().click();
  await page.waitForSelector('#page-form');
  await sane(page, 'runner');
  const legends = await page.locator('#page-form fieldset.item > legend').count();
  assert.equal(legends, 6, 'six items per page, each a fieldset with a legend');
  assert.equal(await page.locator('#page-form input[type=radio]').first().getAttribute('name'), 'q-INT-R-001');
  // keyboard: focus the first radio and use the arrow keys
  await page.locator('#page-form fieldset.item').first().locator('input[type=radio]').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const checked = await page.locator('#page-form fieldset.item').first().locator('input:checked').getAttribute('value');
  assert.ok(['2', '3'].includes(checked), `arrow keys move the selection (got ${checked})`);
  await shot(page, 'runner-ar');
  await answerPage(page);
  await page.waitForFunction(() => /✓|الإجابات|حفظ/.test(document.getElementById('save-status').textContent));
  assert.equal(await page.evaluate(() => document.querySelector('#run-progress').value), 6);
  await page.reload();
  await page.waitForSelector('#page-form');
  assert.equal(await page.evaluate(() => document.querySelector('#run-progress').value), 6, 'answers restored after reload (AC-03)');
  // the page resumes at the first page with an open item (page 2), and page 1 keeps its answers
  await page.click('[data-nav="prev"]');
  assert.equal(await page.locator('#page-form input:checked').count(), 6);
});

await step('runner: offline answers are queued and saved when the connection returns', async () => {
  const { page, context } = a1;
  await page.click('[data-nav="next"]');
  await context.setOffline(true);
  await page.locator('#page-form fieldset.item').first().locator('.scale label').nth(3).click();
  await page.waitForFunction(() => document.getElementById('save-status').classList.contains('err'), null, { timeout: 8000 });
  assert.ok((await text(page, '#save-status')).length > 5, 'an offline message is shown');
  await context.setOffline(false);
  await page.waitForFunction(() => !document.getElementById('save-status').classList.contains('err') && document.getElementById('save-status').textContent.length > 0, null, { timeout: 15000 });
  const saved = await page.evaluate(async () => {
    const sid = location.hash.split('/').pop();
    const r = await fetch(`/api/v1/discovery/sessions/${sid}`, { credentials: 'same-origin' });
    return (await r.json()).responses['INT-I-001'];
  });
  assert.equal(saved?.value, 4, 'the queued answer reached the server exactly once');
});

await step('runner: finish all pages, review, submit (sealed), results with replay verification', async () => {
  const { page } = a1;
  for (let guard = 0; guard < 8; guard++) {
    if (await page.locator('#submit').count()) break;
    await answerPage(page, (i) => (i + guard) % 5);
    await page.click('[data-nav="next"]');
  }
  await page.waitForSelector('#submit');
  await sane(page, 'review step');
  assert.equal(await page.locator('#submit').isDisabled(), false, 'all answered: nothing to acknowledge');
  await page.waitForFunction(() => document.querySelector('#run-progress').value === 36);
  await page.click('#submit');
  await page.waitForSelector('#h-int');
  await sane(page, 'results ar');
  assert.equal(await page.locator('.bars .bar-row').count() >= 6, true);
  const rows = await page.locator('#h-int ~ figure .bar-row .val').allInnerTexts();
  assert.equal(rows.length, 6);
  assert.ok(rows.every((v) => /[٠-٩0-9]/.test(v)), 'every dimension shows a number, in Arabic numerals');
  assert.match(await text(page, '.card.accent'), /غير مُتحقَّق|استكشافية/);
  await shot(page, 'results-ar');
  await page.click('#replay');
  await page.waitForFunction(() => /✓/.test(document.getElementById('replay-out').textContent));
  // the attempt is sealed: reopening the session URL no longer allows edits
  const sealedMsg = await page.evaluate(async () => {
    const sid = (await (await fetch('/api/v1/discovery/assessments')).json()).modules[0].last_session_id;
    const r = await fetch(`/api/v1/discovery/sessions/${sid}/responses/INT-R-001`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: '{"value":1}' });
    return r.status;
  });
  assert.ok([403, 409].includes(sealedMsg));
});

await step('submitting with unanswered questions requires explicit acknowledgement; unscored areas are labelled, never zero', async () => {
  const { page } = a1;
  await go(page, '/dashboard');
  await page.locator('article:has(#m-subject_preference_exploratory) [data-start]').click();
  await page.waitForSelector('#page-form');
  await answerPage(page);
  await page.click('[data-nav="next"]');
  await page.click('[data-nav="next"]');
  await page.waitForSelector('#submit');
  assert.equal(await page.locator('#submit').isDisabled(), true, 'locked until acknowledged');
  assert.ok(await page.locator('#ack').count());
  await page.check('#ack');
  assert.equal(await page.locator('#submit').isDisabled(), false);
  await page.click('#submit');
  await page.waitForURL(/#\/dashboard\?done=/);
  await sane(page, 'dashboard after submit');
});

// ------------------------------------------------------------------ majors, program, advisor, compare (English)
const a2 = await newUser('user-student-a2', { locale: 'en' });
await step('majors: three axes per card, filters, pin, compare tray and comparison table', async () => {
  const { page } = a2;
  await go(page, '/majors');
  await page.waitForSelector('.program-card');
  await sane(page, 'majors en');
  assert.equal(await page.locator('.program-card').count(), 15);
  assert.ok((await text(page, '.program-card .axes')).includes('Interest fit'));
  for (const label of ['Interest fit', 'Academic readiness', 'Admission conditions']) assert.ok((await page.locator('.program-card').first().innerText()).includes(label));
  const body = await page.locator('main').innerText();
  assert.ok(!/% chance|probability of (admission|acceptance)\b(?! is| was)/i.test(body.replace(/No chance of acceptance[^.]*\./gi, '')), 'no admission probability anywhere');
  await shot(page, 'majors-en');
  await page.selectOption('#f-elig', 'source_stale');
  assert.equal(await page.locator('.program-card').count(), 1);
  assert.match(await text(page, '.program-card h3'), /Nursing/);
  await page.selectOption('#f-elig', '');
  await page.check('#f-pinned');
  assert.equal(await page.locator('.program-card').count(), 2, 'A2 pinned two majors');
  await page.uncheck('#f-pinned');
  // pin toggling keeps focus and updates aria-pressed
  const pin = page.locator('[data-pin="prog-demo-arch"]');
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  await pin.click();
  await page.waitForSelector('[data-pin="prog-demo-arch"][aria-pressed="true"]');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.pin), 'prog-demo-arch', 'focus stays on the pin button after it updates');
  await page.locator('[data-pin="prog-demo-arch"]').click();
  await page.waitForSelector('[data-pin="prog-demo-arch"][aria-pressed="false"]');
  // compare: up to three
  for (const id of ['prog-demo-cs', 'prog-demo-me', 'prog-demo-se']) await page.check(`[data-cmp="${id}"]`);
  assert.equal(await page.locator('[data-cmp]:not(:checked)').first().isDisabled(), true, 'a fourth cannot be selected');
  await page.click('#do-compare');
  await page.waitForSelector('table');
  await sane(page, 'compare');
  assert.equal(await page.locator('thead th[scope=col]').count(), 3);
  assert.ok((await page.locator('table').innerText()).includes('self-reported') || (await page.locator('table').innerText()).includes('Self-report'));
  await shot(page, 'compare-en');
});

await step('program detail: why-fit table, sources with dates, no probability; advisor abstains on conflicting source (AC-10)', async () => {
  const { page } = a2;
  await go(page, '/program/prog-demo-cs');
  await page.waitForSelector('#why');
  await sane(page, 'program cs');
  const main = await page.locator('main').innerText();
  assert.match(main, /No chance of acceptance is calculated/);
  assert.match(main, /Seats are competitive/);
  assert.match(main, /Publisher/);
  assert.match(main, /Review due/);
  assert.equal(await page.locator('section[aria-labelledby=why] table tbody tr').count(), 6);
  await shot(page, 'program-en');
  await page.click('#explain');
  await page.waitForSelector('#adv-out .card');
  assert.match(await text(page, '#adv-out'), /Not an official decision/);
  assert.match(await text(page, '#adv-out'), /No chance of acceptance/);
  await go(page, '/program/prog-demo-psy');
  await page.waitForSelector('#explain');
  await page.click('#explain');
  await page.waitForSelector('#adv-out .card.warn');
  assert.match(await text(page, '#adv-out'), /can.t explain this reliably/);
  assert.match(await page.locator('main').innerText(), /Sources conflict/);
});

await step('roadmap lists gaps with owners, never promises or books anything', async () => {
  const { page } = a2;
  await go(page, '/roadmap');
  await sane(page, 'roadmap');
  const main = await page.locator('main').innerText();
  assert.match(main, /Ask your counselor to verify|Add your/);
  assert.match(main, /does not book a time/);
  await page.click('#meet');
  await page.waitForFunction(() => document.getElementById('meet-msg').textContent.length > 3);
});

await step('settings: accessibility preferences apply immediately and persist across reload', async () => {
  const { page } = a2;
  await go(page, '/settings');
  await page.selectOption('#ts', 'xlarge');
  await page.check('#hc');
  await page.click('#set-form button[type=submit]');
  await page.waitForFunction(() => document.documentElement.dataset.textSize === 'xlarge' && document.documentElement.dataset.contrast === 'high');
  await page.reload();
  await page.waitForSelector('#set-form');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.textSize), 'xlarge');
  await sane(page, 'xlarge + high contrast');
  await shot(page, 'settings-xlarge-hc');
  await page.selectOption('#ts', 'normal');
  await page.uncheck('#hc');
  await page.click('#set-form button[type=submit]');
  await page.waitForFunction(() => document.documentElement.dataset.textSize === 'normal');
});

await step('evidence entry accepts Arabic-Indic digits and labels everything unverified', async () => {
  const { page } = a2;
  await go(page, '/evidence');
  await sane(page, 'evidence');
  await page.fill('[name="saat"]', '٨٩٫٥');
  await page.click('#ev-form button[type=submit]');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('ev-msg')?.textContent ?? ''));
  assert.equal(await page.inputValue('[name="saat"]'), '89.5');
  assert.match(await page.locator('.field:has([name="saat"])').innerText(), /Unverified/);
  await page.fill('[name="gat"]', '150');
  await page.click('#ev-form button[type=submit]');
  await page.waitForSelector('#ev-msg.error-text');
});

// ------------------------------------------------------------------ counselor (English)
const co = await newUser('user-counselor-a', { locale: 'en' });
await step('counselor queue shows reasons and gates unconsented students', async () => {
  const { page } = co;
  await go(page, '/counselor');
  await page.waitForSelector('table');
  await sane(page, 'queue');
  const rows = await page.locator('tbody tr').allInnerTexts();
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => /Report to review/.test(r)));
  await shot(page, 'queue-en');
});

await step('Case 360: keyboard-operable tabs, evidence verification needs a note, signed override, raw answers are logged', async () => {
  const { page } = co;
  await go(page, '/counselor/student/user-student-a2?purpose=weekly+review');
  await page.waitForSelector('[role=tablist]');
  await sane(page, 'case360');
  await page.locator('#tab-overview').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-results').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#tab-raw').getAttribute('aria-selected'), 'true');
  await page.locator('#tab-evidence').click();
  const pending = await page.locator('form[data-verify]').count();
  assert.ok(pending >= 1, 'there is unverified evidence to check');
  const gatForm = page.locator('form[data-verify]').first();
  await gatForm.locator('button').click();
  await page.waitForFunction(() => document.getElementById('ev-msg').textContent.length > 3);
  await gatForm.locator('input').fill('Saw the official score report (synthetic)');
  await gatForm.locator('button').click();
  await page.waitForFunction((n) => document.querySelectorAll('form[data-verify]').length === n - 1, pending);
  await page.locator('#tab-results').click();
  await page.fill('#ov-text', 'Social interest is probably under-reported given weekly volunteering.');
  await page.fill('#ov-reason', 'short');
  await page.click('#override-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('ov-msg').textContent.length > 3);
  await page.fill('#ov-reason', 'Interview on 10 Oct contradicts the answer pattern.');
  await page.selectOption('#ov-vis', 'student');
  await page.click('#override-form button[type=submit]');
  await page.waitForSelector('text=Social interest is probably under-reported');
  await page.locator('#tab-raw').click();
  await page.locator('[data-raw]').first().click();
  await page.waitForSelector('#raw-out table');
  await page.waitForFunction(() => /logged/i.test(document.getElementById('live').textContent));
  await shot(page, 'case360-en');
});

await step('report review: approval is bound to the displayed content; DRAFT watermark disappears once approved', async () => {
  const { page } = co;
  await go(page, '/counselor/student/user-student-a2');
  await page.locator('#tab-reports').click();
  const link = page.locator('#panel-reports a', { hasText: 'Review' }).first();
  await link.click();
  await page.waitForSelector('#dec');
  assert.equal(await page.locator('.watermark-wrap[data-watermark]').count(), 1, 'draft watermark while in review');
  await sane(page, 'report review');
  await page.click('[data-decide="approve"]');
  await page.waitForFunction(() => !document.querySelector('#dec'));
  assert.equal(await page.locator('.watermark-wrap[data-watermark]').count(), 0);
  assert.match(await text(page, 'header.card'), /Approved/);
  await shot(page, 'report-approved-en');
});

await step('student shares the approved report; guardian sees it only via the share and never raw answers', async () => {
  const s = a2.page;
  await go(s, '/report');
  await s.locator('tbody a', { hasText: 'Open' }).first().click();
  await s.waitForSelector('#share, #review');
  if (await s.locator('#share').count()) {
    await s.click('#share');
    await s.waitForSelector('text=Shared until');
  }
  const g = await newUser('user-guardian-a2', { locale: 'en' });
  await go(g.page, '/guardian');
  await sane(g.page, 'guardian summary');
  const main = await g.page.locator('main').innerText();
  assert.match(main, /What you will not see/);
  assert.ok(!/INT-R-001|display_0_100/.test(main));
  await g.page.locator('a', { hasText: /Report from/ }).first().click();
  await g.page.waitForSelector('header.card');
  assert.equal(await g.page.locator('.watermark-wrap[data-watermark]').count(), 0);
  await g.context.close();
});

// ------------------------------------------------------------------ governance (English)
await step('instruments: publication is blocked with reasons; aptitude is on hold with no items', async () => {
  const p = await newUser('user-psych-1', { locale: 'en' });
  await go(p.page, '/admin/instruments');
  await p.page.waitForSelector('article.card');
  await sane(p.page, 'instruments');
  const first = p.page.locator('article.card').first();
  await first.locator('input[name=reason]').fill('Request pilot approval');
  await first.locator('button[data-do=publish]').click();
  await p.page.waitForFunction(() => /Publication blocked/.test(document.body.innerText));
  assert.match(await p.page.locator('main').innerText(), /Licence not confirmed|license_not_confirmed/);
  assert.match(await p.page.locator('main').innerText(), /On hold/);
  await shot(p.page, 'instruments-en');
  await p.context.close();
});

await step('four-eyes catalog: author cannot publish; second steward can; source freshness updates', async () => {
  const s1 = await newUser('user-steward-1', { locale: 'en' });
  await go(s1.page, '/admin/catalog');
  await s1.page.waitForSelector('table');
  await sane(s1.page, 'catalog');
  assert.equal(await s1.page.locator('[data-publish]').count(), 0, 'the author gets no publish button');
  assert.match(await s1.page.locator('#dr').locator('..').innerText(), /another steward must publish/);
  await shot(s1.page, 'catalog-en');
  await s1.context.close();
  const s2 = await newUser('user-steward-2', { locale: 'en' });
  await go(s2.page, '/admin/catalog');
  await s2.page.waitForSelector('[data-publish]');
  await s2.page.click('[data-publish]');
  await s2.page.waitForFunction(() => document.querySelectorAll('[data-publish]').length === 0);
  assert.equal(await s2.page.locator('tbody tr', { hasText: 'Nursing' }).locator('.chip', { hasText: 'Source current' }).count(), 1);
  await s2.context.close();
});

await step('control tower: small cohorts suppressed; kill switch shows a banner to students and blocks them; recovery works', async () => {
  const ta = await newUser('user-tenant-admin-a', { locale: 'en' });
  await go(ta.page, '/admin/control');
  await sane(ta.page, 'control tower');
  assert.ok((await ta.page.locator('main').innerText()).includes('hidden (small group)'));
  assert.ok(!/user-student/.test(await ta.page.locator('main').innerText()));
  await shot(ta.page, 'control-en');
  await ta.context.close();

  const sec = await newUser('user-security', { locale: 'en' });
  await go(sec.page, '/admin/control');
  await sec.page.waitForSelector('#kill');
  assert.match(await sec.page.locator('main').innerText(), /Intact/);
  await sec.page.fill('#kr', 'E2E incident drill');
  await sec.page.click('#kill button[type=submit]');
  await sec.page.waitForSelector('.incident-banner');
  await go(a2.page, '/dashboard');
  await a2.page.waitForSelector('.incident-banner');
  assert.match(await a2.page.locator('#app').innerText(), /temporarily unavailable|suspended/i);
  await sec.page.fill('#kr', '');
  await sec.page.click('#kill button[type=submit]');
  await sec.page.waitForFunction(() => !document.querySelector('.incident-banner'));
  await go(a2.page, '/dashboard');
  await a2.page.waitForSelector('article.card');
  assert.ok(await sec.page.locator('table tbody tr').count() > 10, 'audit log is visible to the security role');
  await sec.context.close();
});

await step('students are bounced from staff screens; staff from student screens', async () => {
  await a2.page.goto(`${base}/#/admin/control`);
  await a2.page.waitForSelector('.card.bad');
  assert.match(await a2.page.locator('#app').innerText(), /denied|not allowed|permission/i);
  await co.page.goto(`${base}/#/results`);
  await co.page.waitForSelector('.card.bad');
});

// ------------------------------------------------------------------ viewport & accessibility sweeps
const SWEEP = {
  'user-student-a2': ['/discover', '/consent', '/dashboard', '/evidence', '/results', '/majors', '/program/prog-demo-me', '/roadmap', '/report', '/help', '/settings'],
  'user-guardian-a2': ['/guardian'],
  'user-counselor-a': ['/counselor', '/counselor/student/user-student-a2'],
  'user-psych-1': ['/admin/instruments'],
  'user-steward-1': ['/admin/catalog'],
  'user-security': ['/admin/control'],
};

await step('phone width (375px): no horizontal overflow or broken text on any screen, Arabic and English', async () => {
  for (const locale of ['ar-SA', 'en']) {
    for (const [persona, routes] of Object.entries(SWEEP)) {
      const u = await newUser(persona, { locale, width: 375, height: 800 });
      for (const r of routes) {
        await go(u.page, r);
        await sane(u.page, `${persona} ${r} ${locale} @375`);
      }
      if (persona === 'user-student-a2') await shot(u.page, `mobile-${locale}-settings`);
      await u.context.close();
    }
  }
});

async function axeScan(personaId, routes, { locale, colorScheme = 'light', tag }) {
  const u = await newUser(personaId, { locale, colorScheme, bypassCSP: true });
  const found = [];
  for (const r of routes) {
    await go(u.page, r);
    await u.page.evaluate(axeSource);
    const res = await u.page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
    for (const v of res.violations) found.push({ route: r, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1, 3).join(' | ')}`) });
  }
  await u.context.close();
  return { tag, found };
}

await step('WCAG 2.2 AA automated scan (axe-core): zero violations on every screen, both languages, light and dark', async () => {
  const jobs = [];
  for (const locale of ['ar-SA', 'en']) {
    for (const [persona, routes] of Object.entries(SWEEP)) {
      jobs.push(await axeScan(persona, routes, { locale, tag: `${persona}/${locale}/light` }));
    }
    jobs.push(await axeScan('user-student-a2', ['/dashboard', '/results', '/majors', '/program/prog-demo-cs', '/consent'], { locale, colorScheme: 'dark', tag: `student/${locale}/dark` }));
  }
  const all = jobs.flatMap((j) => j.found.map((f) => ({ ...f, tag: j.tag })));
  fs.writeFileSync(path.join(out, 'axe-report.json'), JSON.stringify(all, null, 2));
  const detail = all.map((f) => `${f.tag} ${f.route}: [${f.impact}] ${f.id} — ${f.help}\n        ${f.nodes.join('\n        ')}`).join('\n      ');
  assert.equal(all.length, 0, `axe violations:\n      ${detail}`);
});

await browser.close();
await new Promise((r) => server.close(r));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E steps passed. Screenshots: ${out}\n`);
if (problems.length) {
  console.log('Browser problems seen overall:');
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(`  - ${p}`);
}
process.exit(failed.length ? 1 : 0);
