// Cached lookups and label helpers.
import { get, BASE } from '../api.js';
import { t, loc } from '../i18n.js';

let programs = null;
export async function getPrograms() {
  if (!programs) programs = (await get(`${BASE}/programs?limit=100`)).items;
  return programs;
}
export const invalidatePrograms = () => (programs = null);

export async function programIndex() {
  return Object.fromEntries((await getPrograms()).map((p) => [p.program_id, p]));
}
export const programName = (p) => (p ? loc(p.official_name) : '');

/** Human label for a missing-input code such as "evidence:gat" or "subject:math". */
export function missingLabel(code) {
  const [kind, ...rest] = code.split(':');
  const key = rest.join(':');
  if (kind === 'riasec') return key === 'all' ? t('missing.riasec_all') : t('missing.riasec', { name: t(`dim.${key}.name`) });
  if (kind === 'subject') return t('missing.subject', { name: t(`subj.${key}`) });
  if (kind === 'value') return t('missing.value', { name: t(`value.${key}`) });
  if (kind === 'evidence') return key.startsWith('subject_grade:') ? t('missing.grade', { name: t(`subj.${key.split(':')[1]}`) }) : t('missing.evidence', { name: t(`evidence.${key}`) });
  return code;
}

export const DIMS = ['R', 'I', 'A', 'S', 'E', 'C'];
export const SUBJECT_KEYS = ['math', 'physics', 'chemistry', 'biology', 'computer', 'english', 'arabic', 'islamic', 'social', 'business', 'art', 'pe'];
export const SKILL_KEYS = ['analytical', 'numeracy', 'communication', 'creativity', 'collaboration', 'organization', 'digital', 'practical'];
export const VALUE_KEYS = ['security', 'helping', 'creativity', 'income', 'autonomy', 'leadership', 'learning', 'balance'];
export const GRADE_SUBJECTS = ['math', 'physics', 'chemistry', 'biology', 'computer', 'english', 'arabic'];
export const PATHWAYS = ['general', 'health_life', 'cs_engineering', 'business_admin', 'sharia'];
