import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { myId } from '../state.js';
import { num, date } from '../format.js';
import { eligibilityChip, fictionalChip, notice } from '../components/ui.js';
import { programIndex } from '../components/data.js';
import { announce } from '../a11y.js';

/** Derive deterministic next actions from the latest recommendation run (no new scoring here). */
function gapsFor(item) {
  const gaps = [];
  const a = item.admission_status;
  if (['source_stale', 'not_evaluated'].includes(a.eligibility) || a.source_state === 'conflicting') gaps.push({ key: `source:${a.source_state}`, owner: 'counselor', text: t('roadmap.gap.source', { state: t(`source.${a.source_state}`) }) });
  for (const c of a.conditions) {
    const name = t(`evidence.${c.key}`);
    if (c.result === 'unknown') gaps.push({ key: `add:${c.key}`, owner: 'student', link: '#/evidence', text: t('roadmap.gap.add', { name }) });
    else if (c.result.startsWith('unverified')) gaps.push({ key: `verify:${c.key}`, owner: 'counselor', text: t('roadmap.gap.verify', { name }) });
    else if (c.result === 'not_met') {
      gaps.push({ key: `short:${c.key}`, owner: 'student', text: c.key === 'pathway' ? t('roadmap.gap.pathway') : t('roadmap.gap.short', { name, req: num(c.required), have: num(c.provided), diff: num(c.required - c.provided, 1) }) });
    }
  }
  for (const r of item.capability_readiness.items) {
    const name = t(`subj.${r.subject}`);
    if (r.result === 'unknown') gaps.push({ key: `grade:${r.subject}`, owner: 'student', link: '#/evidence', text: t('roadmap.gap.add_grade', { name }) });
    else if (r.result.endsWith('not_met')) gaps.push({ key: `prep:${r.subject}`, owner: 'student', text: t('roadmap.gap.prep', { name, req: num(r.min_grade), have: num(r.grade) }) });
    else if (r.result.startsWith('unverified')) gaps.push({ key: `verify-grade:${r.subject}`, owner: 'counselor', text: t('roadmap.gap.verify', { name: t('evidence.grade_in', { name }) }) });
  }
  return gaps;
}

export default async function view() {
  const sid = myId();
  const [list, profile, idx, cases] = await Promise.all([get(`${BASE}/students/${sid}/recommendations`), get(`${BASE}/students/${sid}/discovery-profile`), programIndex(), get(`${BASE}/students/${sid}/cases`)]);
  const run = list.length ? await get(`${BASE}/recommendations/${list[0].id}`) : null;
  if (!run) return { title: t('roadmap.title'), body: h`<div class="stack"><h1>${t('roadmap.title')}</h1>${notice('warn', h`<p>${t('roadmap.need_run')}</p><a class="btn" href="#/majors">${t('majors.generate')}</a>`)}</div>` };
  const pinned = profile.aspirations.map((a) => a.program_id);
  const targets = (pinned.length ? pinned : run.output.items.filter((i) => i.rank_if_available).slice(0, 3).map((i) => i.program_id)).map((id) => run.output.items.find((i) => i.program_id === id)).filter(Boolean);
  const open = cases.filter((c) => c.status !== 'resolved');
  return {
    title: t('roadmap.title'),
    body: h`<div class="stack"><h1>${t('roadmap.title')}</h1><p class="lead">${pinned.length ? t('roadmap.lead_pinned') : t('roadmap.lead_top')}</p>
      ${notice('warn', h`${t('roadmap.note')}`)}
      ${targets.map((item) => {
        const p = idx[item.program_id];
        const gaps = gapsFor(item);
        return h`<section class="card" aria-labelledby="r-${item.program_id}"><div class="row between"><h2 id="r-${item.program_id}"><a href="#/program/${item.program_id}">${loc(p.official_name)}</a></h2><span class="chips">${fictionalChip()}${eligibilityChip(item.admission_status.eligibility)}</span></div>
          ${gaps.length ? h`<ul class="stack">${gaps.map((g) => h`<li>${g.text} <span class="chip ${g.owner === 'student' ? 'info' : ''}">${t(`roadmap.owner.${g.owner}`)}</span> ${g.link ? h`<a href="${g.link}">${t('roadmap.do_it')}</a>` : ''}</li>`)}</ul>`
            : h`<p>${t('roadmap.nogaps')}</p>`}
          <p class="small muted">${t('roadmap.aptitude')}</p></section>`;
      })}
      <section class="card accent"><h2>${t('roadmap.counselor.title')}</h2><p>${t('roadmap.counselor.body')}</p>
        ${open.length ? h`<p class="small">${t('roadmap.open_cases', { n: num(open.length) })}${open[0].next_review_at ? ` · ${t('roadmap.next_review', { d: date(open[0].next_review_at) })}` : ''}</p>` : ''}
        <button class="btn" type="button" id="meet">${t('roadmap.counselor.cta')}</button> <span id="meet-msg" role="status" class="hint"></span></section>
    </div>`,
    after(root) {
      root.querySelector('#meet').addEventListener('click', async (e) => {
        e.target.disabled = true;
        await post(`${BASE}/students/${sid}/cases`, { reason_code: 'help_request', message: t('roadmap.counselor.message'), subject_ref: `recommendation_run:${run.id}` });
        root.querySelector('#meet-msg').textContent = t('roadmap.counselor.sent');
        announce(t('roadmap.counselor.sent'));
      });
    },
  };
}
