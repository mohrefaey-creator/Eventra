// Instrument registry: manifests + governance metadata (spec §4.2 mandatory metadata).
import { hashOf, deepFreeze } from '../util.js';
import { interestExploratory } from './interest.js';
import { subjectPreferenceExploratory, skillsConfidenceSelfReport, workValuesExploratory, studentConstraints } from './others.js';

const L = (ar, en) => ({ 'ar-SA': ar, en });

export const INSTRUMENT_STATES = [
  'draft',
  'translation_review',
  'expert_review',
  'licensed_confirmed',
  'psychometric_review',
  'approved_for_pilot',
  'pilot_validated',
  'approved_for_production',
  'retired',
];

/** States that a real (non-synthetic) student session may use. */
export const PRODUCTION_USABLE_STATES = ['approved_for_pilot', 'pilot_validated', 'approved_for_production'];

const EXPLORATORY_WARNING = L(
  'أداة استكشافية غير مُتحقَّق منها: لا تقدّم درجات معيارية أو نسب مئوية أو تشخيصًا أو تنبؤًا بالنجاح. استخدمها للحوار مع المرشد فقط.',
  'Exploratory, unvalidated tool: no norms, percentiles, diagnosis or prediction of success. Use it as a conversation starter with a counselor only.',
);

function governance(extra = {}) {
  return {
    owner: 'NextMind Student Journey (prototype)',
    state: 'draft',
    jurisdiction: 'SA',
    age_range: { grade_min: 10, grade_max: 12 },
    intended_uses: ['self_exploration', 'counselor_conversation'],
    license: { status: 'original_content_no_third_party_rights_claimed', doc_ref: null, confirmed_by: null, expires_at: null },
    validation: { translation_review: 'not_done', back_translation: 'not_done', expert_review: 'not_done', cognitive_interviews: 'not_done', reliability: 'not_done', fairness_findings: 'not_done', norms: 'none' },
    missing_response_policy: 'missing stays missing; never imputed as zero',
    timing: { timed: false, accommodations: 'untimed by default' },
    item_exposure_controls: 'none required for self-report preferences',
    interpretation_warning: EXPLORATORY_WARNING,
    approvers: [],
    ...extra,
  };
}

const defs = [
  { ...interestExploratory, governance: governance({ intended_uses: ['self_exploration', 'counselor_conversation'], note: 'Do NOT present as the O*NET Interest Profiler or a validated Holland Code.' }) },
  { ...subjectPreferenceExploratory, governance: governance() },
  { ...skillsConfidenceSelfReport, governance: governance({ note: 'Self-report confidence is never scored as demonstrated competence.' }) },
  { ...workValuesExploratory, governance: governance() },
  { ...studentConstraints, governance: governance({ interpretation_warning: L('خيارات معلنة من الطالب؛ لا تُحتسب كدرجات.', 'Student-stated choices; not scored.') }) },
];

// The aptitude module is registered so the platform can show WHY it is unavailable. No items exist.
const aptitudeHold = {
  instrument_id: 'aptitude_reasoning',
  name: L('القدرات والاستدلال', 'Aptitude & reasoning'),
  purpose: L('قياس قدرات مُثبتة (لفظية/عددية/استدلالية).', 'Measures demonstrated reasoning, verbal and numerical abilities.'),
  stem: L('', ''),
  construct: 'Cognitive aptitude (licensed, validated instrument required)',
  version: '0.0.0',
  locale_set: [],
  usage_class: 'hold',
  scoring: { type: 'none', version: 'none' },
  items: [],
  governance: governance({
    hold_reason: L(
      'معلّقة: تتطلب أداة مرخّصة ومُتحقَّقًا منها ومختبرة للإنصاف ومناسبة للعمر وآمنة الإدارة قبل أي استخدام.',
      'On hold: requires a licensed, validated, fairness-tested, age-appropriate and securely administered instrument before any use.',
    ),
    license: { status: 'none_not_procured', doc_ref: null, confirmed_by: null, expires_at: null },
    intended_uses: [],
  }),
};

const all = [...defs, aptitudeHold];

for (const d of all) {
  d.instrument_version_id = `${d.instrument_id}@${d.version}`;
  d.item_bank_hash = hashOf(d.items.map((i) => ({ id: i.item_id, c: i.construct, t: i.content, r: i.response_type, rc: i.reverse_coded })));
  d.items_total = d.items.length;
}

deepFreeze(all);

export const INSTRUMENTS = all;
export const getInstrument = (id) => all.find((i) => i.instrument_id === id) || null;
export const getInstrumentByVersionId = (vid) => all.find((i) => i.instrument_version_id === vid) || null;

/** Recommended order (spec J-02): interest -> subjects -> aptitude -> skills -> values -> constraints. */
export const MODULE_SEQUENCE = [
  'interest_exploratory',
  'subject_preference_exploratory',
  'aptitude_reasoning',
  'skills_confidence_selfreport',
  'work_values_exploratory',
  'student_constraints',
];

/** Estimates only (spec J-02). */
export const DURATION_ESTIMATE_MIN = {
  interest_exploratory: 8,
  subject_preference_exploratory: 3,
  aptitude_reasoning: null,
  skills_confidence_selfreport: 3,
  work_values_exploratory: 2,
  student_constraints: 1,
};

/**
 * Fail-closed usability policy (spec §11.10, AC-06).
 * `runtimeState` carries admin-controlled overrides: { state, suspended }.
 */
export function instrumentUsability(instrument, runtimeState, { syntheticMode, now }) {
  if (!instrument) return { usable: false, reason: 'unknown_instrument' };
  if (instrument.usage_class === 'hold' || instrument.items.length === 0) return { usable: false, reason: 'instrument_on_hold' };
  const state = runtimeState?.state ?? instrument.governance.state;
  if (state === 'retired') return { usable: false, reason: 'instrument_retired' };
  if (runtimeState?.suspended) return { usable: false, reason: 'instrument_suspended' };
  const exp = instrument.governance.license.expires_at;
  if (exp && new Date(exp) <= now) return { usable: false, reason: 'license_expired' };
  if (PRODUCTION_USABLE_STATES.includes(state)) return { usable: true, reason: null, mode: 'approved' };
  if (instrument.usage_class === 'exploratory_synthetic_only' && syntheticMode) return { usable: true, reason: null, mode: 'exploratory_synthetic' };
  return { usable: false, reason: 'not_approved_for_live_use' };
}

/** Why an instrument cannot be promoted yet (spec §8 admin publish, DISC-12 blocked publication). */
export function publicationBlockers(instrument, runtimeState) {
  const g = instrument.governance;
  const blockers = [];
  if (instrument.usage_class === 'hold' || instrument.items.length === 0) blockers.push('no_items_defined');
  if (!g.license.doc_ref || g.license.status.startsWith('none') || g.license.status.startsWith('original')) blockers.push('license_not_confirmed');
  for (const [k, v] of Object.entries(g.validation)) {
    if (k === 'norms') continue;
    if (v !== 'done') blockers.push(`${k}_missing`);
  }
  if ((runtimeState?.state ?? g.state) === 'retired') blockers.push('instrument_retired');
  return blockers;
}
