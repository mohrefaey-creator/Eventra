// Interest fit, subject / values alignment and capability readiness (spec §5.4).
//
// Three axes stay separate: interest_fit, capability_readiness, admission_eligibility.
// The composite from §5.4 uses PLACEHOLDER weights that are not approved or validated, and a
// required component (demonstrated skills) does not exist while aptitude is on hold, so the
// composite is never computed here. Components are never silently renormalised.
import { round } from '../util.js';
import { RIASEC_DIMENSIONS } from '../instruments/interest.js';
import { VERIFIED_STATES } from '../admission/gate.js';

export const FIT_ALGORITHM_VERSION = 'fit-demo-0.1.0';

export const EXPLORATORY_WEIGHTS = Object.freeze({
  approved: false, // PLACEHOLDER (spec §5.4, D-04): not approved, not validated, not an operational default
  interest_similarity: 0.45,
  subject_alignment: 0.25,
  demonstrated_skills_alignment: 0.2,
  work_values_alignment: 0.1,
});

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Within-person-centred cosine similarity between the student's RIASEC display scores and the
 * program's profile, mapped to [0,1] via (cos+1)/2. Centring removes "likes everything" bias.
 * This is a similarity INDEX, not a probability of success or admission.
 */
export function interestFit(riascScores, programVector) {
  const s = [];
  for (const d of RIASEC_DIMENSIONS) {
    const sc = riascScores?.[`RIASEC_${d}`];
    if (!sc || sc.status !== 'ok') return { status: 'insufficient_data', value: null, reason: 'riasec_dimension_incomplete', missing: RIASEC_DIMENSIONS.filter((x) => riascScores?.[`RIASEC_${x}`]?.status !== 'ok') };
    s.push(sc.display_0_100);
  }
  const p = RIASEC_DIMENSIONS.map((d) => programVector[d]);
  const sm = mean(s);
  const pm = mean(p);
  const sc = s.map((x) => x - sm);
  const pc = p.map((x) => x - pm);
  const sn = Math.sqrt(sc.reduce((a, b) => a + b * b, 0));
  const pn = Math.sqrt(pc.reduce((a, b) => a + b * b, 0));
  if (sn < 1e-9) return { status: 'insufficient_data', value: null, reason: 'flat_interest_profile' };
  if (pn < 1e-9) return { status: 'insufficient_data', value: null, reason: 'flat_program_profile' };
  const dot = sc.reduce((a, x, i) => a + x * pc[i], 0);
  const cosine = dot / (sn * pn);
  const contributions = RIASEC_DIMENSIONS.map((d, i) => ({ dimension: d, student_display: s[i], program_value: p[i], share: round((sc[i] * pc[i]) / (sn * pn), 4) }));
  return {
    status: 'ok',
    method: 'centered_cosine_v1',
    cosine: round(cosine, 4),
    value: round((cosine + 1) / 2, 4),
    contributions,
  };
}

/**
 * Weighted alignment between student preferences (0-1) and a program's weights.
 * Strict: every weighted key needs a student value, otherwise the component is `incomplete`
 * (we do not renormalise over the keys we happen to have).
 */
export function weightedAlignment(studentValues, weights) {
  const keys = Object.keys(weights);
  const missing = keys.filter((k) => !(typeof studentValues?.[k] === 'number'));
  if (missing.length) return { status: 'incomplete', value: null, missing };
  const wsum = keys.reduce((a, k) => a + weights[k], 0);
  const v = keys.reduce((a, k) => a + weights[k] * studentValues[k], 0) / wsum;
  return { status: 'ok', value: round(v, 4), basis: keys.map((k) => ({ key: k, weight: weights[k], student_value: studentValues[k] })) };
}

/** Composite per §5.4. Refuses unless every component is present; always flagged unapproved. */
export function exploratoryFit(components, weights = EXPLORATORY_WEIGHTS) {
  const required = ['interest_similarity', 'subject_alignment', 'demonstrated_skills_alignment', 'work_values_alignment'];
  const missing = required.filter((k) => components?.[k]?.status !== 'ok');
  if (missing.length) return { status: 'incomplete', value: null, missing, approved_model: false };
  const v = required.reduce((a, k) => a + weights[k] * components[k].value, 0);
  return { status: 'computed_unapproved', value: round(v, 4), approved_model: false, weights_note: 'placeholder weights, not approved (spec D-04)' };
}

/**
 * Capability readiness from academic evidence (grades) against a program's preparation list.
 * Aptitude is separate and ON HOLD; it never contributes here.
 */
export function capabilityReadiness(requiredPreparation, evidence, now) {
  const items = requiredPreparation.map((req) => {
    const ev = evidence[`subject_grade:${req.subject}`];
    if (!ev || (ev.expires_at && new Date(ev.expires_at) <= now)) return { subject: req.subject, min_grade: req.min_grade, grade: null, verification_state: null, result: 'unknown' };
    const pass = ev.value >= req.min_grade;
    const verified = VERIFIED_STATES.includes(ev.verification_state);
    return { subject: req.subject, min_grade: req.min_grade, grade: ev.value, verification_state: ev.verification_state, result: verified ? (pass ? 'met' : 'not_met') : pass ? 'unverified_met' : 'unverified_not_met' };
  });
  const aptitude = { status: 'on_hold', reason: 'aptitude_instrument_not_licensed' };
  if (items.length === 0) return { status: 'not_required', ratio: null, items, aptitude };
  const known = items.filter((i) => i.result !== 'unknown');
  if (known.length === 0) return { status: 'evidence_missing', ratio: null, items, aptitude };
  const metCount = items.filter((i) => i.result === 'met' || i.result === 'unverified_met').length;
  const allVerified = items.every((i) => i.result === 'met' || i.result === 'not_met');
  return { status: allVerified ? 'assessed' : 'provisional', ratio: round(metCount / items.length, 4), met: metCount, total: items.length, items, aptitude };
}
