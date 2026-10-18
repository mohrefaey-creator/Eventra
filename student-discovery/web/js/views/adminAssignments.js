import { h } from '../html.js';
import { get, post, BASE } from '../api.js';
import { t, loc } from '../i18n.js';
import { num, date } from '../format.js';
import { chip } from '../components/ui.js';
import { render } from '../router.js';
import { announce } from '../a11y.js';

export default async function view() {
  const { students, counselors } = await get(`${BASE}/admin/assignments`);
  const needing = students.filter((s) => s.status === 'unassigned').length;
  return {
    title: t('assign.title'),
    body: h`<div class="stack"><h1>${t('assign.title')}</h1><p class="lead">${t('assign.lead')}</p>
      <div class="card flat small" role="note">${t('assign.note')}</div>
      <p class="${needing ? 'error-text' : 'muted'}" role="status">${needing ? t('assign.needing', { n: num(needing) }) : t('assign.none_needing')}</p>
      <section class="card"><h2>${t('assign.students')}</h2>
        <div class="table-wrap"><table><caption class="visually-hidden">${t('assign.students')}</caption><thead><tr><th>${t('queue.student')}</th><th>${t('assign.status')}</th><th>${t('assign.counselor')}</th><th>${t('assign.change')}</th></tr></thead><tbody>
        ${students.map((r) => {
          const options = counselors.filter((c) => c.id !== r.counselor?.id && !r.excluded_counselors.includes(c.id));
          return h`<tr><th scope="row"><bdi>${loc(r.student.display_name)}</bdi><div class="small muted">${t('common.grade', { n: r.student.grade })}</div></th>
            <td>${r.status === 'assigned' ? chip('ok', '✓', t('assign.assigned')) : chip('bad', '!', t('assign.unassigned'))}
              ${r.conflict ? h`<div class="small muted">${t('assign.conflict_by', { name: loc(r.conflict.declared_by.display_name), d: date(r.conflict.declared_at, true) })}</div>` : ''}</td>
            <td>${r.counselor ? h`<bdi>${loc(r.counselor.display_name)}</bdi><div class="small muted">${t('assign.since', { d: date(r.assigned_at) })}</div>` : h`<span class="muted">—</span>`}</td>
            <td>${options.length ? h`<form class="row" data-student="${r.student.id}"><label class="visually-hidden" for="ac-${r.student.id}">${t('assign.choose')}</label>
              <select id="ac-${r.student.id}" name="counselor"><option value="">${t('assign.choose')}</option>${options.map((c) => h`<option value="${c.id}">${loc(c.display_name)}</option>`)}</select>
              <label class="visually-hidden" for="ar-${r.student.id}">${t('assign.reason')}</label><input type="text" id="ar-${r.student.id}" name="reason" maxlength="500" placeholder="${t('assign.reason')}" autocomplete="off">
              <button class="btn small" type="submit">${r.status === 'assigned' ? t('assign.reassign') : t('assign.assign')}</button></form>` : h`<span class="small muted">${t('assign.no_options')}</span>`}</td></tr>`;
        })}
        </tbody></table></div>
        <p id="as-msg" class="error-text" role="alert"></p></section>
      <section class="card"><h2>${t('assign.counselors')}</h2>
        <div class="table-wrap"><table><caption class="visually-hidden">${t('assign.counselors')}</caption><thead><tr><th>${t('assign.counselor')}</th><th class="num">${t('assign.load')}</th></tr></thead><tbody>
        ${counselors.map((c) => h`<tr><th scope="row"><bdi>${loc(c.display_name)}</bdi></th><td class="num">${num(c.students)}</td></tr>`)}</tbody></table></div></section>
    </div>`,
    after(root) {
      const msg = root.querySelector('#as-msg');
      root.querySelectorAll('form[data-student]').forEach((f) =>
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          if (!f.counselor.value) {
            msg.textContent = t('assign.err.choose');
            f.counselor.focus();
            return;
          }
          try {
            await post(`${BASE}/admin/assignments`, { student_id: f.dataset.student, counselor_id: f.counselor.value, reason: f.reason.value });
            await render();
            announce(t('assign.saved'));
          } catch (err) {
            const key = `assign.err.${err.code}`;
            msg.textContent = t(key) === key ? err.message : t(key);
          }
        }),
      );
    },
  };
}
