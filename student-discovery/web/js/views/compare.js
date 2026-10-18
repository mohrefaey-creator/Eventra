import { h } from '../html.js';
import { get, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { myId } from '../state.js';
import { num, date } from '../format.js';
import { eligibilityChip, sourceChip, fictionalChip, chip, notice } from '../components/ui.js';
import { programIndex } from '../components/data.js';
import { readinessChip } from './majors.js';

const align = (a) => (a.status === 'ok' ? h`<strong>${num(a.value * 100)}</strong>` : h`${chip('warn', '…', t('axis.incomplete'))}<div class="small muted">${a.missing?.length ? t('compare.missing_n', { n: num(a.missing.length) }) : ''}</div>`);

export default async function view({ query }) {
  const ids = String(query.ids ?? '').split(',').filter(Boolean).slice(0, 3);
  const sid = myId();
  const [list, idx] = await Promise.all([get(`${BASE}/students/${sid}/recommendations`), programIndex()]);
  if (!list.length || ids.length < 2) {
    return { title: t('compare.title'), body: h`<div class="stack"><h1>${t('compare.title')}</h1>${notice('warn', h`<p>${t('compare.need_two')}</p><a class="btn" href="#/majors">${t('nav.majors')}</a>`)}</div>` };
  }
  const run = await get(`${BASE}/recommendations/${list[0].id}`);
  const cols = ids.map((id) => ({ item: run.output.items.find((i) => i.program_id === id), prog: idx[id] })).filter((c) => c.item && c.prog);
  const row = (label, cell, hint) => h`<tr><th scope="row">${label}${hint ? h`<div class="small muted">${hint}</div>` : ''}</th>${cols.map((c) => h`<td>${cell(c.item, c.prog)}</td>`)}</tr>`;
  return {
    title: t('compare.title'),
    body: h`<div class="stack"><h1>${t('compare.title')}</h1><p class="lead">${t('compare.lead')}</p>
      <div class="table-wrap"><table><caption class="visually-hidden">${t('compare.title')}</caption>
        <thead><tr><td></td>${cols.map((c) => h`<th scope="col"><a href="#/program/${c.prog.program_id}">${loc(c.prog.official_name)}</a><div class="small muted">${loc(c.prog.university.name)}</div>${fictionalChip()}</th>`)}</tr></thead>
        <tbody>
          ${row(t('axis.interest'), (i) => (i.interest_fit.status === 'ok' ? h`<strong>${num(i.interest_fit.value * 100)}</strong> <span class="small muted">${t('compare.rank', { n: num(i.rank_if_available) })}</span>` : chip('warn', '…', t('axis.incomplete'))), t('compare.interest_hint'))}
          ${row(t('compare.subjects'), (i) => align(i.subject_alignment))}
          ${row(t('compare.values'), (i) => align(i.work_values_alignment))}
          ${row(t('compare.skills'), (i) => align(i.self_reported_skills_alignment), t('compare.skills_hint'))}
          ${row(t('axis.readiness'), (i) => h`${readinessChip(i.capability_readiness)}<ul class="small">${i.capability_readiness.items.map((x) => h`<li>${t(`subj.${x.subject}`)}: ${x.grade === null ? '—' : num(x.grade)} / ${num(x.min_grade)}</li>`)}</ul>`)}
          ${row(t('axis.eligibility'), (i) => h`${eligibilityChip(i.admission_status.eligibility)}<ul class="small">${i.admission_status.conditions.map((c) => h`<li>${t(`evidence.${c.key}`)}: ${t(`cond.${c.result}`)}</li>`)}</ul>`)}
          ${row(t('compare.source'), (i) => h`${sourceChip(i.admission_status.source_state)}<div class="small muted">${i.admission_status.source ? t('compare.review_due', { d: date(i.admission_status.source.review_due_at) }) : ''}</div>`)}
          ${row(t('compare.language'), (i, p) => t(`lang.${p.instruction_language}`))}
          ${row(t('compare.tensions'), (i) => (i.tensions.length ? h`<ul>${i.tensions.map((x) => h`<li>${t(`tension.${x.key}`)}</li>`)}</ul>` : '—'))}
        </tbody></table></div>
      <p class="small muted">${t('compare.note')}</p>
      <a class="btn secondary" href="#/majors">← ${t('nav.majors')}</a></div>`,
  };
}
