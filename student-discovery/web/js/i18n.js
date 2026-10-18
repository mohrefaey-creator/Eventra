// Dictionaries are loaded once; content that lives in data (items, programs) carries both languages.
let locale = 'ar-SA';
let dict = { 'ar-SA': {}, en: {} };
const listeners = new Set();

export async function loadDictionaries() {
  const [ar, en] = await Promise.all([fetch('/i18n/ar-SA.json').then((r) => r.json()), fetch('/i18n/en.json').then((r) => r.json())]);
  dict = { 'ar-SA': ar, en };
}

export const getLocale = () => locale;
export const onLocaleChange = (fn) => listeners.add(fn);

export function setLocale(next) {
  if (!['ar-SA', 'en'].includes(next)) return;
  locale = next;
  document.documentElement.lang = next;
  document.documentElement.dir = next === 'ar-SA' ? 'rtl' : 'ltr';
  try {
    localStorage.setItem('sd.locale', next);
  } catch {
    /* storage can be unavailable (private mode); the preference is simply not remembered */
  }
  for (const fn of listeners) fn(next);
}

export function initialLocale() {
  try {
    const saved = localStorage.getItem('sd.locale');
    if (saved === 'ar-SA' || saved === 'en') return saved;
  } catch {
    /* ignore */
  }
  return 'ar-SA'; // Arabic-first
}

export function t(key, params = {}) {
  let s = dict[locale][key] ?? dict.en[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Pick the active language from a { 'ar-SA', en } object. */
export const loc = (obj) => (obj ? (obj[locale] ?? obj.en ?? '') : '');
