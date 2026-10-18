import { h } from '../html.js';
import { get, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { num } from '../format.js';
import { chip } from '../components/ui.js';

export default async function view() {
  const { items } = await get(`${BASE}/counselor/queue`);
  return {
    title: t('queue.title'),
    body: h`<div class="stack"><h1>${t('queue.title')}</h1><p class="lead">${t('queue.lead')}</p>
      <div class="card flat small" role="note">${t('queue.logged')}</div>
      ${items.length ? h`<div class="table-wrap"><table><caption class="visually-hidden">${t('queue.title')}</caption><thead><tr><th>${t('queue.student')}</th><th>${t('queue.access')}</th><th>${t('queue.reasons')}</th><th class="num">${t('queue.cases')}</th><th></th></tr></thead><tbody>
        ${items.map((r) => h`<tr><th scope="row"><bdi>${loc(r.student.display_name)}</bdi><div class="small muted">${t('common.grade', { n: r.student.grade })}</div></th>
          <td>${r.access === 'full' ? chip('ok', '✓', t('queue.access.full')) : chip('warn', '✕', t('queue.access.none'))}</td>
          <td><div class="chips">${r.reasons.length ? r.reasons.map((x) => chip(['safeguarding_referral', 'missing_consent'].includes(x) ? 'bad' : 'warn', '!', t(`queue.reason.${x}`))) : chip('ok', '✓', t('queue.reason.none'))}</div></td>
          <td class="num">${num(r.open_cases)}</td>
          <td>${r.access === 'full' ? h`<a class="btn small" href="#/counselor/student/${r.student.id}?purpose=case_review">${t('queue.open')}</a>` : h`<span class="small muted">${t('queue.no_access_hint')}</span>`}</td></tr>`)}
        </tbody></table></div>` : h`<div class="card empty">${t('queue.empty')}</div>`}
    </div>`,
  };
}
