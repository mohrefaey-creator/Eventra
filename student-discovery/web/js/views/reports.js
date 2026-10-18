import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t } from '../i18n.js';
import { myId } from '../state.js';
import { date, shortHash } from '../format.js';
import { chip, notice } from '../components/ui.js';
import { go } from '../router.js';

export const reportChip = (s) => chip({ draft: '', review_requested: 'info', approved: 'ok', rejected: 'bad' }[s] ?? '', { draft: '✎', review_requested: '◐', approved: '✓', rejected: '✕' }[s] ?? '○', t(`report.status.${s}`));

export default async function view() {
  const sid = myId();
  const list = await get(`${BASE}/students/${sid}/reports`);
  return {
    title: t('reports.title'),
    body: h`<div class="stack"><h1>${t('reports.title')}</h1><p class="lead">${t('reports.lead')}</p>
      <div class="row"><button class="btn" type="button" id="gen">${t('reports.generate')}</button><span id="gen-msg" class="error-text" role="alert"></span></div>
      ${list.length ? h`<div class="table-wrap"><table><thead><tr><th>${t('reports.created')}</th><th>${t('reports.status')}</th><th>${t('reports.hash')}</th><th></th></tr></thead><tbody>
        ${list.map((r) => h`<tr><td>${date(r.created_at, true)}</td><td>${reportChip(r.status)}</td><td><code>${shortHash(r.payload_hash)}</code></td><td><a class="btn small secondary" href="#/report/${r.id}">${t('reports.open')}</a></td></tr>`)}</tbody></table></div>`
        : notice('', h`<p class="empty">${t('reports.none')}</p>`)}
    </div>`,
    after(root) {
      root.querySelector('#gen').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const r = await post(`${BASE}/students/${sid}/reports`, {});
          go(`/report/${r.id}`);
        } catch (err) {
          root.querySelector('#gen-msg').textContent = err.code === 'no_sealed_results' ? t('reports.need_results') : err.message;
          e.target.disabled = false;
        }
      });
    },
  };
}
