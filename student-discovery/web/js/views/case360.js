import { h, mount } from '../html.js';
import { get, post, patch, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { num, date, shortHash } from '../format.js';
import { bars, chip, eligibilityChip, verificationChip, moduleChip, notice } from '../components/ui.js';
import { programIndex, DIMS } from '../components/data.js';
import { render } from '../router.js';
import { announce } from '../a11y.js';

const TABS = ['overview', 'results', 'evidence', 'recos', 'cases', 'notes', 'reports', 'raw'];
let activeTab = 'overview';

export default async function view({ params, query }) {
  const sid = params.id;
  const purpose = query.purpose || 'case_review';
  const d = await get(`${BASE}/students/${sid}/case360?purpose=${encodeURIComponent(purpose)}`);
  const idx = await programIndex();
  const P = d.profile;
  const st = P.student;
  const lastSession = (instrument) => [...d.sessions].reverse().find((s) => s.instrument_id === instrument && s.status === 'submitted');
  const reco = d.latest_recommendation ? await get(`${BASE}/recommendations/${d.latest_recommendation.id}`) : null;
  const interestRun = P.panels.expressed_interests;

  const panels = {
    overview: h`<div class="grid two"><section class="card"><h3>${t('c360.modules')}</h3><ul>${P.modules.map((m) => h`<li>${loc(m.name)} ${moduleChip(m.status)} <span class="small muted">(${num(m.attempts)} ${t('c360.attempts')})</span></li>`)}</ul></section>
      <section class="card"><h3>${t('c360.consent')}</h3><ul>${Object.entries(P.consent.scopes).map(([k, v]) => h`<li>${t(`scope.${k}.title`)}: ${chip(v.active ? 'ok' : 'warn', v.active ? '✓' : '○', t(`consent.status.${v.status}`))}</li>`)}</ul></section></div>
      <section class="card"><h3>${t('c360.completeness')}</h3><p>${t('results.completeness.modules', { a: num(P.completeness.modules_sealed), b: num(P.completeness.modules_total) })} · ${t('results.completeness.evidence', { a: num(P.completeness.academic_evidence_present), b: num(P.completeness.academic_evidence_total), v: num(P.completeness.academic_evidence_verified) })}</p></section>`,

    results: h`${interestRun.status === 'sealed' ? h`<section class="card"><h3>${t('results.interests.title')}</h3>
      ${bars(DIMS.map((x) => ({ x, c: interestRun.construct_scores[`RIASEC_${x}`] })).map(({ x, c }) => ({ label: t(`dim.${x}.name`), value: c.status === 'ok' ? c.display_0_100 : null, valueText: c.status === 'ok' ? num(c.display_0_100) : '' })))}
      <p class="small muted">${t('c360.provenance')}: <code>${interestRun.algorithm_version}</code> · <code>${shortHash(interestRun.score_run_id)}</code></p>
      <div class="row"><button class="btn secondary small" type="button" data-replay="${lastSession('interest_exploratory')?.id}">${t('results.replay')}</button><span id="replay-out" class="small" role="status"></span></div></section>
      <section class="card"><h3>${t('c360.override.title')}</h3><p class="small muted">${t('c360.override.note')}</p>
        <form id="override-form" class="stack" novalidate><div class="field"><label for="ov-text">${t('c360.override.text')}</label><textarea id="ov-text" name="text" maxlength="1000"></textarea></div>
          <div class="field"><label for="ov-reason">${t('c360.override.reason')}</label><input type="text" id="ov-reason" name="reason" maxlength="1000"><span class="hint">${t('c360.override.reason_hint')}</span></div>
          <div class="field"><label for="ov-vis">${t('c360.visibility')}</label><select id="ov-vis" name="visibility"><option value="counselor_only">${t('vis.counselor_only')}</option><option value="student">${t('vis.student')}</option></select></div>
          <p id="ov-msg" class="error-text" role="alert"></p><button class="btn" type="submit">${t('c360.override.sign')}</button></form>
        ${d.overrides.length ? h`<h4>${t('c360.override.existing')}</h4><ul>${d.overrides.map((o) => h`<li>“${o.text}” <span class="small muted">— ${t('c360.reason')}: ${o.reason} · ${t(`vis.${o.visibility}`)} · ${date(o.created_at, true)}</span></li>`)}</ul>` : ''}</section>`
      : notice('warn', h`<p>${t('results.interests.none')}</p>`)}`,

    evidence: h`<section class="card"><p class="small muted">${t('c360.evidence.note')}</p><div class="table-wrap"><table><thead><tr><th>${t('c360.evidence.type')}</th><th class="num">${t('c360.evidence.value')}</th><th>${t('c360.evidence.state')}</th><th>${t('c360.evidence.action')}</th></tr></thead><tbody>
      ${P.evidence.map((e) => h`<tr><th scope="row">${e.type.startsWith('subject_grade:') ? t('evidence.grade_in', { name: t(`subj.${e.type.split(':')[1]}`) }) : t(`evidence.${e.type}`)}</th><td class="num">${e.type === 'pathway' ? t(`pathway.${e.value}`) : num(e.value)}</td><td>${verificationChip(e.verification_state)}</td>
        <td>${e.verification_state === 'unverified' ? h`<form class="row" data-verify="${e.id}"><label class="visually-hidden" for="vn-${e.id}">${t('c360.evidence.note_label')}</label><input type="text" id="vn-${e.id}" placeholder="${t('c360.evidence.note_ph')}" maxlength="500"><button class="btn small" type="submit">${t('c360.evidence.verify')}</button></form>` : h`<span class="small muted">${e.verified_at ? date(e.verified_at) : ''}</span>`}</td></tr>`)}
      </tbody></table></div><p id="ev-msg" class="error-text" role="alert"></p></section>`,

    recos: reco ? h`<section class="card"><p>${t('majors.generated', { d: date(reco.created_at, true) })} · <code>${reco.catalog_snapshot_id}</code></p>
      <div class="chips">${Object.entries(reco.output.summary.by_eligibility).map(([k, n]) => h`<span>${eligibilityChip(k)} <strong>${num(n)}</strong></span>`)}</div>
      <h4>${t('c360.pinned')}</h4><ul>${P.aspirations.length ? P.aspirations.map((a) => h`<li>${loc(idx[a.program_id]?.official_name)} ${a.note ? h`<span class="small muted">“${a.note}”</span>` : ''} ${eligibilityChip(reco.output.items.find((i) => i.program_id === a.program_id)?.admission_status.eligibility ?? 'not_evaluated')}</li>`) : h`<li class="muted">${t('c360.none')}</li>`}</ul>
      <h4>${t('c360.top')}</h4><ol>${reco.output.items.filter((i) => i.rank_if_available).slice(0, 5).map((i) => h`<li>${loc(idx[i.program_id]?.official_name)} — ${num(i.interest_fit.value * 100)} ${eligibilityChip(i.admission_status.eligibility)}</li>`)}</ol></section>` : notice('', h`<p>${t('c360.no_reco')}</p>`),

    cases: h`<section class="card"><h3>${t('c360.cases')}</h3>
      ${d.cases.length ? d.cases.map((c) => h`<article class="card flat"><div class="row between"><strong>${t(`case.reason.${c.reason_code}`)}</strong>${chip({ open: 'info', in_review: 'info', resolved: 'ok' }[c.status], { open: '○', in_review: '◐', resolved: '✓' }[c.status], t(`case.status.${c.status}`))}</div>
        ${c.student_message ? h`<p>“${c.student_message}”</p>` : ''}${c.subject_ref ? h`<p class="small muted"><code>${c.subject_ref}</code></p>` : ''}
        ${c.status !== 'resolved' ? h`<form class="row" data-case="${c.id}"><label class="visually-hidden" for="cs-${c.id}">${t('c360.case.status')}</label><select id="cs-${c.id}" name="status"><option value="in_review">${t('case.status.in_review')}</option><option value="resolved">${t('case.status.resolved')}</option></select>
          <label class="visually-hidden" for="cr-${c.id}">${t('help.resolution')}</label><input type="text" id="cr-${c.id}" name="resolution" placeholder="${t('help.resolution')}" maxlength="500"><button class="btn small" type="submit">${t('common.save')}</button></form>` : h`<p class="small">${t('help.resolution')}: ${c.resolution}</p>`}</article>`) : h`<p class="muted">${t('c360.none')}</p>`}
      <h4>${t('c360.open_case')}</h4><form id="open-case" class="row"><label class="visually-hidden" for="oc-r">${t('help.type')}</label><select id="oc-r" name="reason">${['safeguarding_referral', 'parent_inquiry', 'follow_up', 'interpretation_dispute'].map((r) => h`<option value="${r}">${t(`case.reason.${r}`)}</option>`)}</select>
        <label class="visually-hidden" for="oc-m">${t('help.message')}</label><input type="text" id="oc-m" name="message" maxlength="500" placeholder="${t('help.message')}"><button class="btn small" type="submit">${t('c360.open_case')}</button></form></section>`,

    notes: h`<section class="card"><h3>${t('c360.notes')}</h3>
      <form id="note-form" class="stack" novalidate><div class="field"><label for="n-body">${t('c360.note.body')}</label><textarea id="n-body" name="body" maxlength="4000"></textarea></div>
        <div class="field"><label for="n-vis">${t('c360.visibility')}</label><select id="n-vis" name="visibility"><option value="counselor_only">${t('vis.counselor_only')}</option><option value="student">${t('vis.student')}</option></select></div>
        <p id="n-msg" class="error-text" role="alert"></p><button class="btn" type="submit">${t('c360.note.add')}</button></form>
      <ul class="stack">${d.notes.map((n) => h`<li class="card flat">${chip(n.visibility === 'student' ? 'info' : '', n.visibility === 'student' ? '◉' : '■', t(`vis.${n.visibility}`))} <span class="small muted">${date(n.created_at, true)}</span><p>${n.body}</p></li>`)}</ul></section>`,

    reports: h`<section class="card"><h3>${t('reports.title')}</h3>${d.reports.length ? h`<div class="table-wrap"><table><thead><tr><th>${t('reports.created')}</th><th>${t('reports.status')}</th><th>${t('reports.hash')}</th><th></th></tr></thead><tbody>
      ${d.reports.map((r) => h`<tr><td>${date(r.created_at, true)}</td><td>${chip({ draft: '', review_requested: 'warn', approved: 'ok', rejected: 'bad' }[r.status], '•', t(`report.status.${r.status}`))}</td><td><code>${shortHash(r.payload_hash)}</code></td><td><a class="btn small secondary" href="#/report/${r.id}">${r.status === 'review_requested' ? t('c360.review_report') : t('reports.open')}</a></td></tr>`)}</tbody></table></div>` : h`<p class="muted">${t('reports.none')}</p>`}</section>`,

    raw: h`<section class="card"><h3>${t('c360.raw.title')}</h3><p class="small muted">${t('c360.raw.note')}</p>
      ${d.sessions.filter((s) => s.status === 'submitted').map((s) => h`<div class="row"><button class="btn secondary small" type="button" data-raw="${s.id}">${t('c360.raw.show', { name: loc(P.modules.find((m) => m.instrument_id === s.instrument_id).name), n: num(s.attempt_no) })}</button></div>`)}
      <div id="raw-out" class="stack"></div></section>`,
  };

  return {
    title: t('c360.title'),
    body: h`<div class="stack"><p class="small"><a href="#/counselor">← ${t('queue.title')}</a></p>
      <div class="row between"><h1><bdi>${loc(st.display_name)}</bdi> <span class="muted small">${t('common.grade', { n: st.grade })}</span></h1></div>
      <div class="card flat small" role="note">${t('c360.logged', { purpose })}</div>
      <div class="tabs" role="tablist" aria-label="${t('c360.title')}">${TABS.map((k) => h`<button type="button" role="tab" id="tab-${k}" aria-controls="panel-${k}" aria-selected="${k === activeTab ? 'true' : 'false'}" tabindex="${k === activeTab ? 0 : -1}" data-tab="${k}">${t(`c360.tab.${k}`)}</button>`)}</div>
      ${TABS.map((k) => h`<div role="tabpanel" id="panel-${k}" aria-labelledby="tab-${k}" class="tabpanel stack" ${k === activeTab ? '' : 'hidden'}>${panels[k]}</div>`)}
    </div>`,
    after(root) {
      const tabs = [...root.querySelectorAll('[role=tab]')];
      const select = (k, focus) => {
        activeTab = k;
        tabs.forEach((b) => {
          const on = b.dataset.tab === k;
          b.setAttribute('aria-selected', String(on));
          b.tabIndex = on ? 0 : -1;
          root.querySelector(`#panel-${b.dataset.tab}`).hidden = !on;
          if (on && focus) b.focus();
        });
      };
      tabs.forEach((b) => {
        b.addEventListener('click', () => select(b.dataset.tab));
        b.addEventListener('keydown', (e) => {
          const i = tabs.indexOf(b);
          const rtl = document.documentElement.dir === 'rtl';
          const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
          if (step) {
            e.preventDefault();
            select(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
          } else if (e.key === 'Home') select(tabs[0].dataset.tab, true);
          else if (e.key === 'End') select(tabs.at(-1).dataset.tab, true);
        });
      });

      root.querySelector('[data-replay]')?.addEventListener('click', async (e) => {
        const r = await post(`${BASE}/sessions/${e.target.dataset.replay}/replay`, {});
        root.querySelector('#replay-out').textContent = r.match ? t('results.replay.ok', { h: shortHash(r.recomputed_hash) }) : t('results.replay.fail');
      });
      root.querySelector('#override-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        try {
          await post(`${BASE}/students/${sid}/overrides`, { score_run_id: interestRun.score_run_id, text: f.text.value, reason: f.reason.value, visibility: f.visibility.value });
          announce(t('c360.saved'));
          await render();
        } catch (err) {
          root.querySelector('#ov-msg').textContent = err.message;
        }
      });
      root.querySelectorAll('[data-verify]').forEach((f) =>
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await post(`${BASE}/students/${sid}/evidence/${f.dataset.verify}/verify`, { note: f.querySelector('input').value });
            announce(t('c360.saved'));
            await render();
          } catch (err) {
            root.querySelector('#ev-msg').textContent = err.code === 'note_required' ? t('c360.evidence.note_required') : err.message;
          }
        }),
      );
      root.querySelectorAll('[data-case]').forEach((f) =>
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await patch(`${BASE}/cases/${f.dataset.case}`, { status: f.status.value, resolution: f.resolution.value });
            await render();
          } catch (err) {
            announce(err.code === 'resolution_required' ? t('c360.resolution_required') : err.message, true);
          }
        }),
      );
      root.querySelector('#open-case')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await post(`${BASE}/students/${sid}/cases`, { reason_code: e.currentTarget.reason.value, message: e.currentTarget.message.value });
        await render();
      });
      root.querySelector('#note-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        try {
          await post(`${BASE}/students/${sid}/notes`, { body: f.body.value, visibility: f.visibility.value });
          await render();
        } catch (err) {
          root.querySelector('#n-msg').textContent = err.message;
        }
      });
      root.querySelectorAll('[data-raw]').forEach((b) =>
        b.addEventListener('click', async () => {
          const r = await get(`${BASE}/sessions/${b.dataset.raw}/responses`);
          const out = root.querySelector('#raw-out');
          mount(out, h`<div class="table-wrap"><table><thead><tr><th>${t('c360.raw.item')}</th><th class="num">${t('c360.raw.value')}</th></tr></thead><tbody>${r.answers.map((a) => h`<tr><td>${loc(a.content)} <code class="muted">${a.item_id}</code></td><td class="num">${a.value ?? '—'}</td></tr>`)}</tbody></table></div>`);
          announce(t('c360.raw.logged'));
        }),
      );
    },
  };
}
