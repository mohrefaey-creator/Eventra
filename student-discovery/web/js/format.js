// Locale-aware numbers and dates. Identifiers, hashes and enum codes are never localized.
import { getLocale } from './i18n.js';

const tag = () => (getLocale() === 'ar-SA' ? 'ar-SA-u-nu-arab' : 'en');
const dateTag = () => (getLocale() === 'ar-SA' ? 'ar-SA-u-ca-gregory-nu-arab' : 'en-GB');

export function num(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(tag(), { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}

export const pct = (n01, digits = 0) => (n01 === null || n01 === undefined ? '—' : `${num(n01 * 100, digits)}${getLocale() === 'ar-SA' ? '٪' : '%'}`);

export function date(iso, withTime = false) {
  if (!iso) return '—';
  const opts = withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat(dateTag(), opts).format(new Date(iso));
}

/** Parse what a student typed, accepting Arabic-Indic and Persian digits. */
export function parseNumber(s) {
  const t = String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫،,]/g, '.')
    .trim();
  return t === '' ? null : Number(t);
}

export const shortHash = (hsh) => (hsh ? String(hsh).slice(0, 10) : '—');
