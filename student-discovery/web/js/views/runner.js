import { h, mount } from '../html.js';
import { get, post, put, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { num } from '../format.js';
import { announce } from '../a11y.js';
import { go } from '../router.js';
import { notice } from '../components/ui.js';

const PAGE_SIZE = { interest_exploratory: 6, subject_preference_exploratory: 6 };
const DEFAULT_PAGE = 4;

/**
 * Autosave queue: one in-flight request per item, latest value wins, exponential backoff when the
 * network is down, and nothing is lost on reconnect. The server owns the truth (If-Match revisions).
 */
class Saver {
  constructor(sessionId, onStatus) {
    this.sessionId = sessionId;
    this.onStatus = onStatus;
    this.pending = new Map();
    this.inflight = new Set();
    this.revs = new Map();
    this.timer = null;
    this.attempt = 0;
    this.failed = null;
    window.addEventListener('online', () => this.flush());
  }

  enqueue(itemId, value) {
    this.pending.set(itemId, value);
    this.onStatus('saving');
    this.flush();
  }

  async flush() {
    clearTimeout(this.timer);
    let offline = false;
    for (const [itemId, value] of [...this.pending]) {
      if (this.inflight.has(itemId)) continue;
      this.inflight.add(itemId);
      try {
        const res = await put(`${BASE}/sessions/${this.sessionId}/responses/${encodeURIComponent(itemId)}`, { value }, this.revs.has(itemId) ? { 'If-Match': `"${this.revs.get(itemId)}"` } : {});
        this.revs.set(itemId, res.data.revision_seq);
        if (this.pending.get(itemId) === value) this.pending.delete(itemId);
        this.attempt = 0;
        this.failed = null;
        this.onProgress?.(res.data.progress);
      } catch (e) {
        if (e.status === 412 && typeof e.problem.current_revision === 'number') {
          this.revs.set(itemId, e.problem.current_revision); // another tab changed it: adopt its revision, keep our value
        } else if (e.status === 0 || e.status >= 500 || e.status === 429) {
          offline = true;
        } else {
          this.pending.delete(itemId);
          this.failed = e;
        }
      } finally {
        this.inflight.delete(itemId);
      }
    }
    if (this.failed) return this.onStatus('error', this.failed.message);
    if (offline) {
      this.attempt += 1;
      this.onStatus('offline');
      this.timer = setTimeout(() => this.flush(), Math.min(30000, 1000 * 2 ** this.attempt));
    } else if (this.pending.size) {
      this.timer = setTimeout(() => this.flush(), 50);
    } else {
      this.onStatus('saved');
    }
  }

  async drain(maxMs = 15000) {
    const start = Date.now();
    while ((this.pending.size || this.inflight.size) && Date.now() - start < maxMs) {
      await this.flush();
      await new Promise((r) => setTimeout(r, 60));
    }
    return this.pending.size === 0;
  }
}

function itemMarkup(item, scales, idx, value) {
  const scale = scales[item.scale];
  const name = `q-${item.item_id}`;
  const na = item.response_type === 'likert_5_na';
  const body =
    item.response_type === 'single_choice'
      ? h`<div class="choices">${item.options.map((o) => h`<label><input type="radio" name="${name}" value="${o}" ${String(value) === o ? 'checked' : ''}> ${loc(scale[o])}</label>`)}</div>`
      : h`<div class="scale">${[1, 2, 3, 4, 5].map((v) => h`<label><input type="radio" name="${name}" value="${v}" ${Number(value) === v && value !== 'na' ? 'checked' : ''}><span>${loc(scale[v])}</span></label>`)}</div>
          ${na ? h`<div class="na-row"><label><input type="radio" name="${name}" value="na" ${value === 'na' ? 'checked' : ''}> ${loc(scale.na)}</label></div>` : ''}`;
  return h`<fieldset class="item" data-item="${item.item_id}"><legend><span class="qno">${num(idx + 1)}.</span>${loc(item.content)}</legend>${body}</fieldset>`;
}

export default async function view({ params }) {
  const s = await get(`${BASE}/sessions/${params.sid}`);
  const inst = s.instrument;

  if (s.status !== 'in_progress' || !s.can_edit) {
    const msg = s.status === 'submitted' ? 'run.sealed' : s.status === 'suspended_consent' ? 'run.paused_consent' : 'run.unavailable';
    return {
      title: loc(inst.name),
      body: h`<div class="stack"><h1>${loc(inst.name)}</h1>${notice(s.status === 'submitted' ? 'accent' : 'warn', h`<p>${t(msg)}</p><div class="row">
        <a class="btn" href="#/${s.status === 'suspended_consent' ? 'consent' : s.status === 'submitted' ? 'results' : 'dashboard'}">${t(s.status === 'suspended_consent' ? 'run.go_consent' : s.status === 'submitted' ? 'dash.see_results' : 'nav.dashboard')}</a></div>`)}</div>`,
    };
  }

  const pageSize = PAGE_SIZE[inst.instrument_id] ?? DEFAULT_PAGE;
  const pages = [];
  for (let i = 0; i < s.items.length; i += pageSize) pages.push(s.items.slice(i, i + pageSize));
  const answers = new Map(Object.entries(s.responses).map(([k, v]) => [k, v.value]));

  const saver = new Saver(s.session_id, () => {});
  for (const [k, v] of Object.entries(s.responses)) saver.revs.set(k, v.revision_seq);
  let page = 0; // pages.length === review step

  return {
    title: loc(inst.name),
    body: h`<div class="stack">
      <div><p class="muted small"><a href="#/dashboard">← ${t('nav.dashboard')}</a></p><h1>${loc(inst.name)}</h1>
        <p class="lead">${loc(inst.purpose)}</p></div>
      <div class="card flat">
        <label for="run-progress" id="run-progress-label" class="small"></label>
        <progress id="run-progress" max="${s.items_total}" value="${answers.size}"></progress>
        <div class="row between"><span class="save-status" id="save-status" role="status" aria-live="polite"></span><span class="small muted" id="page-label"></span></div>
      </div>
      <div class="card flat small" role="note">${loc(inst.interpretation_warning)}</div>
      <div id="run-body"></div>
    </div>`,
    after(root) {
      const body = root.querySelector('#run-body');
      const statusEl = root.querySelector('#save-status');
      const progress = root.querySelector('#run-progress');
      const progLabel = root.querySelector('#run-progress-label');
      const pageLabel = root.querySelector('#page-label');

      const setStatus = (kind, msg) => {
        statusEl.classList.toggle('err', kind === 'error' || kind === 'offline');
        statusEl.textContent = kind === 'saving' ? t('run.saving') : kind === 'saved' ? t('run.saved') : kind === 'offline' ? t('run.offline') : t('run.error', { msg: msg ?? '' });
      };
      saver.onStatus = setStatus;
      const updateProgress = () => {
        progress.value = answers.size;
        progLabel.textContent = t('run.answered', { a: num(answers.size), b: num(s.items_total) });
      };
      saver.onProgress = () => updateProgress();
      updateProgress();

      window.onbeforeunload = () => (saver.pending.size ? 'unsaved' : null);

      function show(n, focus = true) {
        page = n;
        pageLabel.textContent = page < pages.length ? t('run.page', { a: num(page + 1), b: num(pages.length) }) : t('run.review_step');
        if (page < pages.length) {
          const first = pages[page][0];
          const startIdx = s.items.indexOf(first);
          mount(body, h`<p class="lead">${loc(inst.stem)}</p>
            <form id="page-form" novalidate>${pages[page].map((it, i) => itemMarkup(it, s.scales, startIdx + i, answers.get(it.item_id)))}</form>
            <div class="sticky-bar row between no-print">
              <button class="btn secondary" type="button" data-nav="prev" ${page === 0 ? 'disabled' : ''}>${t('common.previous')}</button>
              <span class="hint">${t('run.skip_ok')}</span>
              <button class="btn" type="button" data-nav="next">${page === pages.length - 1 ? t('run.review') : t('common.next')}</button>
            </div>`);
          body.querySelector('#page-form').addEventListener('change', (e) => {
            const input = e.target;
            if (input.type !== 'radio') return;
            const itemId = input.name.slice(2);
            const value = input.value === 'na' || inst.instrument_id === 'student_constraints' ? input.value : Number(input.value);
            answers.set(itemId, value);
            updateProgress();
            saver.enqueue(itemId, value);
          });
        } else {
          const missing = s.items.filter((it) => !answers.has(it.item_id));
          mount(body, h`<section class="card stack" aria-labelledby="rv">
            <h2 id="rv">${t('run.review_title')}</h2>
            <p>${t('run.review_body', { a: num(answers.size), b: num(s.items_total) })}</p>
            ${missing.length ? h`<div class="card warn"><strong>${t('run.unanswered', { n: num(missing.length) })}</strong>
              <ul>${missing.slice(0, 12).map((it) => h`<li><button class="btn linklike" type="button" data-goto="${s.items.indexOf(it)}">${loc(it.content)}</button></li>`)}</ul>
              ${missing.length > 12 ? h`<p class="small muted">${t('run.and_more', { n: num(missing.length - 12) })}</p>` : ''}
              <div class="check"><input type="checkbox" id="ack"><label for="ack">${t('run.ack')}</label></div></div>` : ''}
            <p class="hint">${t('run.seal_note')}</p>
            <p id="submit-msg" class="error-text" role="alert"></p>
            <div class="row"><button class="btn secondary" type="button" data-nav="prev">${t('common.previous')}</button>
              <button class="btn" type="button" id="submit" ${missing.length ? 'disabled aria-disabled="true"' : ''}>${t('run.submit')}</button></div></section>`);
          const ack = body.querySelector('#ack');
          const submit = body.querySelector('#submit');
          ack?.addEventListener('change', () => {
            submit.disabled = !ack.checked;
            submit.setAttribute('aria-disabled', String(!ack.checked));
          });
          submit.addEventListener('click', async () => {
            submit.disabled = true;
            const msg = body.querySelector('#submit-msg');
            msg.textContent = '';
            const flushed = await saver.drain();
            if (!flushed) {
              msg.textContent = t('run.offline_submit');
              submit.disabled = false;
              return;
            }
            try {
              await post(`${BASE}/sessions/${s.session_id}/submit`, { acknowledge_incomplete: Boolean(ack?.checked) });
              window.onbeforeunload = null;
              announce(t('run.submitted'));
              go(inst.instrument_id === 'interest_exploratory' ? '/results' : `/dashboard?done=${inst.instrument_id}`);
            } catch (e) {
              msg.textContent = e.message;
              submit.disabled = false;
            }
          });
        }
        if (focus) {
          const target = body.querySelector('legend, h2');
          target?.setAttribute('tabindex', '-1');
          target?.focus();
          window.scrollTo({ top: 0 });
        }
      }

      body.addEventListener('click', (e) => {
        const nav = e.target.closest('[data-nav]');
        if (nav) show(page + (nav.dataset.nav === 'next' ? 1 : -1));
        const g = e.target.closest('[data-goto]');
        if (g) show(Math.floor(Number(g.dataset.goto) / pageSize));
      });

      // resume on the first page with an unanswered item
      const firstOpen = s.items.findIndex((it) => !answers.has(it.item_id));
      show(firstOpen > 0 ? Math.floor(firstOpen / pageSize) : 0, false);
      setStatus('saved');
      statusEl.textContent = answers.size ? t('run.resumed') : '';
    },
  };
}
