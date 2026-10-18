import { h, mount } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t } from '../i18n.js';
import { myId } from '../state.js';
import { num, date, shortHash } from '../format.js';
import { bars, chip, notice, eligibilityChip } from '../components/ui.js';
import { advisorBlocks } from '../components/advisor.js';
import { programIndex, DIMS, SUBJECT_KEYS, SKILL_KEYS, VALUE_KEYS } from '../components/data.js';
import { spinner } from '../components/ui.js';
import { announce } from '../a11y.js';

const incompletePanel = (title, why) => h`<section class="card"><h2>${title}</h2>${chip('warn', '…', t('results.incomplete'))}<p class="muted">${why}</p><a class="btn secondary" href="#/dashboard">${t('results.go_modules')}</a></section>`;

function riasecPanel(p, attempts) {
  if (p.status !== 'sealed') return incompletePanel(t('results.interests.title'), t('results.interests.none'));
  const cs = p.construct_scores;
  const rank = Object.fromEntries((p.ranking?.order ?? []).map((o) => [o.dimension, o]));
  const rows = DIMS.map((d) => ({ d, s: cs[`RIASEC_${d}`], r: rank[d] }))
    .sort((a, b) => (b.s.display_0_100 ?? -1) - (a.s.display_0_100 ?? -1) || DIMS.indexOf(a.d) - DIMS.indexOf(b.d))
    .map(({ d, s, r }) => ({
      label: h`${t(`dim.${d}.name`)} <span class="ltr muted small">(${d})</span>`,
      sub: r ? t('results.rank', { n: num(r.rank) }) + (r.tied_with.length ? ` · ${t('results.tied')}` : '') : '',
      value: s.status === 'ok' ? s.display_0_100 : null,
      valueText: s.status === 'ok' ? num(s.display_0_100) : '',
      emptyText: t('common.insufficient'),
    }));
  const top = p.ranking?.top ?? [];
  const answered = DIMS.reduce((a, d) => a + cs[`RIASEC_${d}`].n_answered, 0);
  return h`<section class="card accent" aria-labelledby="h-int"><h2 id="h-int">${t('results.interests.title')}</h2>
    <p>${t('results.interests.lead')}</p>
    <figure class="fig"><figcaption class="small muted">${t('results.interests.caption')}</figcaption>${bars(rows)}</figure>
    ${top.length ? h`<p><strong>${t('results.interests.top')}</strong> ${top.map((d) => t(`dim.${d}.name`)).join(t('common.list_sep'))}${top.length > 3 ? h` <span class="muted">(${t('results.tie_boundary')})</span>` : ''}</p>` : ''}
    ${p.ranking && !p.ranking.complete ? notice('warn', h`<strong>${t('results.partial.title')}</strong> ${t('results.partial.body')}`) : ''}
    <p class="small muted">${t('results.interests.evidence', { a: num(answered), d: date(p.executed_at, true) })}</p>
    <p class="small muted">${t('results.interests.limits')}</p>
    <div class="row"><button class="btn secondary small" type="button" id="replay">${t('results.replay')}</button><span id="replay-out" class="small" role="status"></span></div>
    <details><summary>${t('results.interests.about')}</summary><dl class="kv">${DIMS.map((d) => h`<dt>${t(`dim.${d}.name`)}</dt><dd>${t(`dim.${d}.blurb`)}</dd>`)}</dl></details>
    <details><summary>${t('results.provenance')}</summary><dl class="kv"><dt>${t('results.alg')}</dt><dd><code>${p.algorithm_version}</code></dd><dt>${t('results.score_run')}</dt><dd><code>${shortHash(p.score_run_id)}</code></dd>
      <dt>${t('results.norms')}</dt><dd>${t('results.norms_none')}</dd></dl></details>
    ${attempts.length > 1 ? h`<details><summary>${t('results.history', { n: num(attempts.length) })}</summary><p class="small muted">${t('results.history_note')}</p>
      <div class="table-wrap"><table><thead><tr><th>${t('results.attempt')}</th>${DIMS.map((d) => h`<th class="num"><span class="ltr">${d}</span></th>`)}</tr></thead><tbody>
      ${attempts.map((a, i) => h`<tr><th scope="row">${num(i + 1)} · ${date(a.executed_at)}${i === attempts.length - 1 ? h` <span class="chip ok small">${t('results.current')}</span>` : ''}</th>${DIMS.map((d) => h`<td class="num">${a.construct_scores[`RIASEC_${d}`].status === 'ok' ? num(a.construct_scores[`RIASEC_${d}`].display_0_100) : '—'}</td>`)}</tr>`)}
      </tbody></table></div></details>` : ''}
  </section>`;
}

function prefPanel(id, titleKey, leadKey, p, keys, prefix, scoreKey, alt) {
  if (p.status !== 'sealed') return incompletePanel(t(titleKey), t(`${leadKey}.none`));
  const rows = keys.map((k) => {
    const c = p.construct_scores[`${scoreKey}_${k}`];
    return { label: t(`${prefix}.${k}`), value: c.status === 'ok' ? c.value_0_1 * 100 : null, valueText: c.status === 'ok' ? num(c.value_0_1 * 100) : '', emptyText: c.status === 'not_applicable' ? t('common.not_applicable') : t('common.insufficient') };
  });
  return h`<section class="card" aria-labelledby="h-${id}"><h2 id="h-${id}">${t(titleKey)}</h2><p>${t(`${leadKey}.lead`)}</p>${bars(rows, { alt })}<p class="small muted">${t('results.sealed_on', { d: date(p.executed_at) })}</p></section>`;
}

