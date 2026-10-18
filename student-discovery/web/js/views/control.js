import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t } from '../i18n.js';
import { role } from '../state.js';
import { num, date, shortHash } from '../format.js';
import { chip } from '../components/ui.js';
import { render } from '../router.js';
import { refreshMe } from '../session.js';
import { announce } from '../a11y.js';

const cell = (c) => (c.suppressed ? h`<span class="chip" title="${t('ct.suppressed_hint')}"><span class="g" aria-hidden="true">∅</span>${t('ct.suppressed')}</span>` : h`<strong>${num(c.value)}</strong>`);

export default async function view({ query }) {
  const k = await get(`${BASE}/admin/control-tower`);
  const sec = role() === 'platform_security';
  const filter = query.action ?? '';
  const audit = sec ? await get(`${BASE}/admin/audit?limit=40${filter ? `&action=${encodeURIComponent(filter)}` : ''}`) : null;
  const inc = k.incident_mode;
  return {
    title: t('ct.title'),
    body: h`<div class="stack"><h1>${t('ct.title')}</h1><p class="lead">${t('ct.lead', { n: num(k.min_cell_size) })}</p>
      <div class="grid">
        <section class="card"><h2>${t('ct.cohort')}</h2><dl class="kv"><dt>${t('ct.opted_in')}</dt><dd>${cell(k.cohort.opted_in_students)}</dd><dt>${t('ct.sessions')}</dt><dd>${cell(k.cohort.sessions)}</dd><dt>${t('ct.appeals')}</dt><dd>${cell(k.appeals)}</dd></dl></section>
        <section class="card"><h2>${t('ct.catalog')}</h2><dl class="kv"><dt>${t('ct.programs')}</dt><dd><strong>${num(k.catalog_freshness.programs)}</strong></dd>
          ${['verified_current', 'stale', 'conflicting', 'none'].map((s) => h`<dt>${t(`source.${s}`)}</dt><dd><strong>${num(k.catalog_freshness[s])}</strong></dd>`)}</dl></section>
        <section class="card"><h2>${t('ct.instruments')}</h2><ul>${k.instruments.map((i) => h`<li><code>${i.instrument_id}</code> ${chip(i.suspended ? 'bad' : '', i.suspended ? '⏸' : '•', i.suspended ? t('instr.suspended') : t(`instr.state.${i.state}`))}</li>`)}</ul></section>
        <section class="card"><h2>${t('ct.security')}</h2><dl class="kv"><dt>${t('ct.denied')}</dt><dd><strong>${num(k.security.access_denied_total)}</strong></dd><dt>${t('ct.denied_consent')}</dt><dd><strong>${num(k.security.no_consent_denials)}</strong></dd></dl></section>
        <section class="card"><h2>${t('ct.ops')}</h2><dl class="kv"><dt>${t('ct.audit_events')}</dt><dd><strong>${num(k.operations.audit_events)}</strong></dd>
          <dt>${t('ct.audit_chain')}</dt><dd>${k.operations.audit_chain.ok ? chip('ok', '✓', t('ct.chain_ok')) : chip('bad', '✕', t('ct.chain_broken', { n: k.operations.audit_chain.broken_at_seq }))}</dd>
          <dt>${t('ct.outbox_pending')}</dt><dd><strong>${num(k.operations.outbox_pending)}</strong></dd><dt>${t('ct.outbox_retry')}</dt><dd><strong>${num(k.operations.outbox_retrying)}</strong></dd></dl></section>
      </div>
      <section class="card" aria-labelledby="mods"><h2 id="mods">${t('ct.modules')}</h2>
        ${k.modules.length ? h`<div class="table-wrap"><table><thead><tr><th>${t('ct.module')}</th><th>${t('ct.locale')}</th><th class="num">${t('ct.started')}</th><th class="num">${t('ct.submitted')}</th><th class="num">${t('ct.median')}</th></tr></thead><tbody>
          ${k.modules.map((m) => h`<tr><th scope="row"><code>${m.instrument_id}</code></th><td>${m.locale}</td><td class="num">${cell(m.started)}</td><td class="num">${cell(m.submitted)}</td><td class="num">${cell(m.median_completion_seconds)}</td></tr>`)}</tbody></table></div>` : h`<p class="muted">${t('ct.no_modules')}</p>`}
        <p class="small muted">${t('ct.privacy_note')}</p></section>

      ${sec ? h`<section class="card ${inc.enabled ? 'bad' : ''}" aria-labelledby="ks"><h2 id="ks">${t('ct.kill.title')}</h2>
        <p>${inc.enabled ? h`${chip('bad', '⏸', t('ct.kill.on'))} <span class="small">${inc.reason}</span>` : chip('ok', '▶', t('ct.kill.off'))}</p>
        <form id="kill" class="row"><label class="visually-hidden" for="kr">${t('instr.reason')}</label><input type="text" id="kr" name="reason" placeholder="${t('instr.reason')}" maxlength="300">
          <button class="btn ${inc.enabled ? '' : 'danger'}" type="submit">${inc.enabled ? t('ct.kill.disable') : t('ct.kill.enable')}</button></form><p id="kill-msg" class="error-text" role="alert"></p></section>

        <section aria-labelledby="aud"><h2 id="aud">${t('ct.audit.title')}</h2>
          <p class="small">${audit.chain.ok ? chip('ok', '✓', t('ct.chain_ok')) : chip('bad', '✕', t('ct.chain_broken', { n: audit.chain.broken_at_seq }))} · ${t('ct.audit.total', { n: num(audit.total) })}</p>
          <form id="audit-filter" class="row"><label for="af">${t('ct.audit.filter')}</label><input type="text" id="af" name="act" value="${filter}" dir="ltr" placeholder="security."><button class="btn secondary small" type="submit">${t('common.apply')}</button></form>
          <div class="table-wrap"><table><thead><tr><th class="num">#</th><th>${t('ct.audit.time')}</th><th>${t('ct.audit.actor')}</th><th>${t('ct.audit.action')}</th><th>${t('ct.audit.subject')}</th><th>${t('ct.audit.decision')}</th><th>${t('reports.hash')}</th></tr></thead><tbody>
          ${audit.items.map((e) => h`<tr><td class="num">${num(e.seq)}</td><td class="small">${date(e.timestamp, true)}</td><td class="small"><code>${e.actor.id ?? '—'}</code><div class="muted">${e.actor.role}</div></td><td><code>${e.action}</code></td><td class="small"><code>${e.subject_ref ?? '—'}</code></td><td>${e.policy_decision === 'deny' ? chip('bad', '✕', t('ct.audit.deny')) : chip('ok', '✓', t('ct.audit.allow'))}${e.meta?.reason ? h` <span class="small muted"><code>${e.meta.reason}</code></span>` : ''}</td><td><code>${shortHash(e.hash)}</code></td></tr>`)}</tbody></table></div></section>` : ''}
    </div>`,
    after(root) {
      root.querySelector('#kill')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await post(`${BASE}/admin/kill-switch`, { enabled: !inc.enabled, reason: e.currentTarget.reason.value });
          announce(t('c360.saved'));
          await refreshMe();
          await render();
        } catch (err) {
          root.querySelector('#kill-msg').textContent = err.message;
        }
      });
      root.querySelector('#audit-filter')?.addEventListener('submit', (e) => {
        e.preventDefault();
        location.hash = `#/admin/control${e.currentTarget.act.value ? `?action=${encodeURIComponent(e.currentTarget.act.value)}` : ''}`;
      });
    },
  };
}
