import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { role } from '../state.js';
import { num, shortHash, date } from '../format.js';
import { chip } from '../components/ui.js';
import { render } from '../router.js';
import { announce } from '../a11y.js';

const STATES = ['draft', 'translation_review', 'expert_review', 'licensed_confirmed', 'psychometric_review', 'approved_for_pilot', 'pilot_validated', 'approved_for_production', 'retired'];

export default async function view() {
  const { items } = await get(`${BASE}/admin/instruments`);
  const canAct = role() === 'psychometric_lead';
  return {
    title: t('instr.title'),
    body: h`<div class="stack"><h1>${t('instr.title')}</h1><p class="lead">${t('instr.lead')}</p>
      <div class="card warn" role="note">${t('instr.notice')}</div>
      ${items.map((i) => {
        const g = i.governance;
        const rt = i.runtime;
        return h`<article class="card" aria-labelledby="i-${i.instrument_id}">
          <div class="row between"><h2 id="i-${i.instrument_id}">${loc(i.name)} <span class="muted small ltr">v${i.version}</span></h2>
            <span class="chips">${i.usability.usable ? chip('ok', '✓', t('instr.usable', { mode: t(`instr.mode.${i.usability.mode}`) })) : chip('bad', '✕', t(`instr.unusable.${i.usability.reason}`))}${rt.suspended ? chip('bad', '⏸', t('instr.suspended')) : ''}</span></div>
          <ol class="step-list" aria-label="${t('instr.state_machine')}">${STATES.map((s) => h`<li ${s === rt.state ? h`class="current" aria-current="step"` : ''}>${t(`instr.state.${s}`)}</li>`)}</ol>
          <dl class="kv">
            <dt>${t('instr.construct')}</dt><dd>${i.construct}</dd>
            <dt>${t('instr.items')}</dt><dd>${num(i.items_total)} · <code>${shortHash(i.item_bank_hash)}</code></dd>
            <dt>${t('instr.scoring')}</dt><dd><code>${i.scoring.version}</code></dd>
            <dt>${t('instr.license')}</dt><dd>${g.license.status} ${g.license.doc_ref ? '' : chip('warn', '!', t('instr.no_doc'))}</dd>
            <dt>${t('instr.usage')}</dt><dd>${i.usage_class}</dd>
            <dt>${t('instr.warning')}</dt><dd>${loc(g.interpretation_warning)}</dd>
            ${g.hold_reason ? h`<dt>${t('instr.hold')}</dt><dd>${loc(g.hold_reason)}</dd>` : ''}
          </dl>
          <details><summary>${t('instr.validation')}</summary><ul>${Object.entries(g.validation).map(([k, v]) => h`<li>${t(`instr.val.${k}`)}: ${chip(v === 'done' ? 'ok' : v === 'none' ? '' : 'warn', v === 'done' ? '✓' : '○', t(`instr.val.state.${v}`))}</li>`)}</ul></details>
          ${i.publication_blockers.length ? h`<details><summary>${t('instr.blockers', { n: num(i.publication_blockers.length) })}</summary><ul>${i.publication_blockers.map((b) => h`<li>${t(`blocker.${b}`) === `blocker.${b}` ? b : t(`blocker.${b}`)}</li>`)}</ul></details>` : ''}
          ${canAct ? h`<form class="row" data-form="${i.instrument_id}">
            <label class="visually-hidden" for="rs-${i.instrument_id}">${t('instr.reason')}</label><input type="text" id="rs-${i.instrument_id}" name="reason" placeholder="${t('instr.reason')}" maxlength="200">
            <button class="btn small secondary" type="submit" data-do="publish">${t('instr.publish')}</button>
            ${rt.suspended ? h`<button class="btn small" type="submit" data-do="resume">${t('instr.resume')}</button>` : h`<button class="btn small danger" type="submit" data-do="suspend" ${i.usage_class === 'hold' ? 'disabled' : ''}>${t('instr.suspend')}</button>`}
          </form><p class="error-text" id="msg-${i.instrument_id}" role="alert"></p>` : ''}
        </article>`;
      })}
      <p class="small muted">${t('instr.rendered', { d: date(new Date().toISOString(), true) })}</p></div>`,
    after(root) {
      root.querySelectorAll('[data-form]').forEach((f) => {
        let which = 'publish';
        f.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => (which = b.dataset.do)));
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          const id = f.dataset.form;
          const msg = root.querySelector(`#msg-${id}`);
          msg.textContent = '';
          try {
            const reason = f.reason.value;
            if (which === 'publish') await post(`${BASE}/admin/instruments/${id}/publish`, { target_state: 'approved_for_pilot', reason });
            else await post(`${BASE}/admin/instruments/${id}/${which}`, { reason });
            announce(t('c360.saved'));
            await render();
          } catch (err) {
            msg.textContent = err.code === 'publication_blocked' ? t('instr.blocked', { list: err.problem.blockers.map((b) => (t(`blocker.${b}`) === `blocker.${b}` ? b : t(`blocker.${b}`))).join('; ') }) : err.message;
            announce(msg.textContent, true);
          }
        });
      });
    },
  };
}
