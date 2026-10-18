import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAdmission, evaluateCondition, classifySource } from '../../domain/admission/gate.js';
import { interestFit, weightedAlignment, exploratoryFit, capabilityReadiness, EXPLORATORY_WEIGHTS } from '../../domain/matching/fit.js';
import { buildProfile, latestEvidence, runRecommendations, diffRuns } from '../../domain/matching/recommend.js';
import { computeScore } from '../../domain/scoring/index.js';
import { getInstrument } from '../../domain/instruments/registry.js';
import { PROGRAMS } from '../../domain/catalog/programs.js';
import { buildSeedRuleSnapshots } from '../../domain/catalog/seedRules.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const ev = (value, verification_state = 'counselor_verified', extra = {}) => ({ value, verification_state, expires_at: null, ...extra });

const snap = (over = {}) => ({
  id: 'snap-1', program_id: 'p', cycle: '2027', version: 1, state: 'published',
  rules: { competitive: true, conditions: [{ key: 'pathway', op: 'in', value: ['general'] }, { key: 'secondary_percentage', op: 'gte', value: 85 }, { key: 'gat', op: 'gte', value: 80 }] },
  source: { publisher: 'p', source_url: 'u', published_at: iso(+NOW - 90 * DAY), captured_at: iso(+NOW - 60 * DAY) },
  effective_from: iso(+NOW - 60 * DAY), effective_to: iso(+NOW + 300 * DAY), review_due_at: iso(+NOW + 100 * DAY), ...over,
});
const full = { pathway: ev('general'), secondary_percentage: ev(90), gat: ev(82) };

test('gate: verified eligible when all conditions are verified and met; probability is always null', () => {
  const r = evaluateAdmission(snap(), full, NOW);
  assert.equal(r.eligibility, 'verified_eligible');
  assert.equal(r.acceptance_probability, null);
  assert.equal(r.competitive, true);
});

test('gate: verified failure is ineligible even if other evidence is missing', () => {
  const r = evaluateAdmission(snap(), { pathway: ev('general'), secondary_percentage: ev(70) }, NOW);
  assert.equal(r.eligibility, 'verified_ineligible');
});

test('AC-08 gate: missing evidence is evidence_missing, never eligible', () => {
  const r = evaluateAdmission(snap(), { pathway: ev('general'), secondary_percentage: ev(90) }, NOW);
  assert.equal(r.eligibility, 'evidence_missing');
  assert.deepEqual(r.required_evidence, ['gat']);
});

test('gate: unverified manual input is never used for hard rejection', () => {
  const unverifiedFail = evaluateAdmission(snap(), { ...full, gat: ev(50, 'unverified') }, NOW);
  assert.equal(unverifiedFail.eligibility, 'manual_review_required');
  const unverifiedPass = evaluateAdmission(snap(), { ...full, gat: ev(95, 'unverified') }, NOW);
  assert.equal(unverifiedPass.eligibility, 'manual_review_required', 'manual input is not official proof');
  assert.equal(unverifiedPass.conditions.find((c) => c.key === 'gat').result, 'unverified_met');
});

test('AC-07 gate: stale / expired / conflicting / absent sources are not eligible', () => {
  assert.equal(evaluateAdmission(snap({ review_due_at: iso(+NOW - DAY) }), full, NOW).eligibility, 'source_stale');
  assert.equal(evaluateAdmission(snap({ effective_to: iso(+NOW - DAY) }), full, NOW).eligibility, 'source_stale');
  assert.equal(evaluateAdmission(snap({ effective_from: iso(+NOW + DAY) }), full, NOW).eligibility, 'source_stale');
  assert.equal(evaluateAdmission(snap({ state: 'conflicting' }), full, NOW).eligibility, 'manual_review_required');
  assert.equal(evaluateAdmission(null, full, NOW).eligibility, 'not_evaluated');
  assert.equal(evaluateAdmission(snap({ state: 'draft' }), full, NOW).eligibility, 'not_evaluated');
  assert.equal(classifySource(snap(), NOW), 'verified_current');
});

