import { h } from '../html.js';
import { get, put, BASE } from '../api.js';
import { t } from '../i18n.js';
import { myId } from '../state.js';
import { parseNumber } from '../format.js';
import { verificationChip, notice } from '../components/ui.js';
import { PATHWAYS, GRADE_SUBJECTS } from '../components/data.js';
import { announce } from '../a11y.js';
import { render } from '../router.js';

const NUM_FIELDS = ['secondary_percentage', 'gat', 'saat', ...GRADE_SUBJECTS.map((s) => `subject_grade:${s}`)];

export default async function view() {
  const sid = myId();
  const { latest } = await get(`${BASE}/students/${sid}/evidence`);
  const status = (type) => (latest[type] ? verificationChip(latest[type].verification_state) : h`<span class="chip"><span class="g" aria-hidden="true">–</span>${t('evidence.not_entered')}</span>`);
  const field = (type, label, hint) => h`<div class="field"><label for="ev-${type.replace(':', '-')}">${label}</label>
    <div class="row"><input type="text" inputmode="decimal" autocomplete="off" id="ev-${type.replace(':', '-')}" name="${type}" value="${latest[type]?.value ?? ''}" aria-describedby="hint-${type.replace(':', '-')}">${status(type)}</div>
    ${hint ? h`<span class="hint" id="hint-${type.replace(':', '-')}">${hint}</span>` : ''}</div>`;
  return {
    title: t('evidence.title'),
    body: h`<div class="stack"><h1>${t('evidence.title')}</h1><p class="lead">${t('evidence.lead')}</p>
      ${notice('warn', h`<strong>${t('evidence.notproof.title')}</strong> ${t('evidence.notproof.body')}`)}
      <form id="ev-form" class="stack" novalidate>
        <fieldset><legend>${t('evidence.section.exams')}</legend>
          <div class="field"><label for="ev-pathway">${t('evidence.pathway')}</label>
            <div class="row"><select id="ev-pathway" name="pathway"><option value="">${t('common.choose')}</option>${PATHWAYS.map((p) => h`<option value="${p}" ${latest.pathway?.value === p ? 'selected' : ''}>${t(`pathway.${p}`)}</option>`)}</select>${status('pathway')}</div>
            <span class="hint">${t('evidence.pathway.hint')}</span></div>
          ${field('secondary_percentage', t('evidence.secondary_percentage'), t('evidence.range'))}
          ${field('gat', t('evidence.gat'), t('evidence.range'))}
          ${field('saat', t('evidence.saat'), t('evidence.range'))}
        </fieldset>
        <fieldset><legend>${t('evidence.section.grades')}</legend>
          ${GRADE_SUBJECTS.map((s) => field(`subject_grade:${s}`, t('evidence.grade_in', { name: t(`subj.${s}`) }), ''))}
        </fieldset>
        <p id="ev-msg" role="status" class="hint"></p>
        <button class="btn" type="submit">${t('common.save')}</button>
      </form></div>`,
    after(root) {
      root.querySelector('#ev-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = root.querySelector('#ev-msg');
        const errors = [];
        let changed = 0;
        const entries = [['pathway', root.querySelector('#ev-pathway').value || null], ...NUM_FIELDS.map((f) => [f, root.querySelector(`[name="${f}"]`).value])];
        for (const [type, raw] of entries) {
          const prev = latest[type]?.value;
          if (raw === null || raw === '') continue;
          const value = type === 'pathway' ? raw : parseNumber(raw);
          if (value === prev) continue;
          if (type !== 'pathway' && (value === null || Number.isNaN(value) || value < 0 || value > 100)) {
            errors.push(t('evidence.invalid', { name: type }));
            continue;
          }
          try {
            const r = await put(`${BASE}/students/${sid}/evidence/${encodeURIComponent(type)}`, { value });
            if (r.data.changed) changed++;
          } catch (err) {
            errors.push(`${type}: ${err.message}`);
          }
        }
        if (errors.length) {
          msg.className = 'error-text';
          msg.textContent = errors.join(' · ');
          announce(msg.textContent, true);
          return;
        }
        announce(t('evidence.saved', { n: changed }));
        await render();
        document.getElementById('ev-msg').textContent = t('evidence.saved', { n: changed });
      });
    },
  };
}
