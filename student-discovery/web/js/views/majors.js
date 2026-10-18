import { h, mount } from '../html.js';
import { get, post, put, del, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { myId } from '../state.js';
import { num, date } from '../format.js';
import { miniBar, chip, eligibilityChip, sourceChip, fictionalChip, notice } from '../components/ui.js';
import { getPrograms } from '../components/data.js';
import { go, render } from '../router.js';
import { announce } from '../a11y.js';

export const compareSel = new Set(); // survives navigation inside the SPA; never persisted

export function readinessChip(r) {
  if (r.status === 'not_required') return chip('', '–', t('readiness.not_required'));
  if (r.status === 'evidence_missing') return chip('warn', '…', t('readiness.evidence_missing'));
  return chip(r.status === 'assessed' ? 'ok' : 'info', r.status === 'assessed' ? '✓' : '◐', t(`readiness.${r.status}`, { a: num(r.met), b: num(r.total) }));
}

export function interestAxis(item) {
  const f = item.interest_fit;
  if (f.status === 'ok') return h`${miniBar(f.value * 100, num(f.value * 100))}<div class="small muted">${t('axis.interest_short')}</div>`;
  return h`${chip('warn', '…', t('axis.incomplete'))}<div class="small muted">${t(`fit.reason.${f.reason}`)}</div>`;
}

function card(item, prog, pinned, selected, selectionFull) {
  const src = item.admission_status.source_state;
  return h`<article class="card program-card" aria-labelledby="pc-${prog.program_id}">
    <div class="row between"><h3 id="pc-${prog.program_id}"><a href="#/program/${prog.program_id}">${loc(prog.official_name)}</a></h3>
      <span class="chips">${item.rank_if_available ? h`<span class="chip info">#${num(item.rank_if_available)}</span>` : ''}${fictionalChip()}</span></div>
    <p class="small muted">${loc(prog.university.name)} · ${loc(prog.cluster_name)} · ${t(`lang.${prog.instruction_language}`)}</p>
    <div class="axes">
      <div class="axis"><div class="t">${t('axis.interest')}</div>${interestAxis(item)}</div>
      <div class="axis"><div class="t">${t('axis.readiness')}</div>${readinessChip(item.capability_readiness)}</div>
      <div class="axis"><div class="t">${t('axis.eligibility')}</div>${eligibilityChip(item.admission_status.eligibility)}${src === 'conflicting' ? h`<div>${sourceChip(src)}</div>` : ''}</div>
    </div>
    ${item.tensions.length ? h`<div class="chips">${item.tensions.map((x) => chip('warn', '!', t(`tension.${x.key}`)))}</div>` : ''}
    <div class="row">
      <a class="btn small" href="#/program/${prog.program_id}">${t('majors.details')}</a>
      <button class="btn secondary small" type="button" data-pin="${prog.program_id}" aria-pressed="${pinned ? 'true' : 'false'}">${pinned ? '★ ' + t('majors.pinned') : '☆ ' + t('majors.pin')}</button>
      <label class="check"><input type="checkbox" data-cmp="${prog.program_id}" ${selected ? 'checked' : ''} ${!selected && selectionFull ? 'disabled' : ''}> ${t('majors.compare')}</label>
    </div>
  </article>`;
}

export default async function view() {
  const sid = myId();
  const [list, profile, progs] = await Promise.all([get(`${BASE}/students/${sid}/recommendations`), get(`${BASE}/students/${sid}/discovery-profile`), getPrograms()]);
  const run = list.length ? await get(`${BASE}/recommendations/${list[0].id}`) : null;
  const pinned = new Set(profile.aspirations.map((a) => a.program_id));
  const idx = Object.fromEntries(progs.map((p) => [p.program_id, p]));
  const canRun = profile.consent.scopes.assessment_processing.active;
  const clusters = [...new Map(progs.map((p) => [p.field_cluster, p.cluster_name])).entries()];
  const filters = { cluster: '', language: '', elig: '', pinned: false };

  return {
    title: t('majors.title'),
    body: h`<div class="stack">
      <h1>${t('majors.title')}</h1><p class="lead">${t('majors.lead')}</p>
      ${notice('warn', h`<strong>${t('majors.fictional.title')}</strong> ${t('majors.fictional.body')}`)}
      <div class="row"><button class="btn" type="button" id="gen" ${canRun ? '' : 'disabled'}>${run ? t('majors.refresh') : t('majors.generate')}</button>
        ${run ? h`<span class="small muted">${t('majors.generated', { d: date(run.created_at, true) })} · <code>${run.catalog_snapshot_id}</code></span>` : ''}</div>
      ${!canRun ? h`<p class="error-text">${t('dash.consent_missing.body')} <a href="#/consent">${t('dash.consent_missing.cta')}</a></p>` : ''}
      ${run?.recomputed && run.changes_since_previous.length ? h`<section class="card accent" aria-labelledby="chg"><h2 id="chg">${t('majors.changes.title')}</h2><p>${t('majors.changes.body')}</p>
        <ul>${run.changes_since_previous.slice(0, 8).map((c) => h`<li>${loc(idx[c.program_id]?.official_name)} — ${t(`change.${c.field}`)}${c.field === 'eligibility' ? h`: ${t(`elig.${c.from}`)} → ${t(`elig.${c.to}`)}` : ''}</li>`)}</ul></section>` : ''}
      ${!run ? h`<div class="card empty"><p>${t('majors.none')}</p></div>` : h`
        <form id="filters" class="card flat row" aria-label="${t('majors.filters')}">
          <div class="field"><label for="f-cluster">${t('majors.f.cluster')}</label><select id="f-cluster" name="cluster"><option value="">${t('common.all')}</option>${clusters.map(([k, v]) => h`<option value="${k}">${loc(v)}</option>`)}</select></div>
          <div class="field"><label for="f-lang">${t('majors.f.language')}</label><select id="f-lang" name="language"><option value="">${t('common.all')}</option><option value="ar">${t('lang.ar')}</option><option value="en">${t('lang.en')}</option></select></div>
          <div class="field"><label for="f-elig">${t('majors.f.elig')}</label><select id="f-elig" name="elig"><option value="">${t('common.all')}</option>${['verified_eligible', 'evidence_missing', 'manual_review_required', 'verified_ineligible', 'source_stale', 'not_evaluated'].map((e) => h`<option value="${e}">${t(`elig.${e}`)}</option>`)}</select></div>
          <div class="check"><input type="checkbox" id="f-pinned" name="pinned"><label for="f-pinned">${t('majors.f.pinned')}</label></div>
        </form>
        ${run.output.summary.with_interest_fit === 0 ? notice('warn', h`<strong>${t('majors.nofit.title')}</strong> ${t('majors.nofit.body')} <a href="#/dashboard">${t('results.go_modules')}</a>`) : ''}
        <p id="count" class="small muted" role="status"></p>
        <div id="list" class="grid two"></div>
        <div class="tray no-print" id="tray" hidden><div class="row between"><span id="tray-text"></span><button class="btn" type="button" id="do-compare">${t('majors.compare_go')}</button></div></div>`}
    </div>`,
    after(root) {
      root.querySelector('#gen')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        const r = await post(`${BASE}/students/${sid}/recommendations`, {});
        announce(r.reused ? t('majors.unchanged') : t('majors.updated'));
        await render();
      });
      if (!run) return;
      const listEl = root.querySelector('#list');
      const tray = root.querySelector('#tray');
      const redraw = () => {
        const items = run.output.items.filter((i) => {
          const p = idx[i.program_id];
          return (!filters.cluster || p.field_cluster === filters.cluster) && (!filters.language || p.instruction_language === filters.language || p.instruction_language === 'both') && (!filters.elig || i.admission_status.eligibility === filters.elig) && (!filters.pinned || pinned.has(i.program_id));
        });
        root.querySelector('#count').textContent = t('majors.count', { a: num(items.length), b: num(run.output.items.length) });
        mount(listEl, items.length ? items.map((i) => card(i, idx[i.program_id], pinned.has(i.program_id), compareSel.has(i.program_id), compareSel.size >= 3)) : h`<div class="card empty">${t('majors.nomatch')}</div>`);
        tray.hidden = compareSel.size === 0;
        root.querySelector('#tray-text').textContent = t('majors.tray', { n: num(compareSel.size) });
        root.querySelector('#do-compare').disabled = compareSel.size < 2;
      };
      redraw();
      root.querySelector('#filters').addEventListener('change', (e) => {
        const f = e.currentTarget;
        Object.assign(filters, { cluster: f.cluster.value, language: f.language.value, elig: f.elig.value, pinned: f.pinned.checked });
        redraw();
      });
      root.querySelector('#filters').addEventListener('submit', (e) => e.preventDefault());
      root.querySelector('#do-compare').addEventListener('click', () => go(`/compare?ids=${[...compareSel].join(',')}`));
      listEl.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-cmp]');
        if (!cb) return;
        cb.checked ? compareSel.add(cb.dataset.cmp) : compareSel.delete(cb.dataset.cmp);
        redraw();
        root.querySelector(`[data-cmp="${cb.dataset.cmp}"]`)?.focus();
      });
      listEl.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-pin]');
        if (!b) return;
        const id = b.dataset.pin;
        try {
          if (pinned.has(id)) {
            await del(`${BASE}/students/${sid}/aspirations/${id}`);
            pinned.delete(id);
          } else {
            await put(`${BASE}/students/${sid}/aspirations/${id}`, {});
            pinned.add(id);
          }
          announce(pinned.has(id) ? t('majors.pin_on') : t('majors.pin_off'));
          redraw();
          root.querySelector(`[data-pin="${id}"]`)?.focus();
        } catch (err) {
          announce(err.status === 409 ? t('majors.pin_limit') : err.message, true);
        }
      });
    },
  };
}