test('gate: expired evidence counts as unknown', () => {
  const r = evaluateAdmission(snap(), { ...full, gat: ev(95, 'counselor_verified', { expires_at: iso(+NOW - DAY) }) }, NOW);
  assert.equal(r.eligibility, 'evidence_missing');
  assert.equal(evaluateCondition({ key: 'gat', op: 'gte', value: 80 }, full.gat, NOW).result, 'met');
  assert.equal(evaluateCondition({ key: 'x', op: 'regex', value: 1 }, ev(1), NOW).result, 'unknown');
});

const scores = (R, I, A, S, E, C) => Object.fromEntries(Object.entries({ R, I, A, S, E, C }).map(([d, v]) => [`RIASEC_${d}`, { status: 'ok', display_0_100: v }]));

test('interest fit: centred cosine, [0,1], similar profile > opposite profile', () => {
  const student = scores(90, 80, 20, 20, 30, 40);
  const similar = interestFit(student, { R: 85, I: 70, A: 20, S: 10, E: 30, C: 40 });
  const opposite = interestFit(student, { R: 5, I: 30, A: 90, S: 90, E: 70, C: 40 });
  assert.equal(similar.status, 'ok');
  assert.ok(similar.value > 0.9 && similar.value <= 1);
  assert.ok(opposite.value < 0.3 && opposite.value >= 0);
  const share = similar.contributions.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(share - similar.cosine) < 1e-3, 'contributions sum to the cosine');
});

test('interest fit: "likes everything" does not inflate fit (centring)', () => {
  const lover = interestFit(scores(95, 90, 92, 91, 93, 94), { R: 85, I: 70, A: 20, S: 10, E: 30, C: 40 });
  assert.equal(lover.status, 'ok');
  const flat = interestFit(scores(50, 50, 50, 50, 50, 50), { R: 85, I: 70, A: 20, S: 10, E: 30, C: 40 });
  assert.equal(flat.status, 'insufficient_data');
  assert.equal(flat.reason, 'flat_interest_profile');
});

test('AC-05 interest fit needs every RIASEC dimension; no zero substitution', () => {
  const partial = { ...scores(90, 80, 20, 20, 30, 40), RIASEC_A: { status: 'insufficient_data', display_0_100: null } };
  const r = interestFit(partial, { R: 1, I: 2, A: 3, S: 4, E: 5, C: 6 });
  assert.equal(r.status, 'insufficient_data');
  assert.deepEqual(r.missing, ['A']);
  assert.equal(r.value, null);
});

test('alignment is strict: one missing key makes the component incomplete (no renormalising)', () => {
  assert.deepEqual(weightedAlignment({ math: 1, physics: 0.5 }, { math: 1, physics: 1 }), { status: 'ok', value: 0.75, basis: [{ key: 'math', weight: 1, student_value: 1 }, { key: 'physics', weight: 1, student_value: 0.5 }] });
  const inc = weightedAlignment({ math: 1, physics: null }, { math: 1, physics: 1 });
  assert.equal(inc.status, 'incomplete');
  assert.deepEqual(inc.missing, ['physics']);
});

test('composite is refused unless all four components exist, and is always flagged unapproved', () => {
  const ok = { status: 'ok', value: 1 };
  assert.equal(exploratoryFit({ interest_similarity: ok, subject_alignment: ok, demonstrated_skills_alignment: { status: 'not_available' }, work_values_alignment: ok }).status, 'incomplete');
  const all = exploratoryFit({ interest_similarity: ok, subject_alignment: ok, demonstrated_skills_alignment: ok, work_values_alignment: ok });
  assert.equal(all.status, 'computed_unapproved');
  assert.equal(all.value, 1);
  assert.equal(all.approved_model, false);
  assert.equal(EXPLORATORY_WEIGHTS.approved, false);
});

