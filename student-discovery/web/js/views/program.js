import { h, mount } from '../html.js';
import { get, post, put, del, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { myId } from '../state.js';
import { num, date } from '../format.js';
import { eligibilityChip, sourceChip, fictionalChip, notice, spinner } from '../components/ui.js';
import { advisorBlocks } from '../components/advisor.js';
import { programIndex, missingLabel } from '../components/data.js';
import { readinessChip, interestAxis } from './majors.js';
import { announce } from '../a11y.js';

export default async function view({ params }) {
  const sid = myId();
  const [detail, adm, list, profile, idx] = await Promise.all([
    get(`${BASE}/programs/${params.pid}`),
    get(`${BASE}/programs/${params.pid}/admissions`),
    get(`${BASE}/students/${sid}/recommendations`),
    get(`${BASE}/students/${sid}/discovery-profile`),
    programIndex(),
  ]);
  const run = list.length ? await get(`${BASE}/recommendations/${list[0].id}`) : null;
  const item = run?.output.items.find((i) => i.program_id === params.pid) ?? null;
  let pinned = profile.aspirations.some((a) => a.program_id === params.pid);
  const a = item?.admission_status;
  const src = adm.rule?.source;

  return {
    title: loc(detail.official_name),
    body: h`<div class="stack">
      <p class="small"><a href="#/majors">← ${t('nav.majors')}</a></p>
      <div class="row between"><h1>${loc(detail.official_name)}</h1><span class="chips">${fictionalChip()}${sourceChip(adm.source_state)}</span></div>
      <p class="muted">${loc(detail.university.name)} · ${loc(detail.university.city)} · ${loc(detail.cluster_name)} · ${t(`lang.${detail.instruction_language}`)} · <code>${detail.taxonomy_code}</code></p>
      ${notice('warn', h`${t('program.synthetic_note')}`)}
      <div class="row"><button class="btn secondary" type="button" id="pin" aria-pressed="${pinned ? 'true' : 'false'}"></button>
        <a class="btn secondary" href="#/help?subject=program:${detail.program_id}">${t('program.ask_counselor')}</a></div>

      ${item ? h`
      <section class="card accent" aria-labelledby="why"><h2 id="why">${t('program.why.title')}</h2>
        <div class="axes"><div class="axis"><div class="t">${t('axis.interest')}</div>${interestAxis(item)}</div>
          <div class="axis"><div class="t">${t('axis.readiness')}</div>${readinessChip(item.capability_readiness)}</div>
          <div class="axis"><div class="t">${t('axis.eligibility')}</div>${eligibilityChip(a.eligibility)}</div></div>
        ${item.interest_fit.status === 'ok' ? h`<p>${t('program.why.body')}</p>
          <div class="table-wrap"><table><caption class="visually-hidden">${t('program.why.title')}</caption><thead><tr><th>${t('program.dim')}</th><th class="num">${t('program.you')}</th><th class="num">${t('program.program')}</th><th class="num">${t('program.contribution')}</th></tr></thead><tbody>
          ${item.interest_fit.contributions.map((c) => h`<tr><th scope="row">${t(`dim.${c.dimension}.name`)}</th><td class="num">${num(c.student_display)}</td><td class="num">${num(c.program_value)}</td>
            <td class="num"><span aria-hidden="true">${c.share > 0.0005 ? '▲' : c.share < -0.0005 ? '▼' : '•'}</span> ${num(c.share * 100, 1)} <span class="visually-hidden">${c.share > 0 ? t('program.aligned') : t('program.divergent')}</span></td></tr>`)}
          </tbody></table></div><p class="small muted">${t('program.why.method')}</p>` : h`<p>${t('program.why.incomplete')}</p>`}
        <p class="small muted">${t('program.composite_none')}</p>
        ${item.tensions.length ? h`<h3>${t('program.tensions')}</h3><ul>${item.tensions.map((x) => h`<li>${t(`tension.${x.key}`)}</li>`)}</ul>` : ''}
        ${item.missing_inputs.length ? h`<h3>${t('program.missing')}</h3><ul>${item.missing_inputs.map((m) => h`<li>${missingLabel(m)}</li>`)}</ul>` : ''}
      </section>

      <section class="card" aria-labelledby="ready"><h2 id="ready">${t('program.readiness.title')}</h2>
        <p>${t('program.readiness.body')}</p>
        ${item.capability_readiness.items.length ? h`<div class="table-wrap"><table><thead><tr><th>${t('program.subject')}</th><th class="num">${t('program.required_min')}</th><th class="num">${t('program.your_grade')}</th><th>${t('program.status')}</th></tr></thead><tbody>
          ${item.capability_readiness.items.map((x) => h`<tr><th scope="row">${t(`subj.${x.subject}`)}</th><td class="num">${num(x.min_grade)}</td><td class="num">${x.grade === null ? '—' : num(x.grade)}</td><td>${t(`cond.${x.result}`)}</td></tr>`)}</tbody></table></div>` : h`<p class="muted">${t('readiness.not_required')}</p>`}
        <p class="small muted">${t('program.aptitude_hold')}</p></section>

      <section class="card" aria-labelledby="adm"><h2 id="adm">${t('program.admission.title')}</h2>
        <p>${eligibilityChip(a.eligibility)} ${a.competitive ? h`<span class="small muted">${t('program.competitive')}</span>` : ''}</p>
        <p>${t(a.message_key.replace('admission.readiness.', 'adm.msg.'))}</p>
        ${a.conditions.length ? h`<div class="table-wrap"><table><thead><tr><th>${t('program.condition')}</th><th class="num">${t('program.required')}</th><th class="num">${t('program.yours')}</th><th>${t('program.status')}</th></tr></thead><tbody>
          ${a.conditions.map((c) => h`<tr><th scope="row">${t(`evidence.${c.key}`)}</th><td class="num">${Array.isArray(c.required) ? c.required.map((p) => t(`pathway.${p}`)).join(t('common.list_sep')) : num(c.required)}</td><td class="num">${c.provided === null ? '—' : c.key === 'pathway' ? t(`pathway.${c.provided}`) : num(c.provided)}</td><td>${t(`cond.${c.result}`)}</td></tr>`)}</tbody></table></div>` : ''}
        ${adm.rule?.conflict_detail ? notice('bad', h`<strong>${t('program.conflict')}</strong> ${adm.rule.conflict_detail.note}`) : ''}
        <p><strong>${t('program.no_probability')}</strong></p>
        ${a.application_window ? h`<p class="small muted">${t('program.window', { a: date(a.application_window.opens), b: date(a.application_window.closes) })}</p>` : ''}
      </section>

      <section class="card" aria-labelledby="source"><h2 id="source">${t('program.source.title')}</h2>
        ${src ? h`<dl class="kv"><dt>${t('program.source.publisher')}</dt><dd>${src.publisher}</dd><dt>${t('program.source.url')}</dt><dd><code>${src.source_url}</code></dd>
          <dt>${t('program.source.published')}</dt><dd>${date(src.published_at)}</dd><dt>${t('program.source.captured')}</dt><dd>${date(src.captured_at)}</dd>
          <dt>${t('program.source.effective')}</dt><dd>${date(adm.rule.effective_from)} → ${date(adm.rule.effective_to)}</dd><dt>${t('program.source.review_due')}</dt><dd>${date(adm.rule.review_due_at)}</dd>
          <dt>${t('program.source.version')}</dt><dd>${num(adm.rule.version)} · ${t('program.source.cycle')} ${adm.cycle}</dd></dl>` : h`<p>${t('program.source.none')}</p>`}
        <p class="small muted">${t('program.source.note')}</p></section>

      <section class="card" aria-labelledby="adv"><h2 id="adv">${t('advisor.title')}</h2>
        ${profile.consent.scopes.advisor_explanation.active ? h`<button class="btn secondary" type="button" id="explain">${t('advisor.explain_program')}</button><div id="adv-out" class="stack"></div>` : h`<p class="hint">${t('advisor.needs_consent')}</p>`}</section>`
      : h`<div class="card empty"><p>${t('program.no_run')}</p><a class="btn" href="#/majors">${t('majors.generate')}</a></div>`}
    </div>`,
    after(root) {
      const pinBtn = root.querySelector('#pin');
      const paint = () => {
        pinBtn.setAttribute('aria-pressed', String(pinned));
        pinBtn.textContent = pinned ? '★ ' + t('majors.pinned') : '☆ ' + t('majors.pin');
      };
      paint();
      pinBtn.addEventListener('click', async () => {
        try {
          if (pinned) await del(`${BASE}/students/${sid}/aspirations/${params.pid}`);
          else await put(`${BASE}/students/${sid}/aspirations/${params.pid}`, {});
          pinned = !pinned;
          paint();
          announce(pinned ? t('majors.pin_on') : t('majors.pin_off'));
        } catch (e) {
          announce(e.status === 409 ? t('majors.pin_limit') : e.message, true);
        }
      });
      root.querySelector('#explain')?.addEventListener('click', async () => {
        const out = root.querySelector('#adv-out');
        mount(out, spinner());
        const r = await post(`${BASE}/students/${sid}/advisor/explain`, { topic: 'program', program_id: params.pid });
        mount(out, advisorBlocks(r, idx));
      });
    },
  };
}

