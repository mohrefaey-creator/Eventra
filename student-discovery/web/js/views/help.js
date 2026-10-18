import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t } from '../i18n.js';
import { myId } from '../state.js';
import { date } from '../format.js';
import { chip } from '../components/ui.js';
import { announce } from '../a11y.js';
import { render } from '../router.js';

export default async function view({ query }) {
  const sid = myId();
  const cases = await get(`${BASE}/students/${sid}/cases`);
  const subject = query.subject ?? '';
  const defaultReason = subject.startsWith('session:') || subject.startsWith('score_run:') ? 'interpretation_dispute' : subject.startsWith('program:') || subject.startsWith('recommendation_run:') ? 'appeal' : 'help_request';
  return {
    title: t('help.title'),
    body: h`<div class="stack"><h1>${t('help.title')}</h1><p class="lead">${t('help.lead')}</p>
      <form id="help-form" class="card stack" novalidate>
        <div class="field"><label for="reason">${t('help.type')}</label>
          <select id="reason" name="reason">${['help_request', 'appeal', 'interpretation_dispute'].map((r) => h`<option value="${r}" ${r === defaultReason ? 'selected' : ''}>${t(`case.reason.${r}`)}</option>`)}</select></div>
        ${subject ? h`<p class="small muted">${t('help.about')}: <code>${subject}</code></p>` : ''}
        <div class="field"><label for="msg">${t('help.message')}</label><textarea id="msg" name="message" maxlength="2000" aria-describedby="msg-hint"></textarea>
          <span class="hint" id="msg-hint">${t('help.hint')}</span></div>
        <p id="help-err" class="error-text" role="alert"></p>
        <button class="btn" type="submit">${t('help.send')}</button>
      </form>
      <section><h2>${t('help.mine')}</h2>
        ${cases.length ? h`<div class="stack">${cases.map((c) => h`<article class="card flat"><div class="row between"><strong>${t(`case.reason.${c.reason_code}`)}</strong>${chip({ open: 'info', in_review: 'info', resolved: 'ok' }[c.status], { open: '○', in_review: '◐', resolved: '✓' }[c.status], t(`case.status.${c.status}`))}</div>
          ${c.student_message ? h`<p>“${c.student_message}”</p>` : ''}<p class="small muted">${date(c.created_at, true)}</p>
          ${c.resolution ? h`<p><strong>${t('help.resolution')}:</strong> ${c.resolution}</p>` : ''}</article>`)}</div>` : h`<p class="muted">${t('help.none')}</p>`}
      </section></div>`,
    after(root) {
      root.querySelector('#help-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const err = root.querySelector('#help-err');
        err.textContent = '';
        try {
          await post(`${BASE}/students/${sid}/cases`, { reason_code: f.reason.value, message: f.message.value, subject_ref: subject || undefined });
          announce(t('help.sent'));
          await render();
        } catch (ex) {
          err.textContent = ex.code === 'message_required' ? t('help.need_message') : ex.message;
        }
      });
    },
  };
}
