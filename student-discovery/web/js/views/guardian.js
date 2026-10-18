import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { state } from '../state.js';
import { date } from '../format.js';
import { moduleChip, chip, notice } from '../components/ui.js';
import { reportChip } from './reports.js';
import { render } from '../router.js';
import { announce } from '../a11y.js';

export default async function view({ query }) {
  const kids = state.me.linked_students ?? [];
  const child = kids.find((k) => k.id === query.student) ?? kids[0];
  if (!child) return { title: t('guardian.title'), body: h`<div class="stack"><h1>${t('guardian.title')}</h1>${notice('warn', h`<p>${t('guardian.no_child')}</p>`)}</div>` };
  // For an adult student the guardian has no say in consent (the server answers 403); they only see what is shared.
  let consent = null;
  try {
    consent = await get(`${BASE}/students/${child.id}/consent`);
  } catch (e) {
    if (e.status !== 403) throw e;
  }
  const proc = consent?.scopes.assessment_processing;
  let summary = null;
  let denied = null;
  try {
    summary = await get(`${BASE}/students/${child.id}/guardian-summary`);
  } catch (e) {
    if (e.status !== 403) throw e;
    denied = e.reason;
  }
  const guardianState = proc?.parties.guardian.state;
  return {
    title: t('guardian.title'),
    body: h`<div class="stack"><h1>${t('guardian.title')}</h1>
      ${kids.length > 1 ? h`<nav aria-label="${t('guardian.children')}"><ul class="chips">${kids.map((k) => h`<li class="chips"><a class="btn ${k.id === child.id ? '' : 'secondary'} small" href="#/guardian?student=${k.id}" ${k.id === child.id ? h`aria-current="true"` : ''}><bdi>${loc(k.display_name)}</bdi></a></li>`)}</ul></nav>` : ''}
      <p class="lead">${t('guardian.lead', { name: loc(child.display_name) })}</p>
      ${proc ? h`      <section class="card accent" aria-labelledby="g-auth"><h2 id="g-auth">${t('guardian.auth.title')}</h2>
        <p>${t('guardian.auth.body')}</p>
        <p>${t('guardian.auth.student')}: ${chip(proc.parties.student.state === 'granted' ? 'ok' : 'warn', proc.parties.student.state === 'granted' ? '✓' : '…', t(`party.${proc.parties.student.state}`))}
           · ${t('guardian.auth.you')}: ${chip(guardianState === 'granted' ? 'ok' : guardianState === 'withdrawn' ? 'bad' : 'warn', guardianState === 'granted' ? '✓' : guardianState === 'withdrawn' ? '✕' : '…', t(`party.${guardianState}`))}</p>
        ${proc.required_parties.includes('guardian') ? '' : h`<p class="hint">${t('guardian.not_required')}</p>`}
        <div class="row">
          ${guardianState !== 'granted' ? h`<button class="btn" type="button" data-grant="true">${t('guardian.authorize')}</button>` : h`<button class="btn danger" type="button" data-grant="false">${t('guardian.withdraw')}</button>`}
        </div><p class="small muted">${t('guardian.auth.note')}</p></section>` : h`<section class="card" role="note"><p>${t('guardian.adult')}</p></section>`}
      ${summary ? h`
        <section class="card" aria-labelledby="g-sum"><h2 id="g-sum">${t('guardian.summary.title')}</h2>
          <ul>${summary.modules.map((m) => h`<li>${loc(m.name)} ${moduleChip(m.status)}</li>`)}</ul>
          ${summary.top_interests ? h`<p><strong>${t('results.interests.top')}</strong> ${summary.top_interests.map((x) => loc(x.name)).join(t('common.list_sep'))}</p><p class="small muted">${t('guardian.interests_note')}</p>` : h`<p class="muted">${t('guardian.no_results')}</p>`}
        </section>
        <section class="card" aria-labelledby="g-rep"><h2 id="g-rep">${t('guardian.reports.title')}</h2>
          ${summary.reports.filter((r) => r.shared).length ? h`<ul>${summary.reports.filter((r) => r.shared).map((r) => h`<li><a href="#/report/${r.id}">${t('guardian.reports.open', { d: date(r.created_at) })}</a> ${reportChip('approved')}</li>`)}</ul>` : h`<p class="muted">${t('guardian.reports.none')}</p>`}
        </section>`
      : h`<section class="card warn" role="note"><h2>${t('guardian.noaccess.title')}</h2><p>${t(`deny.${denied}`) === `deny.${denied}` ? t('guardian.noaccess.body') : t(`deny.${denied}`)}</p></section>`}
      <section class="card flat"><h2>${t('guardian.cannot.title')}</h2><ul>${[1, 2, 3].map((i) => h`<li>${t(`guardian.cannot.${i}`)}</li>`)}</ul></section>
    </div>`,
    after(root) {
      root.querySelectorAll('[data-grant]').forEach((b) =>
        b.addEventListener('click', async () => {
          await post(`${BASE}/students/${child.id}/consent`, { scope: 'assessment_processing', granted: b.dataset.grant === 'true' });
          announce(t('consent.saved'));
          await render();
        }),
      );
    },
  };
}
