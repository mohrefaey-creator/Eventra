import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInstrument, INSTRUMENTS, instrumentUsability, publicationBlockers } from '../../domain/instruments/registry.js';
import { computeScore, replayScore, completeness, rankRiasec } from '../../domain/scoring/index.js';
import { validateResponse, validateEvidenceValue, normalizeDigits, ValidationError } from '../../domain/validation.js';
import { canonicalize, round } from '../../domain/util.js';

const interest = getInstrument('interest_exploratory');

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const answersWith = (fn) => Object.fromEntries(interest.items.map((it) => [it.item_id, fn(it)]).filter(([, v]) => v !== undefined));

test('instrument bank: 6 constructs x 6 items, bilingual, no answer keys in manifests', () => {
  assert.equal(interest.items.length, 36);
  for (const d of 'RIASEC') assert.equal(interest.items.filter((i) => i.construct === `RIASEC_${d}`).length, 6);
  for (const it of interest.items) {
    assert.ok(it.content['ar-SA'].length > 3 && it.content.en.length > 3, it.item_id);
    assert.equal(it.status, 'draft_exploratory_only');
    assert.equal('answer_key' in it || 'key' in it || 'secret_key_ref' in it, false);
  }
  assert.equal(new Set(INSTRUMENTS.flatMap((i) => i.items.map((x) => x.item_id))).size, INSTRUMENTS.flatMap((i) => i.items).length, 'item ids unique across instruments');
});

test('AC-04 scoring matches independently computed fixture (mean and 25*(mean-1))', () => {
  // R: 5,4,3,2,1,5 -> sum 20 / 6 ; I: all 3 ; A: 1s ; S: 5s ; E: 2,2,2,2,4,4 ; C: 3,3,3,3,5,1
  const fixture = {
    R: [5, 4, 3, 2, 1, 5], I: [3, 3, 3, 3, 3, 3], A: [1, 1, 1, 1, 1, 1], S: [5, 5, 5, 5, 5, 5], E: [2, 2, 2, 2, 4, 4], C: [3, 3, 3, 3, 5, 1],
  };
  const responses = {};
  for (const [d, vals] of Object.entries(fixture)) vals.forEach((v, i) => (responses[`INT-${d}-${String(i + 1).padStart(3, '0')}`] = v));
  const s = computeScore(interest, responses);
  const expectMean = { R: 20 / 6, I: 3, A: 1, S: 5, E: 16 / 6, C: 18 / 6 };
  for (const d of 'RIASEC') {
    const c = s.construct_scores[`RIASEC_${d}`];
    assert.equal(c.status, 'ok');
    assert.equal(c.mean, round(expectMean[d], 6));
    assert.equal(c.display_0_100, round(25 * (expectMean[d] - 1), 4));
  }
  assert.equal(s.construct_scores.RIASEC_A.display_0_100, 0);
  assert.equal(s.construct_scores.RIASEC_S.display_0_100, 100);
  assert.equal(s.construct_scores.RIASEC_I.display_0_100, 50);
  assert.equal(s.norm_reference, null, 'AC-18: no norms, no percentile');
});

test('AC-05 an unanswered dimension is insufficient_data, never zero', () => {
  const responses = answersWith((it) => (it.construct === 'RIASEC_A' ? undefined : 4));
  const s = computeScore(interest, responses);
  const a = s.construct_scores.RIASEC_A;
  assert.equal(a.status, 'insufficient_data');
  assert.equal(a.display_0_100, null);
  assert.equal(a.mean, null);
  assert.equal(s.ranking.complete, false);
  assert.equal(s.ranking.order.find((o) => o.dimension === 'A'), undefined);
});

test('minimum completion: 3 of 6 answered is insufficient, 4 of 6 is scored on answered items only', () => {
  const three = computeScore(interest, answersWith((it) => (it.construct === 'RIASEC_R' && Number(it.item_id.slice(-3)) > 3 ? undefined : 5)));
  assert.equal(three.construct_scores.RIASEC_R.status, 'insufficient_data');
  const four = computeScore(interest, answersWith((it) => (it.construct === 'RIASEC_R' ? (Number(it.item_id.slice(-3)) > 4 ? undefined : 5) : 3)));
  assert.equal(four.construct_scores.RIASEC_R.status, 'ok');
  assert.equal(four.construct_scores.RIASEC_R.n_answered, 4);
  assert.equal(four.construct_scores.RIASEC_R.display_0_100, 100, 'missing items are not treated as zero');
});

