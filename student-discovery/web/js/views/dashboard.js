import { h } from '../html.js';
import { get, post, BASE, uuid } from '../api.js';
import { t, getLocale, loc } from '../i18n.js';
import { myId } from '../state.js';
import { num, date } from '../format.js';
import { moduleChip, notice, chip } from '../components/ui.js';
import { go } from '../router.js';
import { announce } from '../a11y.js';

export default async function view({ query }) {
  const sid = myId();
  const profile = await get(`${BASE}/students/${sid}/discovery-profile`);
  const consentOk = profile.consent.scopes.assessment_processing.active;
  const mods = profile.modules;
  const ev = profile.completeness;
  const nextStep = mods.find((m) => m.usable && (m.status === 'in_progress')) ?? mods.find((m) => m.usable && m.status === 'not_started');

  return {
    title: t('dash.title'),
    body: h`<div class="stack">
      <h1>${t('dash.title')}</h1>
      ${query.done ? notice('accent', h`<strong>${t('dash.done', { name: loc(mods.find((m) => m.instrument_id === query.done)?.name) })}</strong>`) : ''}
      ${!consentOk ? h`<div class="card warn" role="alert"><strong>${t('dash.consent_missing.title')}</strong> ${t('dash.consent_missing.body')} <a href="#/consent">${t('dash.consent_missing.cta')}</a></div>` : ''}
      <p class="lead">${t('dash.lead')}</p>
      ${nextStep ? h`<p>${t('dash.next', { name: loc(nextStep.name) })}</p>` : ''}
      <div class="grid">
        ${mods.map((m, i) => {
          const pctDone = m.progress.total ? m.progress.answered / m.progress.total : 0;
          return h`<article class="card ${m.status === 'unavailable' ? 'disabled' : ''}" aria-labelledby="m-${m.instrument_id}">
            <div class="row between"><h2 id="m-${m.instrument_id}">${i + 1}. ${loc(m.name)}</h2>${moduleChip(m.status)}</div>
            <p>${loc(m.purpose)}</p>
            ${m.status === 'unavailable' ? h`<p><strong>${t('dash.on_hold')}</strong> ${loc(m.hold_reason)}</p>` : ''}
            ${m.status === 'needs_review' ? h`<p class="error-text">${t('dash.needs_review')}</p>` : ''}
            ${m.usable ? h`<p class="small muted">${m.duration_estimate_min ? t('dash.estimate', { min: num(m.duration_estimate_min) }) : ''} · ${t('dash.items', { n: num(m.items_total) })}</p>` : ''}
            ${m.status === 'in_progress' || m.status === 'completed' ? h`<label class="small" for="p-${m.instrument_id}">${t('dash.progress', { a: num(m.progress.answered), b: num(m.progress.total) })}</label>
              <progress id="p-${m.instrument_id}" max="${m.progress.total}" value="${m.progress.answered}">${Math.round(pctDone * 100)}%</progress>` : ''}
            ${m.blocked_reason === 'consent_required' ? h`<p class="error-text">${t('dash.paused_consent')}</p>` : ''}
            <div class="row">
              ${m.status === 'not_started' && m.usable ? h`<button class="btn" type="button" data-start="${m.instrument_version_id}" ${consentOk ? '' : 'disabled'}>${t('dash.start')}</button>` : ''}
              ${m.status === 'in_progress' && m.usable && !m.blocked_reason ? h`<a class="btn" href="#/run/${m.session_id}">${t('dash.resume')}</a>` : ''}
              ${m.status === 'completed' ? h`<a class="btn secondary" href="#/results">${t('dash.see_results')}</a>` : ''}
              ${m.can_retake ? h`<button class="btn secondary" type="button" data-start="${m.instrument_version_id}" ${consentOk ? '' : 'disabled'}>${t('dash.retake')}</button>` : ''}
              ${m.attempts ? h`<span class="small muted">${t('dash.attempts', { n: num(m.attempts) })}${m.last_submitted_at ? ` · ${date(m.last_submitted_at)}` : ''}</span>` : ''}
            </div>
          </article>`;
        })}
        <article class="card">
          <div class="row between"><h2>${t('dash.evidence.title')}</h2>${chip(ev.academic_evidence_present ? 'info' : '', ev.academic_evidence_present ? '◐' : '○', t('dash.evidence.count', { a: num(ev.academic_evidence_present), b: num(ev.academic_evidence_total) }))}</div>
          <p>${t('dash.evidence.body')}</p>
          <p class="small muted">${t('dash.evidence.verified', { n: num(ev.academic_evidence_verified) })}</p>
          <a class="btn secondary" href="#/evidence">${t('dash.evidence.cta')}</a>
        </article>
      </div>
      <section class="card"><h2>${t('dash.explore.title')}</h2><p>${t('dash.explore.body')}</p>
        <div class="row"><a class="btn" href="#/results">${t('nav.results')}</a><a class="btn secondary" href="#/majors">${t('nav.majors')}</a><a class="btn secondary" href="#/help">${t('dash.help')}</a></div></section>
      ${profile.journey.length ? h`<section class="card"><h2>${t('dash.journey.title')}</h2><ol>${profile.journey.slice(-6).reverse().map((j) => h`<li>${t(j.key)} <span class="small muted">· ${date(j.at, true)}</span></li>`)}</ol></section>` : ''}
    </div>`,
    after(root) {
      root.querySelectorAll('[data-start]').forEach((b) =>
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const s = await post(`${BASE}/sessions`, { instrument_version_id: b.dataset.start, locale: getLocale(), idempotency_key: uuid() });
            go(`/run/${s.session_id}`);
          } catch (e) {
            b.disabled = false;
            announce(e.message, true);
          }
        }),
      );
    },
  };
}