test('readiness: grades vs preparation, unverified makes it provisional, aptitude stays on hold', () => {
  const prep = [{ subject: 'math', min_grade: 80 }, { subject: 'physics', min_grade: 80 }];
  assert.equal(capabilityReadiness(prep, {}, NOW).status, 'evidence_missing');
  const prov = capabilityReadiness(prep, { 'subject_grade:math': ev(90, 'unverified') }, NOW);
  assert.equal(prov.status, 'provisional');
  const assessed = capabilityReadiness(prep, { 'subject_grade:math': ev(90), 'subject_grade:physics': ev(70) }, NOW);
  assert.equal(assessed.status, 'assessed');
  assert.equal(assessed.met, 1);
  assert.equal(assessed.ratio, 0.5);
  assert.equal(assessed.aptitude.status, 'on_hold');
  assert.equal(capabilityReadiness([], {}, NOW).status, 'not_required');
});

// ---- full recommendation run over the fictional catalog -------------------------------------
let n = 0;
const rules = buildSeedRuleSnapshots(NOW, () => `rule-${++n}`);
const ruleFor = (id) => rules.find((r) => r.program_id === id) ?? null;

function sealed(id, answerFn) {
  const inst = getInstrument(id);
  const responses = Object.fromEntries(inst.items.map((i) => [i.item_id, answerFn(i)]));
  return { id: `sr-${id}`, ...computeScore(inst, responses) };
}
const techy = sealed('interest_exploratory', (i) => ({ RIASEC_R: 5, RIASEC_I: 5, RIASEC_A: 2, RIASEC_S: 1, RIASEC_E: 2, RIASEC_C: 3 })[i.construct]);
const latest = {
  interest_exploratory: techy,
  subject_preference_exploratory: sealed('subject_preference_exploratory', () => 4),
  skills_confidence_selfreport: sealed('skills_confidence_selfreport', () => 4),
  work_values_exploratory: sealed('work_values_exploratory', () => 4),
  student_constraints: sealed('student_constraints', () => 'en'),
};
const run = () => runRecommendations({ profile: buildProfile(latest), evidence: latestEvidence([]), programs: PROGRAMS, ruleFor, now: NOW });

test('recommendations: engineering/computing outrank care/education for an R+I profile; ranks are deterministic', () => {
  const r = run();
  const rank = Object.fromEntries(r.items.map((i) => [i.program_id, i.rank_if_available]));
  assert.ok(rank['prog-demo-me'] < rank['prog-demo-edu']);
  assert.ok(rank['prog-demo-cs'] < rank['prog-demo-nurs']);
  assert.ok(rank['prog-demo-me'] <= 3, `mechanical engineering should be near the top, got ${rank['prog-demo-me']}`);
  assert.equal(JSON.stringify(run()), JSON.stringify(r), 'identical inputs give identical output');
  assert.equal(r.items.length, PROGRAMS.length);
});

test('recommendations: three axes stay separate, composite incomplete, probability null, payload complete', () => {
  const r = run();
  const cs = r.items.find((i) => i.program_id === 'prog-demo-cs');
  assert.equal(cs.interest_fit.status, 'ok');
  assert.equal(cs.composite_fit.status, 'incomplete');
  assert.deepEqual(cs.composite_fit.missing, ['demonstrated_skills_alignment']);
  assert.equal(cs.demonstrated_skills_alignment.status, 'not_available');
  assert.equal(cs.admission_status.acceptance_probability, null);
  assert.equal(cs.admission_status.eligibility, 'evidence_missing', 'AC-08: strong interest, no exam scores');
  for (const k of ['program_id', 'rank_if_available', 'interest_evidence', 'academic_evidence', 'admission_status', 'rule_version', 'missing_inputs', 'uncertainties', 'alternatives', 'human_review_status']) assert.ok(k in cs, k);
  assert.ok(cs.missing_inputs.includes('evidence:gat'));
  assert.ok(cs.uncertainties.includes('aptitude_on_hold'));
  assert.equal(cs.alternatives.length, 3);
  assert.ok(!cs.alternatives.includes('prog-demo-cs'));
});