test('"na" and out-of-range values count as missing, not as 1', () => {
  const s = computeScore(interest, answersWith((it) => (it.construct === 'RIASEC_C' ? 'na' : 5)));
  assert.equal(s.construct_scores.RIASEC_C.status, 'insufficient_data');
});

test('reverse-coded items are inverted (6 - x)', () => {
  const inst = { ...interest, items: interest.items.map((i) => (i.item_id === 'INT-R-001' ? { ...i, reverse_coded: true } : i)) };
  const all5 = answersWith(() => 5);
  const plain = computeScore(interest, all5).construct_scores.RIASEC_R.mean;
  const rev = computeScore(inst, all5).construct_scores.RIASEC_R.mean;
  assert.equal(plain, 5);
  assert.equal(rev, round((1 + 5 * 5) / 6, 6));
});

test('ties: competition ranking, boundary ties are all included in top, fixed order', () => {
  const mk = (R, I, A, S, E, C) => Object.fromEntries(Object.entries({ R, I, A, S, E, C }).map(([d, v]) => [`RIASEC_${d}`, { status: 'ok', display_0_100: v }]));
  const r = rankRiasec(mk(80, 70, 60, 60, 10, 0));
  assert.deepEqual(r.order.map((o) => [o.dimension, o.rank]), [['R', 1], ['I', 2], ['A', 3], ['S', 3], ['E', 5], ['C', 6]]);
  assert.deepEqual(r.top, ['R', 'I', 'A', 'S']);
  assert.deepEqual(r.order.find((o) => o.dimension === 'A').tied_with, ['S']);
  const flat = rankRiasec(mk(50, 50, 50, 50, 50, 50));
  assert.equal(flat.top.length, 6);
});

test('property: score invariants hold for 300 random answer sets', () => {
  const rnd = mulberry32(42);
  for (let n = 0; n < 300; n++) {
    const responses = answersWith(() => {
      const r = rnd();
      return r < 0.12 ? undefined : r < 0.16 ? 'na' : 1 + Math.floor(rnd() * 5);
    });
    const s = computeScore(interest, responses);
    for (const c of Object.values(s.construct_scores)) {
      if (c.status === 'ok') {
        assert.ok(c.display_0_100 >= 0 && c.display_0_100 <= 100);
        assert.ok(c.mean >= 1 && c.mean <= 5);
        assert.ok(c.n_answered >= 4);
      } else {
        assert.equal(c.display_0_100, null);
        assert.ok(c.n_answered < 4);
      }
    }
    // order independence: same answers inserted in shuffled order give identical hashes
    const keys = Object.keys(responses).sort(() => rnd() - 0.5);
    const shuffled = Object.fromEntries(keys.map((k) => [k, responses[k]]));
    assert.equal(computeScore(interest, shuffled).execution_hash, s.execution_hash);
  }
});

test('property: raising one answer never lowers its construct score (monotonic)', () => {
  const rnd = mulberry32(7);
  for (let n = 0; n < 120; n++) {
    const base = answersWith(() => 1 + Math.floor(rnd() * 4));
    const it = interest.items[Math.floor(rnd() * interest.items.length)];
    const before = computeScore(interest, base).construct_scores[it.construct].display_0_100;
    const after = computeScore(interest, { ...base, [it.item_id]: base[it.item_id] + 1 }).construct_scores[it.construct].display_0_100;
    assert.ok(after >= before);
  }
});

test('AC-09 replay reproduces the execution hash; a tampered answer does not', () => {
  const responses = answersWith((it) => 1 + (it.item_id.charCodeAt(6) % 5));
  const stored = computeScore(interest, responses);
  assert.deepEqual(replayScore(interest, responses, stored).match, true);
  assert.equal(canonicalize(computeScore(interest, responses)), canonicalize(stored), 'bit-for-bit identical payload');
  const tampered = { ...responses, 'INT-R-001': responses['INT-R-001'] === 5 ? 4 : 5 };
  assert.equal(replayScore(interest, tampered, stored).match, false);
});

