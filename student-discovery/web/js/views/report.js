import { h } from '../html.js';
import { get, post, del, download, BASE } from '../api.js';
import { t, loc, getLocale } from '../i18n.js';
import { role } from '../state.js';
import { num, date, shortHash } from '../format.js';
import { bars, eligibilityChip, sourceChip } from '../components/ui.js';
import { programIndex, DIMS, SUBJECT_KEYS, VALUE_KEYS, SKILL_KEYS } from '../components/data.js';
import { reportChip } from './reports.js';
import { render } from '../router.js';
import { announce } from '../a11y.js';

const section = (id, title, body) => h`<section class="card report-section" aria-labelledby="rs-${id}"><h2 id="rs-${id}">${title}</h2>${body}</section>`;

function prefRows(sec, keys, prefix, scoreKey) {
  return keys.map((k) => {
    const c = sec.construct_scores?.[`${scoreKey}_${k}`];
    return { label: t(`${prefix}.${k}`), value: c?.status === 'ok' ? c.value_0_1 * 100 : null, valueText: c?.status === 'ok' ? num(c.value_0_1 * 100) : '', emptyText: c?.status === 'not_applicable' ? t('common.not_applicable') : t('common.insufficient') };
  });
}

export default async function view({ params }) {
  const r = await get(`${BASE}/reports/${params.rid}`);
  const idx = await programIndex();
  const p = r.payload;
  const S = p.sections;
  const me = role();
  const interests = S.expressed_interests;
  const rows = interests.status === 'sealed' ? DIMS.map((d) => ({ d, c: interests.construct_scores[`RIASEC_${d}`] })).sort((a, b) => (b.c.display_0_100 ?? -1) - (a.c.display_0_100 ?? -1)).map(({ d, c }) => ({ label: t(`dim.${d}.name`), value: c.status === 'ok' ? c.display_0_100 : null, valueText: c.status === 'ok' ? num(c.display_0_100) : '' })) : [];
  return {
    title: t('report.title'),
    body: h`<div class="stack">
      <div class="row between no-print"><p class="small"><a href="#/${me === 'student' ? 'report' : me === 'guardian' ? `guardian?student=${r.student_id}` : `counselor/student/${r.student_id}`}">← ${t('common.back')}</a></p>
        <div class="row">${r.status === 'approved' ? h`<button class="btn" type="button" id="pdf">${t('report.pdf.download')}</button>` : ''}<button class="btn secondary" type="button" id="print">${t('report.print')}</button></div></div>
      <p id="pdf-msg" class="small no-print" role="status"></p>
      <div class="watermark-wrap stack" ${r.watermark ? h`data-watermark="${t('report.watermark')}"` : ''}>
        <header class="card accent"><h1>${t('report.title')}</h1>
          <p><bdi>${loc(p.student.display_name)}</bdi> · ${t('common.grade', { n: p.student.grade })} · ${reportChip(r.status)}</p>
          <p class="small muted">${t('report.created', { d: date(r.created_at, true) })} · ${t('report.hash')}: <code>${shortHash(r.payload_hash)}</code></p>
          ${r.status === 'approved' ? h`<p class="small">${t('report.approved_on', { d: date(r.approval.timestamp, true) })}</p>` : h`<p class="error-text">${t('report.not_approved')}</p>`}</header>
        ${section('int', t('results.interests.title'), interests.status === 'sealed' ? h`${bars(rows)}<p class="small muted">${t('results.interests.limits')}</p>` : h`<p>${t('results.interests.none')}</p>`)}
        ${S.counselor_interpretation.length ? section('co', t('results.counselor.title'), h`${S.counselor_interpretation.map((o) => h`<p>“${o.text}”</p>`)}`) : ''}
        ${section('subj', t('results.subjects.title'), S.subject_preferences.status === 'sealed' ? bars(prefRows(S.subject_preferences, SUBJECT_KEYS, 'subj', 'SUBJ')) : h`<p>${t('results.subjects.none')}</p>`)}
        ${section('val', t('results.values.title'), S.work_values.status === 'sealed' ? bars(prefRows(S.work_values, VALUE_KEYS, 'value', 'VALUE')) : h`<p>${t('results.values.none')}</p>`)}
        ${section('skl', t('results.skills.title'), S.self_reported_confidence.status === 'sealed' ? bars(prefRows(S.self_reported_confidence, SKILL_KEYS, 'skill', 'SKILL'), { alt: true }) : h`<p>${t('results.skills.none')}</p>`)}
        ${section('cap', t('results.capabilities.title'), h`<p>${t('results.capabilities.body')}</p>`)}
        ${S.recommendations ? section('rec', t('report.recommendations'), h`
          <div class="table-wrap"><table><thead><tr><th>${t('majors.title')}</th><th class="num">${t('axis.interest_short')}</th><th>${t('axis.eligibility')}</th><th>${t('compare.source')}</th></tr></thead><tbody>
          ${S.recommendations.items.map((i) => h`<tr><th scope="row">${loc(idx[i.program_id]?.official_name)} <span class="small muted">(${t('program.fictional')})</span></th><td class="num">${i.interest_fit === null ? '—' : num(i.interest_fit * 100)}</td><td>${eligibilityChip(i.eligibility)}</td><td>${sourceChip(i.source_state)}</td></tr>`)}</tbody></table></div>
          <p class="small muted">${t('report.snapshot')}: <code>${S.recommendations.catalog_snapshot_id}</code></p>`) : ''}
        ${section('lim', t('report.limits'), h`<ul>${p.limitations.map((l) => h`<li>${t(`limit.${l}`)}</li>`)}</ul>`)}
      </div>
      ${me === 'counselor' && r.status === 'review_requested' ? h`<section class="card accent no-print" aria-labelledby="dec"><h2 id="dec">${t('report.decide.title')}</h2>
        <p>${t('report.decide.body')} <code>${shortHash(r.payload_hash)}</code></p>
        <div class="field"><label for="dec-reason">${t('report.decide.reason')}</label><input type="text" id="dec-reason" maxlength="500"></div>
        <div class="row"><button class="btn" type="button" data-decide="approve">${t('report.decide.approve')}</button><button class="btn danger" type="button" data-decide="reject">${t('report.decide.reject')}</button></div>
        <p id="dec-msg" class="error-text" role="alert"></p></section>` : ''}
      ${me === 'student' ? h`<section class="card no-print" aria-labelledby="act"><h2 id="act">${t('report.actions')}</h2>
        ${r.status === 'draft' ? h`<p>${t('report.review_help')}</p><button class="btn" type="button" id="review">${t('report.request_review')}</button>` : ''}
        ${r.status === 'review_requested' ? h`<p>${t('report.in_review')}</p>` : ''}
        ${r.status === 'approved' ? h`<div class="field"><label for="days">${t('report.share_days')}</label><input type="number" id="days" min="1" max="90" value="30" inputmode="numeric"></div>
          <button class="btn" type="button" id="share">${t('report.share_guardian')}</button>
          ${(r.shares ?? []).filter((s) => !s.revoked_at).map((s) => h`<p class="small">${t('report.shared_until', { d: date(s.expires_at) })} <button class="btn small danger" type="button" data-revoke="${s.id}">${t('report.revoke')}</button></p>`)}` : ''}
        <p id="rep-msg" role="status" class="hint"></p></section>` : ''}
    </div>`,
    after(root) {
      root.querySelector('#print').addEventListener('click', () => window.print());
      root.querySelector('#pdf')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const msg = root.querySelector('#pdf-msg');
        btn.disabled = true;
        msg.textContent = t('report.pdf.preparing');
        try {
          const { blob, name } = await download(`${BASE}/reports/${r.id}/pdf?locale=${encodeURIComponent(getLocale())}`);
          const url = URL.createObjectURL(blob);
          const a = Object.assign(document.createElement('a'), { href: url, download: name });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          msg.textContent = t('report.pdf.saved');
        } catch (err) {
          msg.textContent = { pdf_unavailable: t('report.pdf.unavailable'), pdf_busy: t('report.pdf.busy') }[err.code] ?? t('report.pdf.failed');
        } finally {
          btn.disabled = false;
        }
      });
      root.querySelector('#review')?.addEventListener('click', async () => {
        await post(`${BASE}/reports/${r.id}/review-request`, {});
        announce(t('report.review_sent'));
        await render();
      });
      root.querySelector('#share')?.addEventListener('click', async () => {
        const days = Number(root.querySelector('#days').value);
        try {
          await post(`${BASE}/reports/${r.id}/shares`, { days });
          announce(t('report.shared'));
          await render();
        } catch (e) {
          root.querySelector('#rep-msg').textContent = e.reason === 'consent_scope_inactive' ? t('report.share_needs_consent') : e.message;
        }
      });
      root.querySelectorAll('[data-decide]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await post(`${BASE}/reports/${r.id}/approval`, { action: b.dataset.decide, payload_hash: r.payload_hash, reason: root.querySelector('#dec-reason').value });
            announce(t('report.decided'));
            await render();
          } catch (e) {
            root.querySelector('#dec-msg').textContent = e.code === 'payload_hash_mismatch' ? t('report.hash_mismatch') : e.message;
          }
        }),
      );
      root.querySelectorAll('[data-revoke]').forEach((b) =>
        b.addEventListener('click', async () => {
          await del(`${BASE}/shares/${b.dataset.revoke}`);
          await render();
        }),
      );
    },
  };
}