test('recommendations: seeded source exceptions surface as stale / conflicting / not_evaluated', () => {
  const by = Object.fromEntries(run().items.map((i) => [i.program_id, i.admission_status.eligibility]));
  assert.equal(by['prog-demo-nurs'], 'source_stale');
  assert.equal(by['prog-demo-psy'], 'manual_review_required');
  assert.equal(by['prog-demo-media'], 'not_evaluated');
});

test('recommendations: instruction-language preference is a tension, never a score change', () => {
  const ar = { ...latest, student_constraints: sealed('student_constraints', () => 'ar') };
  const a = runRecommendations({ profile: buildProfile(ar), evidence: {}, programs: PROGRAMS, ruleFor, now: NOW });
  const b = run();
  const cs = (r) => r.items.find((i) => i.program_id === 'prog-demo-cs');
  assert.equal(cs(a).interest_fit.value, cs(b).interest_fit.value);
  assert.ok(cs(a).tensions.some((t) => t.key === 'instruction_language_mismatch'));
  assert.ok(!cs(b).tensions.some((t) => t.key === 'instruction_language_mismatch'));
});

test('recommendations: a missing interest module yields no fit and no rank (not a zero rank)', () => {
  const r = runRecommendations({ profile: buildProfile({ ...latest, interest_exploratory: undefined }), evidence: {}, programs: PROGRAMS, ruleFor, now: NOW });
  assert.ok(r.items.every((i) => i.interest_fit.status === 'insufficient_data' && i.rank_if_available === null));
});

test('AC-16 catalog change: new run records a new snapshot id and a diff; the old run is untouched', () => {
  const before = run();
  const evid = latestEvidence([
    { id: 'e1', type: 'pathway', value: 'cs_engineering', verification_state: 'counselor_verified', captured_at: iso(+NOW) },
    { id: 'e2', type: 'secondary_percentage', value: 95, verification_state: 'counselor_verified', captured_at: iso(+NOW) },
    { id: 'e3', type: 'gat', value: 90, verification_state: 'counselor_verified', captured_at: iso(+NOW) },
    { id: 'e4', type: 'saat', value: 90, verification_state: 'counselor_verified', captured_at: iso(+NOW) },
  ]);
  const frozen = JSON.stringify(before);
  const withEvidence = runRecommendations({ profile: buildProfile(latest), evidence: evid, programs: PROGRAMS, ruleFor, now: NOW });
  assert.notEqual(withEvidence.input_snapshot_hash, before.input_snapshot_hash);
  assert.equal(withEvidence.catalog_snapshot_id, before.catalog_snapshot_id);
  assert.equal(withEvidence.items.find((i) => i.program_id === 'prog-demo-cs').admission_status.eligibility, 'verified_eligible');
  assert.ok(diffRuns(before, withEvidence).some((c) => c.program_id === 'prog-demo-cs' && c.field === 'eligibility' && c.to === 'verified_eligible'));
  // publish a new rule for the stale program => new catalog snapshot id
  const renewed = { ...ruleFor('prog-demo-nurs'), id: 'rule-new', version: 2, review_due_at: iso(+NOW + 100 * DAY) };
  const ruleFor2 = (id) => (id === 'prog-demo-nurs' ? renewed : ruleFor(id));
  const after = runRecommendations({ profile: buildProfile(latest), evidence: evid, programs: PROGRAMS, ruleFor: ruleFor2, now: NOW });
  assert.notEqual(after.catalog_snapshot_id, before.catalog_snapshot_id);
  assert.notEqual(after.items.find((i) => i.program_id === 'prog-demo-nurs').admission_status.eligibility, 'source_stale');
  assert.equal(JSON.stringify(before), frozen, 'earlier run object is unchanged');
});