test('per-item and choice engines keep missing as missing', () => {
  const subj = getInstrument('subject_preference_exploratory');
  const s = computeScore(subj, { 'SUBJ-math': 5, 'SUBJ-physics': 'na', 'SUBJ-biology': 1 });
  assert.equal(s.construct_scores.SUBJ_math.value_0_1, 1);
  assert.equal(s.construct_scores.SUBJ_biology.value_0_1, 0);
  assert.equal(s.construct_scores.SUBJ_physics.status, 'not_applicable');
  assert.equal(s.construct_scores.SUBJ_chemistry.status, 'missing');
  assert.equal(s.construct_scores.SUBJ_chemistry.value_0_1, null);
  const con = computeScore(getInstrument('student_constraints'), { 'CON-instruction_language': 'ar' });
  assert.equal(con.construct_scores.CONSTRAINT_instruction_language.value, 'ar');
});

test('completeness lists unanswered items', () => {
  const c = completeness(interest, answersWith((it) => (it.item_id === 'INT-R-001' ? undefined : 3)));
  assert.equal(c.answered, 35);
  assert.deepEqual(c.missing, ['INT-R-001']);
});

test('response validation is typed and strict', () => {
  const item = interest.items[0];
  assert.equal(validateResponse(item, 4), 4);
  assert.equal(validateResponse(item, '4'), 4);
  for (const bad of [0, 6, 2.5, 'x', null, undefined, 'na', [], {}]) assert.throws(() => validateResponse(item, bad), ValidationError);
  const subj = getInstrument('subject_preference_exploratory').items[0];
  assert.equal(validateResponse(subj, 'na'), 'na');
  const choice = getInstrument('student_constraints').items[0];
  assert.equal(validateResponse(choice, 'either'), 'either');
  assert.throws(() => validateResponse(choice, 'fr'), ValidationError);
});

test('evidence validation accepts Arabic-Indic digits and rejects out-of-range values', () => {
  assert.equal(normalizeDigits('٨٧٫٥'), '87.5');
  assert.equal(validateEvidenceValue('gat', '٨٧٫٥'), 87.5);
  assert.equal(validateEvidenceValue('pathway', 'general'), 'general');
  for (const [t, v] of [['gat', 101], ['gat', -1], ['gat', 'abc'], ['pathway', 'nope'], ['nope', 1], ['saat', NaN]]) assert.throws(() => validateEvidenceValue(t, v), ValidationError);
});

test('instrument usability fails closed (AC-06)', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  assert.equal(instrumentUsability(interest, null, { syntheticMode: true, now }).usable, true);
  assert.equal(instrumentUsability(interest, null, { syntheticMode: false, now }).reason, 'not_approved_for_live_use');
  assert.equal(instrumentUsability(interest, { suspended: true }, { syntheticMode: true, now }).reason, 'instrument_suspended');
  assert.equal(instrumentUsability(interest, { state: 'retired' }, { syntheticMode: true, now }).reason, 'instrument_retired');
  assert.equal(instrumentUsability(getInstrument('aptitude_reasoning'), null, { syntheticMode: true, now }).reason, 'instrument_on_hold');
  assert.equal(instrumentUsability(interest, { state: 'approved_for_pilot' }, { syntheticMode: false, now }).usable, true);
  assert.ok(publicationBlockers(interest, null).includes('license_not_confirmed'));
});

test('an expired licence fails closed even for an otherwise approved instrument (spec §11.10)', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const licensed = { ...interest, governance: { ...interest.governance, license: { ...interest.governance.license, doc_ref: 'LIC-1', expires_at: '2026-10-01T00:00:00Z' } } };
  assert.equal(instrumentUsability(licensed, { state: 'approved_for_production' }, { syntheticMode: true, now }).reason, 'license_expired');
  const valid = { ...licensed, governance: { ...licensed.governance, license: { ...licensed.governance.license, expires_at: '2027-01-01T00:00:00Z' } } };
  assert.equal(instrumentUsability(valid, { state: 'approved_for_production' }, { syntheticMode: false, now }).usable, true);
});
