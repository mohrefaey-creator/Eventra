import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { role, myId } from '../state.js';
import { date } from '../format.js';
import { sourceChip, chip, notice } from '../components/ui.js';
import { PATHWAYS } from '../components/data.js';
import { render } from '../router.js';
import { announce } from '../a11y.js';

const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const plus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

export default async function view() {
  const { items, cycle } = await get(`${BASE}/admin/program-rules`);
  const steward = role() === 'catalog_steward';
  const drafts = items.flatMap((i) => i.drafts.map((d) => ({ ...d, name: i.official_name })));
  return {
    title: t('cat.title'),
    body: h`<div class="stack"><h1>${t('cat.title')}</h1><p class="lead">${t('cat.lead', { cycle })}</p>
      ${notice('warn', h`${t('cat.notice')}`)}
      <div class="table-wrap"><table><caption class="visually-hidden">${t('cat.title')}</caption><thead><tr><th>${t('cat.program')}</th><th>${t('cat.source')}</th><th>${t('cat.publisher')}</th><th>${t('cat.review_due')}</th><th>${t('cat.version')}</th></tr></thead><tbody>
        ${items.map((i) => h`<tr><th scope="row">${loc(i.official_name)}<div class="small muted"><code>${i.program_id}</code></div></th><td>${sourceChip(i.source_state)}</td>
          <td class="small">${i.active ? i.active.source.publisher : '—'}</td><td>${i.active ? date(i.active.review_due_at) : '—'}</td>
          <td class="small">${i.versions.map((v) => `v${v.version} ${t(`rule.state.${v.state}`)}`).join(' · ') || '—'}</td></tr>`)}</tbody></table></div>

      <section class="card" aria-labelledby="dr"><h2 id="dr">${t('cat.drafts.title')}</h2>
        ${drafts.length ? h`<ul class="stack">${drafts.map((d) => h`<li class="card flat"><strong>${loc(d.name)}</strong> v${d.version} — ${t('cat.drafts.by')}: <code>${d.authored_by}</code>
          <div class="small muted">${d.rules.conditions.map((c) => `${t(`evidence.${c.key}`)}: ${Array.isArray(c.value) ? c.value.map((p) => t(`pathway.${p}`)).join(', ') : '≥ ' + c.value}`).join(' · ')}</div>
          ${steward ? (d.authored_by === myId() ? h`<p class="hint">${chip('', '✋', t('cat.fourEyes.self'))}</p>` : h`<button class="btn small" type="button" data-publish="${d.id}">${t('cat.publish')}</button>`) : ''}</li>`)}</ul>` : h`<p class="muted">${t('cat.drafts.none')}</p>`}
        <p id="pub-msg" class="error-text" role="alert"></p></section>

      ${steward ? h`<section class="card" aria-labelledby="nd"><h2 id="nd">${t('cat.new.title')}</h2><p class="small muted">${t('cat.new.note')}</p>
        <form id="draft-form" class="stack" novalidate>
          <div class="field"><label for="d-prog">${t('cat.program')}</label><select id="d-prog" name="program_id">${items.map((i) => h`<option value="${i.program_id}">${loc(i.official_name)}</option>`)}</select></div>
          <fieldset><legend>${t('cat.new.conditions')}</legend>
            <div class="field"><span id="pw-l">${t('evidence.pathway')}</span><div class="row" role="group" aria-labelledby="pw-l">${PATHWAYS.map((p) => h`<label class="check"><input type="checkbox" name="pw" value="${p}"> ${t(`pathway.${p}`)}</label>`)}</div></div>
            <div class="field"><label for="d-sec">${t('evidence.secondary_percentage')}</label><input type="number" id="d-sec" name="secondary_percentage" min="0" max="100" step="0.01"></div>
            <div class="field"><label for="d-gat">${t('evidence.gat')}</label><input type="number" id="d-gat" name="gat" min="0" max="100" step="0.01"></div>
            <div class="field"><label for="d-saat">${t('evidence.saat')}</label><input type="number" id="d-saat" name="saat" min="0" max="100" step="0.01"></div></fieldset>
          <fieldset><legend>${t('cat.new.source')}</legend>
            <div class="field"><label for="d-pub">${t('program.source.publisher')}</label><input type="text" id="d-pub" name="publisher" maxlength="200"></div>
            <div class="field"><label for="d-url">${t('program.source.url')}</label><input type="text" id="d-url" name="source_url" maxlength="500" dir="ltr"></div>
            <div class="field"><label for="d-pd">${t('program.source.published')}</label><input type="text" id="d-pd" name="published_at" value="${plus(-5)}" dir="ltr" inputmode="numeric" placeholder="YYYY-MM-DD"></div>
            <div class="field"><label for="d-cd">${t('program.source.captured')}</label><input type="text" id="d-cd" name="captured_at" value="${plus(0)}" dir="ltr" inputmode="numeric" placeholder="YYYY-MM-DD"></div>
            <div class="field"><label for="d-ef">${t('cat.new.effective_from')}</label><input type="text" id="d-ef" name="effective_from" value="${plus(-5)}" dir="ltr" inputmode="numeric" placeholder="YYYY-MM-DD"></div>
            <div class="field"><label for="d-et">${t('cat.new.effective_to')}</label><input type="text" id="d-et" name="effective_to" value="${plus(300)}" dir="ltr" inputmode="numeric" placeholder="YYYY-MM-DD"></div>
            <div class="field"><label for="d-rd">${t('program.source.review_due')}</label><input type="text" id="d-rd" name="review_due_at" value="${plus(180)}" dir="ltr" inputmode="numeric" placeholder="YYYY-MM-DD"></div></fieldset>
          <p id="draft-msg" class="error-text" role="alert"></p><button class="btn" type="submit">${t('cat.new.create')}</button></form></section>` : ''}
      <p class="small muted">${t('cat.dates', { d: day(new Date().toISOString()) })}</p></div>`,
    after(root) {
      root.querySelectorAll('[data-publish]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await post(`${BASE}/admin/program-rules/${b.dataset.publish}/publish`, {});
            announce(t('cat.published'));
            await render();
          } catch (e) {
            root.querySelector('#pub-msg').textContent = e.reason === 'four_eyes_required' ? t('cat.fourEyes.self') : e.message;
          }
        }),
      );
      root.querySelector('#draft-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const conditions = [];
        const pw = [...f.querySelectorAll('[name=pw]:checked')].map((x) => x.value);
        if (pw.length) conditions.push({ key: 'pathway', value: pw });
        for (const k of ['secondary_percentage', 'gat', 'saat']) if (f[k].value !== '') conditions.push({ key: k, value: Number(f[k].value) });
        try {
          await post(`${BASE}/admin/program-rules`, {
            program_id: f.program_id.value,
            cycle,
            conditions,
            source: { publisher: f.publisher.value, source_url: f.source_url.value, published_at: f.published_at.value, captured_at: f.captured_at.value },
            effective_from: f.effective_from.value,
            effective_to: f.effective_to.value,
            review_due_at: f.review_due_at.value,
          });
          announce(t('cat.new.created'));
          await render();
        } catch (err) {
          root.querySelector('#draft-msg').textContent = err.message;
          announce(err.message, true);
        }
      });
    },
  };
}