export default async function view({ query }) {
  const sid = myId();
  const prof = await get(`${BASE}/students/${sid}/discovery-profile`);
  const P = prof.panels;
  const interestSession = prof.attempts.interest_exploratory?.at(-1)?.session_id ?? null;
  const overrides = interestSession ? (await get(`${BASE}/sessions/${interestSession}/score`)).overrides : [];
  const ev = prof.completeness;
  const advisorOn = prof.consent.scopes.advisor_explanation.active;
  const reco = P.admission_readiness;

  return {
    title: t('results.title'),
    body: h`<div class="stack">
      <h1>${t('results.title')}</h1>
      ${query.new ? notice('accent', h`<strong>${t('results.new')}</strong>`) : ''}
      <p class="lead">${t('results.lead')}</p>
      ${riasecPanel(P.expressed_interests, prof.attempts.interest_exploratory ?? [])}
      ${overrides.length ? h`<section class="card accent" aria-labelledby="h-co"><h2 id="h-co">${t('results.counselor.title')}</h2>${overrides.map((o) => h`<p>“${o.text}”</p>`)}<p class="small muted">${t('results.counselor.note')}</p></section>` : ''}
      <div class="grid two">
        ${prefPanel('subj', 'results.subjects.title', 'results.subjects', P.subject_preferences, SUBJECT_KEYS, 'subj', 'SUBJ')}
        ${prefPanel('val', 'results.values.title', 'results.values', P.work_values, VALUE_KEYS, 'value', 'VALUE')}
      </div>
      <div class="grid two">
        ${prefPanel('skl', 'results.skills.title', 'results.skills', P.self_reported_confidence, SKILL_KEYS, 'skill', 'SKILL', true)}
        <section class="card disabled" aria-labelledby="h-cap"><h2 id="h-cap">${t('results.capabilities.title')}</h2>
          ${chip('', '⏸', t('results.capabilities.status'))}
          <p>${t('results.capabilities.body')}</p><p class="small muted">${t('results.capabilities.note')}</p></section>
      </div>
      <div class="grid two">
        <section class="card" aria-labelledby="h-adm"><h2 id="h-adm">${t('results.admission.title')}</h2>
          ${reco.status === 'computed' ? h`<p>${t('results.admission.body', { d: date(reco.generated_at, true) })}</p><div class="chips">${Object.entries(reco.by_eligibility).map(([k, n]) => h`<span class="chip-wrap">${eligibilityChip(k)} <strong>${num(n)}</strong></span>`)}</div>`
            : h`<p>${chip('', '–', t('elig.not_evaluated'))}</p><p>${t('results.admission.none')}</p>`}
          <p class="small muted">${t('results.admission.note')}</p><a class="btn" href="#/majors">${t('nav.majors')}</a></section>
        <section class="card" aria-labelledby="h-comp"><h2 id="h-comp">${t('results.completeness.title')}</h2>
          <ul>
            <li>${t('results.completeness.modules', { a: num(ev.modules_sealed), b: num(ev.modules_total) })}</li>
            <li>${t('results.completeness.aptitude')}</li>
            <li>${t('results.completeness.evidence', { a: num(ev.academic_evidence_present), b: num(ev.academic_evidence_total), v: num(ev.academic_evidence_verified) })}</li>
          </ul><a class="btn secondary" href="#/evidence">${t('dash.evidence.cta')}</a></section>
      </div>
      <section class="card" aria-labelledby="h-adv"><h2 id="h-adv">${t('advisor.title')}</h2>
        <p>${t('advisor.lead')}</p>
        ${advisorOn ? h`<div class="row"><button class="btn secondary" type="button" data-explain="results">${t('advisor.explain_results')}</button><button class="btn secondary" type="button" data-explain="missing_evidence">${t('advisor.explain_missing')}</button></div><div id="advisor-out" class="stack"></div>`
          : h`<p class="hint">${t('advisor.needs_consent')} <a href="#/consent">${t('dash.consent_missing.cta')}</a></p>`}
      </section>
      <div class="row"><a class="btn" href="#/majors">${t('results.next.majors')}</a><a class="btn secondary" href="#/help?subject=${interestSession ? `session:${interestSession}` : ''}">${t('results.next.challenge')}</a><a class="btn secondary" href="#/report">${t('nav.report')}</a></div>
    </div>`,
    after(root) {
      root.querySelector('#replay')?.addEventListener('click', async () => {
        const out = root.querySelector('#replay-out');
        out.textContent = '…';
        const r = await post(`${BASE}/sessions/${interestSession}/replay`, {});
        out.textContent = r.match ? t('results.replay.ok', { h: shortHash(r.recomputed_hash) }) : t('results.replay.fail');
        announce(out.textContent);
      });
      root.querySelectorAll('[data-explain]').forEach((b) =>
        b.addEventListener('click', async () => {
          const out = root.querySelector('#advisor-out');
          mount(out, spinner());
          const [r, progs] = await Promise.all([post(`${BASE}/students/${sid}/advisor/explain`, { topic: b.dataset.explain }), programIndex()]);
          mount(out, advisorBlocks(r, progs));
        }),
      );
    },
  };
}
