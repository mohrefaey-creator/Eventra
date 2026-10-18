import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t } from '../i18n.js';
import { myId } from '../state.js';
import { date } from '../format.js';
import { chip } from '../components/ui.js';
import { announce } from '../a11y.js';
import { render } from '../router.js';

const SCOPES = ['assessment_processing', 'counselor_sharing', 'guardian_summary_sharing', 'advisor_explanation', 'aggregate_analytics'];
const statusChip = (s) => chip({ active: 'ok', pending: 'warn', withdrawn: 'bad', inactive: '' }[s] ?? '', { active: '✓', pending: '…', withdrawn: '✕', inactive: '○' }[s] ?? '○', t(`consent.status.${s}`));

export default async function view() {
  const sid = myId();
  const c = await get(`${BASE}/students/${sid}/consent`);
  return {
    title: t('consent.title'),
    body: h`<div class="stack">
      <h1>${t('consent.title')}</h1>
      <div class="card accent"><h2>${t('consent.summary.title')}</h2>
        <ul>${[1, 2, 3, 4].map((i) => h`<li>${t(`consent.summary.${i}`)}</li>`)}</ul>
        <details><summary>${t('consent.details.title')}</summary>${[1, 2, 3, 4, 5].map((i) => h`<p>${t(`consent.details.${i}`)}</p>`)}
          <p class="small muted">${t('consent.policy', { v: c.policy_version })} · ${t('consent.basis')}: <code>${c.legal_basis_ref}</code></p></details>
      </div>
      <form id="consent-form" class="stack" novalidate>
        ${SCOPES.map((s) => {
          const sc = c.scopes[s];
          const mine = sc.parties.student.state === 'granted';
          const needsGuardian = sc.required_parties.includes('guardian');
          return h`<fieldset>
            <legend>${t(`scope.${s}.title`)} ${s === 'assessment_processing' ? chip('info', '!', t('consent.required_for_assessment')) : chip('', '○', t('consent.optional'))} ${statusChip(sc.status)}</legend>
            <p>${t(`scope.${s}.body`)}</p>
            <div class="check"><input type="checkbox" id="sc-${s}" name="${s}" data-was="${mine}" ${mine ? 'checked' : ''}>
              <label for="sc-${s}">${t('consent.assent', { what: t(`scope.${s}.title`) })}</label></div>
            <p class="error-text" data-warn="${s}" hidden role="status">${t('consent.withdraw_warning')}</p>
            ${needsGuardian ? h`<p class="hint">${t('consent.guardian_row')}: ${statusChip(sc.parties.guardian.state === 'granted' ? 'active' : sc.parties.guardian.state === 'withdrawn' ? 'withdrawn' : 'pending')}
              ${sc.parties.guardian.state !== 'granted' ? t('consent.guardian_ask') : ''}</p>` : ''}
            ${sc.parties.student.at ? h`<p class="small muted">${t('consent.last_change', { d: date(sc.parties.student.at, true) })}</p>` : ''}
          </fieldset>`;
        })}
        <div class="row"><button class="btn" type="submit">${t('consent.save')}</button><a class="btn secondary" href="#/dashboard">${t('common.continue')}</a></div>
        <p class="hint">${t('consent.no_coercion')}</p>
        <p id="consent-msg" role="status" class="hint"></p>
      </form>
    </div>`,
    after(root) {
      const form = root.querySelector('#consent-form');
      form.addEventListener('change', (e) => {
        const cb = e.target;
        const warn = form.querySelector(`[data-warn="${cb.name}"]`);
        if (warn) warn.hidden = !(cb.dataset.was === 'true' && !cb.checked);
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const changes = [...form.querySelectorAll('input[type=checkbox]')].filter((cb) => (cb.dataset.was === 'true') !== cb.checked);
        if (!changes.length) return void (root.querySelector('#consent-msg').textContent = t('consent.nochange'));
        for (const cb of changes) await post(`${BASE}/students/${sid}/consent`, { scope: cb.name, granted: cb.checked });
        announce(t('consent.saved'));
        await render();
        document.getElementById('consent-msg').textContent = t('consent.saved');
      });
    },
  };
}
