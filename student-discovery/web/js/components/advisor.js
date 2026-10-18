// Renders the advisor's structured, non-authoritative blocks in the active language.
// Numbers and caveats come from the server payload unchanged; only the wording is localized.
import { h } from '../html.js';
import { t } from '../i18n.js';
import { num } from '../format.js';
import { missingLabel, programName } from './data.js';

const names = (dims) => dims.map((d) => t(`dim.${d}.name`)).join(t('common.list_sep'));

export function advisorBlocks(resp, programs = {}) {
  if (resp.abstained) {
    return h`<div class="card warn" role="note"><h3>${t('advisor.abstained.title')}</h3>
      <p>${t(`advisor.abstained.route.${resp.route_to}`)}</p>
      <p class="small muted">${t('err.code')}: <code>${resp.reason}</code></p></div>`;
  }
  const items = resp.blocks.map((b) => {
    const p = b.params ?? {};
    switch (b.key) {
      case 'advisor.top_interests':
        return h`<p>${t('advisor.top_interests', { names: names(p.dimensions) })} ${p.tied ? t('advisor.tie_note') : ''} ${p.complete ? '' : t('advisor.partial_note')}</p>`;
      case 'advisor.insufficient_dimensions':
        return h`<p>${t('advisor.insufficient_dimensions', { names: names(p.dimensions) })}</p>`;
      case 'advisor.missing_evidence':
        return h`<p>${t('advisor.missing_evidence')}</p><ul>${p.items.map((i) => h`<li>${missingLabel(i)}</li>`)}</ul>`;
      case 'advisor.program_fit':
        return h`<p>${t('advisor.program_fit', { program: programName(programs[p.program_id]), index: num(p.interest_fit * 100), aligned: names(p.top_aligned), divergent: p.top_divergent.length ? names(p.top_divergent) : '—' })}</p>`;
      case 'advisor.program_fit_incomplete':
        return h`<p>${t('advisor.program_fit_incomplete')}</p>`;
      case 'advisor.admission_status':
        return h`<p>${t(`advisor.admission.${p.eligibility}`)} ${p.competitive ? t('advisor.competitive_note') : ''}</p>${p.required_evidence.length ? h`<ul>${p.required_evidence.map((e) => h`<li>${t('missing.evidence', { name: t(`evidence.${e}`) })}</li>`)}</ul>` : ''}`;
      case 'advisor.questions_for_counselor':
        return h`<p><strong>${t('advisor.questions_title')}</strong></p><ul>${p.items.map((q) => h`<li>${t(q)}</li>`)}</ul>`;
      default:
        if (b.key.startsWith('advisor.tension.')) {
          const params = { subjects: (p.subjects ?? []).map((s) => t(`subj.${s}`)).join(t('common.list_sep')), conditions: (p.conditions ?? []).map((c) => t(`evidence.${c}`)).join(t('common.list_sep')), preferred: p.preferred ? t(`lang.${p.preferred}`) : '', program: p.program ? t(`lang.${p.program}`) : '' };
          return h`<p>${t(b.key, params)}</p>`;
        }
        return h`<p>${t(b.key)}</p>`;
    }
  });
  return h`<div class="card flat" role="region" aria-label="${t('advisor.title')}">
    <h3>${t('advisor.title')} <span class="chip info"><span class="g" aria-hidden="true">i</span>${t('advisor.nonauth')}</span></h3>
    ${items}
    <p class="small muted">${t('advisor.sources_note')}</p></div>`;
}

