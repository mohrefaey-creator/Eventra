// The printable page behind the PDF export. It is built from the SAME dictionaries as the screen
// (web/i18n), as plain semantic HTML (headings, tables with header cells, lists, language and direction),
// because Chromium turns that structure into PDF tags for screen readers. Everything dynamic is escaped.
import fs from 'node:fs';
import { getProgram } from '../domain/catalog/programs.js';

const dictDir = new URL('../web/i18n/', import.meta.url);
const dicts = {};
const dict = (locale) => (dicts[locale] ??= JSON.parse(fs.readFileSync(new URL(`${locale}.json`, dictDir), 'utf8')));

export const PDF_LOCALES = ['ar-SA', 'en'];

const DIMS = ['R', 'I', 'A', 'S', 'E', 'C'];
const SUBJECT_KEYS = ['math', 'physics', 'chemistry', 'biology', 'computer', 'english', 'arabic', 'islamic', 'social', 'business', 'art', 'pe'];
const SKILL_KEYS = ['analytical', 'numeracy', 'communication', 'creativity', 'collaboration', 'organization', 'digital', 'practical'];
const VALUE_KEYS = ['security', 'helping', 'creativity', 'income', 'autonomy', 'leadership', 'learning', 'balance'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function buildReportHtml(view, locale) {
  const ar = locale === 'ar-SA';
  const T = (key, params = {}) => {
    let s = dict(locale)[key] ?? dict('en')[key] ?? key;
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  const nf = new Intl.NumberFormat(ar ? 'ar-SA-u-nu-arab' : 'en', { maximumFractionDigits: 0 });
  const num = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : nf.format(n));
  const day = (iso) => (iso ? new Intl.DateTimeFormat(ar ? 'ar-SA-u-ca-gregory-nu-arab' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) : '—');
  const L = (obj) => esc(obj?.[locale] ?? obj?.en ?? '');
  const p = view.payload;
  const S = p.sections;

  const barRow = (label, value, empty) => `<tr><th scope="row">${esc(label)}</th><td class="num">${value === null ? esc(empty) : `${num(value)}<span class="bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, value))}%"></span></span>`}</td></tr>`;
  const table = (head, rows) => `<table><thead><tr>${head.map((x) => `<th scope="col"${x.num ? ' class="num"' : ''}>${esc(x.text)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const scoreTable = (sec, keys, prefix, scoreKey) => {
    if (sec.status !== 'sealed') return null;
    return table([{ text: T('report.pdf.area') }, { text: T('report.pdf.score'), num: true }], keys.map((k) => {
      const c = sec.construct_scores?.[`${scoreKey}_${k}`];
      return barRow(T(`${prefix}.${k}`), c?.status === 'ok' ? c.value_0_1 * 100 : null, c?.status === 'not_applicable' ? T('common.not_applicable') : T('common.insufficient'));
    }));
  };
  const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;

  const interests = S.expressed_interests;
  const interestRows = interests.status === 'sealed'
    ? DIMS.map((d) => ({ d, c: interests.construct_scores[`RIASEC_${d}`] })).sort((a, b) => (b.c.display_0_100 ?? -1) - (a.c.display_0_100 ?? -1)).map(({ d, c }) => barRow(T(`dim.${d}.name`), c.status === 'ok' ? c.display_0_100 : null, T('common.insufficient')))
    : [];

  const parts = [
    section(T('results.interests.title'), interests.status === 'sealed' ? `${table([{ text: T('report.pdf.area') }, { text: T('report.pdf.score'), num: true }], interestRows)}<p class="note">${esc(T('results.interests.limits'))}</p>` : `<p>${esc(T('results.interests.none'))}</p>`),
    S.counselor_interpretation.length ? section(T('results.counselor.title'), `<ul>${S.counselor_interpretation.map((o) => `<li>“${esc(o.text)}”</li>`).join('')}</ul>`) : '',
    section(T('results.subjects.title'), scoreTable(S.subject_preferences, SUBJECT_KEYS, 'subj', 'SUBJ') ?? `<p>${esc(T('results.subjects.none'))}</p>`),
    section(T('results.values.title'), scoreTable(S.work_values, VALUE_KEYS, 'value', 'VALUE') ?? `<p>${esc(T('results.values.none'))}</p>`),
    section(T('results.skills.title'), scoreTable(S.self_reported_confidence, SKILL_KEYS, 'skill', 'SKILL') ?? `<p>${esc(T('results.skills.none'))}</p>`),
    section(T('results.capabilities.title'), `<p>${esc(T('results.capabilities.body'))}</p>`),
    S.recommendations
      ? section(T('report.recommendations'), `${table([{ text: T('majors.title') }, { text: T('axis.interest_short'), num: true }, { text: T('axis.eligibility') }, { text: T('compare.source') }], S.recommendations.items.map((i) => `<tr><th scope="row">${L(getProgram(i.program_id)?.official_name)} <span class="note">(${esc(T('program.fictional'))})</span></th><td class="num">${i.interest_fit === null ? '—' : num(i.interest_fit * 100)}</td><td>${esc(T(`elig.${i.eligibility}`))}</td><td>${esc(T(`source.${i.source_state}`))}</td></tr>`))}<p class="note">${esc(T('report.snapshot'))}: <code>${esc(S.recommendations.catalog_snapshot_id)}</code></p>`)
      : '',
    section(T('report.limits'), `<ul>${p.limitations.map((l) => `<li>${esc(T(`limit.${l}`))}</li>`).join('')}</ul>`),
  ];

  const name = L(p.student.display_name);
  const approvedOn = view.approval?.timestamp ? esc(T('report.approved_on', { d: day(view.approval.timestamp) })) : '';
  return `<!doctype html>
<html lang="${locale}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(T('report.title'))} — ${name}</title>
<style>
@page { size: A4; margin: 16mm 14mm 18mm; @bottom-center { content: counter(page, ${ar ? 'arabic-indic' : 'decimal'}) " / " counter(pages, ${ar ? 'arabic-indic' : 'decimal'}); font-size: 9pt; color: #444; } }
* { box-sizing: border-box; }
body { font-family: system-ui, "Segoe UI", Tahoma, "Noto Naskh Arabic", "DejaVu Sans", "FreeSerif", sans-serif; font-size: 10.5pt; line-height: 1.55; color: #14202b; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 4pt; } h2 { font-size: 13pt; margin: 16pt 0 6pt; border-bottom: 1px solid #9aa7b3; padding-bottom: 2pt; }
h2 { break-after: avoid; } tr { break-inside: avoid; } thead { display: table-header-group; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0; }
th, td { border: 1px solid #9aa7b3; padding: 3pt 6pt; text-align: start; vertical-align: middle; } thead th { background: #e8eef3; }
td.num, th.num { text-align: end; width: 28%; white-space: nowrap; } .bar { display: block; height: 6pt; margin-top: 2pt; background: #e8eef3; border-radius: 2pt; direction: ltr; } .bar span { display: block; height: 6pt; background: #0b5c8a; border-radius: 2pt; }
.proto { border: 1.5px solid #7a5200; background: #fff4d6; padding: 4pt 8pt; margin-bottom: 10pt; font-size: 9.5pt; }
.meta { color: #3b4a57; font-size: 9.5pt; } .note { color: #3b4a57; font-size: 9.5pt; } code { font-family: "DejaVu Sans Mono", monospace; font-size: 8.5pt; direction: ltr; unicode-bidi: isolate; word-break: break-all; }
footer { margin-top: 18pt; border-top: 1px solid #9aa7b3; padding-top: 6pt; font-size: 9pt; color: #3b4a57; }
</style></head>
<body>
<p class="proto"><strong>${esc(T('proto.banner.title'))}</strong> ${esc(T('proto.banner.body'))}</p>
<header><h1>${esc(T('report.title'))}</h1>
<p><bdi>${name}</bdi> · ${esc(T('common.grade', { n: num(p.student.grade) }))} · ${esc(T('report.status.approved'))}</p>
<p class="meta">${esc(T('report.created', { d: day(view.created_at) }))} · ${approvedOn}</p></header>
${parts.join('\n')}
<footer><p>${esc(T('footer.limits'))}</p><p>${esc(T('report.hash'))}: <code>${esc(view.payload_hash)}</code></p></footer>
</body></html>`;
}
