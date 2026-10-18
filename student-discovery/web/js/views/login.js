import { h } from '../html.js';
import { get, IDENT } from '../api.js';
import { t } from '../i18n.js';
import { L } from '../components/ui.js';
import { signIn } from '../session.js';
import { go } from '../router.js';
import { homeRoute } from '../components/shell.js';
import { role } from '../state.js';

const ORDER = ['student', 'guardian', 'counselor', 'catalog_steward', 'psychometric_lead', 'tenant_admin', 'platform_security'];

export default async function view() {
  const data = await get(`${IDENT}/personas`);
  const by = Object.groupBy ? Object.groupBy(data.items, (p) => p.role) : data.items.reduce((m, p) => ((m[p.role] ??= []).push(p), m), {});
  return {
    title: t('login.title'),
    body: h`<div class="stack">
      <div class="hero"><h1>${t('login.title')}</h1><p class="lead">${t('login.lead')}</p></div>
      <div class="card warn" role="note"><strong>${t('login.notice.title')}</strong> ${t('login.notice.body')}</div>
      ${ORDER.filter((r) => by[r]).map((r) => h`<section aria-labelledby="g-${r}"><h2 id="g-${r}">${t(`role.${r}.plural`)}</h2>
        <div class="persona-grid">${by[r].map((p) => h`<button class="btn secondary" type="button" data-persona="${p.id}">
          <span><bdi>${L(p.display_name)}</bdi><br><span class="small muted">${p.tenant_id === 'platform' ? '' : L(data.tenants[p.tenant_id])}${p.grade ? ` · ${t('common.grade', { n: p.grade })}` : ''}</span></span></button>`)}</div></section>`)}
    </div>`,
    after(root) {
      root.querySelectorAll('[data-persona]').forEach((b) =>
        b.addEventListener('click', async () => {
          b.disabled = true;
          await signIn(b.dataset.persona);
          go(homeRoute(role()));
        }),
      );
    },
  };
}
