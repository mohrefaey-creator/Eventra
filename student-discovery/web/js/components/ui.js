// Small presentational helpers shared by views.
import { h, raw } from '../html.js';
import { t, loc } from '../i18n.js';
import { num } from '../format.js';

export const chip = (kind, glyph, text, extra = '') => h`<span class="chip ${kind} ${extra}"><span class="g" aria-hidden="true">${glyph}</span><span>${text}</span></span>`;

const ELIG = {
  verified_eligible: ['ok', '✓'],
  verified_ineligible: ['bad', '✕'],
  evidence_missing: ['warn', '…'],
  manual_review_required: ['warn', '?'],
  source_stale: ['warn', '⌛'],
  not_evaluated: ['', '–'],
};
export const eligibilityChip = (e) => chip(ELIG[e]?.[0] ?? '', ELIG[e]?.[1] ?? '–', t(`elig.${e}`));

const MODULE = { not_started: ['', '○'], in_progress: ['info', '◐'], completed: ['ok', '✓'], needs_review: ['warn', '!'], unavailable: ['', '⏸'] };
export const moduleChip = (s) => chip(MODULE[s]?.[0] ?? '', MODULE[s]?.[1] ?? '○', t(`module.status.${s}`));

const SRC = { verified_current: ['ok', '✓'], stale: ['warn', '⌛'], conflicting: ['bad', '⚠'], none: ['', '–'], not_published: ['', '–'] };
export const sourceChip = (s) => chip(SRC[s]?.[0] ?? '', SRC[s]?.[1] ?? '–', t(`source.${s}`));

const VER = { unverified: ['warn', '?'], counselor_verified: ['ok', '✓'], official_verified: ['ok', '✓'] };
export const verificationChip = (v) => chip(VER[v]?.[0] ?? '', VER[v]?.[1] ?? '–', t(`verification.${v}`));

export const fictionalChip = () => chip('fict', '◇', t('program.fictional'));

/** Horizontal bar list. Values 0..100; null renders as an explicit "insufficient data" row, never as zero. */
export function bars(rows, { alt = false } = {}) {
  return h`<ul class="bars">${rows.map((r) => {
    const insufficient = r.value === null || r.value === undefined;
    const w = insufficient ? 0 : Math.max(0, Math.min(100, r.value));
    return h`<li class="bar-row ${insufficient ? 'insufficient' : ''}">
      <span class="label">${r.label}${r.sub ? h` <span class="muted small">${r.sub}</span>` : ''}</span>
      <svg class="bar-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect class="track" x="0" y="0" width="100" height="10" rx="2"/>
        ${insufficient ? '' : h`<rect class="fill ${alt || r.alt ? 'alt' : ''}" x="0" y="0" width="${w}" height="10" rx="2"/>`}
        ${[25, 50, 75].map((x) => h`<line class="tick" x1="${x}" x2="${x}" y1="0" y2="10"/>`)}
      </svg>
      <span class="val">${insufficient ? r.emptyText ?? t('common.insufficient') : r.valueText ?? num(r.value, 0)}</span>
    </li>`;
  })}</ul>`;
}

/** Compact bar for narrow boxes: bar + number, no label column. */
export function miniBar(value, text) {
  return h`<div class="mini-bar"><svg class="bar-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" x="0" y="0" width="100" height="10" rx="2"/><rect class="fill" x="0" y="0" width="${Math.max(0, Math.min(100, value))}" height="10" rx="2"/></svg><strong>${text}</strong></div>`;
}

export const notice = (kind, body) => h`<div class="card ${kind}" role="note">${body}</div>`;
export const spinner = () => h`<p class="loading" role="status">${t('common.loading')}</p>`;

/** Render a { 'ar-SA', en } object or a plain string. */
export const L = (v) => (typeof v === 'string' ? v : loc(v));

export { raw };
