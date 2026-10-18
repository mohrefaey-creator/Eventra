import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { go } from '../router.js';
import { announce } from '../a11y.js';

/** Works for any student on the counselor's roster, including one who has not shared anything: stepping away only removes access. */
export default async function view({ params }) {
  const { items } = await get(`${BASE}/counselor/queue`);
  const row = items.find((r) => r.student.id === params.id);
  if (!row) {
    return { title: t('c360.away.title'), body: h`<div class="stack"><p class="small"><a href="#/counselor">← ${t('queue.title')}</a></p><div class="card warn" role="alert"><h1>${t('c360.away.title')}</h1><p>${t('deny.not_available')}</p></div></div>` };
  }
  return {
    title: t('c360.away.title'),
    body: h`<div class="stack"><p class="small"><a href="#/counselor">← ${t('queue.title')}</a></p>
      <h1>${t('c360.away.title')}</h1><p class="lead"><bdi>${loc(row.student.display_name)}</bdi> <span class="muted small">${t('common.grade', { n: row.student.grade })}</span></p>
      <div class="card flat" role="note">${t('c360.away.note')}</div>
      <form id="away-form" class="card stack" novalidate>
        <div class="field"><label for="away-reason">${t('c360.away.reason')}</label><input type="text" id="away-reason" name="reason" maxlength="1000" autocomplete="off" aria-describedby="away-hint"><span class="hint" id="away-hint">${t('c360.away.hint')}</span></div>
        <p id="away-msg" class="error-text" role="alert"></p>
        <div class="row"><button class="btn" type="submit">${t('c360.away.button')}</button><a class="btn secondary" href="#/counselor">${t('common.cancel')}</a></div>
      </form></div>`,
    after(root) {
      root.querySelector('#away-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = root.querySelector('#away-msg');
        msg.textContent = '';
        try {
          await post(`${BASE}/students/${params.id}/conflict-of-interest`, { reason: e.currentTarget.reason.value });
          go('/counselor');
          announce(t('c360.away.done'));
        } catch (err) {
          msg.textContent = err.code === 'reason_required' ? t('c360.away.short') : err.message;
        }
      });
    },
  };
}
