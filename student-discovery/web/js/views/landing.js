import { h } from '../html.js';
import { get, BASE } from '../api.js';
import { t } from '../i18n.js';
import { myId } from '../state.js';
import { num } from '../format.js';
import { chip } from '../components/ui.js';

export default async function view() {
  const consent = await get(`${BASE}/students/${myId()}/consent`);
  const active = consent.scopes.assessment_processing.active;
  const pending = consent.scopes.assessment_processing.pending;
  return {
    title: t('landing.title'),
    body: h`<div class="stack">
      <section class="hero">
        <h1>${t('landing.title')}</h1>
        <p class="lead">${t('landing.lead')}</p>
        <div class="row">
          <a class="btn" href="#/${active ? 'dashboard' : 'consent'}">${active ? t('landing.cta.continue') : t('landing.cta.start')}</a>
          <span class="muted">${t('landing.time', { min: num(17) })}</span>
        </div>
        ${!active && pending.length ? h`<p class="hint">${t('landing.consent_needed')}</p>` : ''}
      </section>
      <div class="grid">
        <section class="card"><h2>${t('landing.what.title')}</h2><ul>${[1, 2, 3, 4].map((i) => h`<li>${t(`landing.what.${i}`)}</li>`)}</ul></section>
        <section class="card"><h2>${t('landing.privacy.title')}</h2><ul>${[1, 2, 3, 4].map((i) => h`<li>${t(`landing.privacy.${i}`)}</li>`)}</ul></section>
        <section class="card"><h2>${t('landing.not.title')}</h2><ul>${[1, 2, 3, 4].map((i) => h`<li>${t(`landing.not.${i}`)}</li>`)}</ul></section>
      </div>
      <p>${chip('info', 'i', t('landing.nopass'))}</p>
    </div>`,
  };
}
