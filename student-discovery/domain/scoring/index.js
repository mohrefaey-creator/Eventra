// Deterministic, versioned scoring (spec §5). Pure functions: same input => same output bit for bit.
//
// Hard invariants enforced here:
//  - missing / "not applicable" stays missing; nothing is imputed as zero
//  - low interest is a preference, never an inability
//  - a construct below the instrument's minimum answered count is `insufficient_data`
//  - every score_run carries input_hash + execution_hash so it can be replayed and compared
import { hashOf, round } from '../util.js';
import { RIASEC_DIMENSIONS } from '../instruments/interest.js';

/** Values that count as answered, after reverse-coding. Returns number or null. */
function usable(item, v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) return null;
  return item.reverse_coded ? 6 - v : v;
}

function riasecMean(instrument, responses) {
  const { min_answered_per_construct: min } = instrument.scoring;
  const constructScores = {};
  const missingness = {};
  for (const d of RIASEC_DIMENSIONS) {
    const construct = `RIASEC_${d}`;
    const items = instrument.items.filter((i) => i.construct === construct);
    const answered = [];
    for (const it of items) {
      const x = usable(it, responses[it.item_id]);
      if (x !== null) answered.push(x);
    }
    const nAnswered = answered.length;
    missingness[construct] = { n_total: items.length, n_answered: nAnswered, n_missing: items.length - nAnswered };
    if (nAnswered < min) {
      constructScores[construct] = { status: 'insufficient_data', n_answered: nAnswered, n_total: items.length, min_required: min, mean: null, display_0_100: null };
    } else {
      const mean = answered.reduce((a, b) => a + b, 0) / nAnswered; // mean_c = (Σ x_i) / n_answered_c
      constructScores[construct] = {
        status: 'ok',
        n_answered: nAnswered,
        n_total: items.length,
        min_required: min,
        mean: round(mean, 6),
        display_0_100: round(25 * (mean - 1), 4), // display_0_100_c = 25 × (mean_c − 1)
      };
    }
  }
  return { constructScores, missingness, ranking: rankRiasec(constructScores) };
}

/**
 * Deterministic tie handling (disclosed): competition ranking ("1,2,2,4") on display score;
 * ties are listed explicitly and ordered by the fixed construct order R,I,A,S,E,C.
 * `top` = every dimension with rank <= 3, so a tie at the boundary is never silently broken.
 * No claim is made that near-equal scores are meaningfully different.
 */
export function rankRiasec(constructScores) {
  const ok = RIASEC_DIMENSIONS.map((d) => ({ d, s: constructScores[`RIASEC_${d}`] })).filter((x) => x.s.status === 'ok');
  const sorted = [...ok].sort((a, b) => b.s.display_0_100 - a.s.display_0_100 || RIASEC_DIMENSIONS.indexOf(a.d) - RIASEC_DIMENSIONS.indexOf(b.d));
  const order = [];
  sorted.forEach((x, idx) => {
    const rank = idx > 0 && sorted[idx - 1].s.display_0_100 === x.s.display_0_100 ? order[idx - 1].rank : idx + 1;
    order.push({ dimension: x.d, rank, display_0_100: x.s.display_0_100 });
  });
  for (const o of order) o.tied_with = order.filter((p) => p.rank === o.rank && p.dimension !== o.dimension).map((p) => p.dimension);
  return {
    complete: ok.length === RIASEC_DIMENSIONS.length,
    dimensions_scored: ok.length,
    order,
    top: order.filter((o) => o.rank <= 3).map((o) => o.dimension),
    tie_rule: 'competition_rank_then_fixed_order_RIASEC',
  };
}

function perItemNormalized(instrument, responses) {
  const constructScores = {};
  const missingness = {};
  for (const it of instrument.items) {
    const raw = responses[it.item_id];
    const x = usable(it, raw);
    const naExplicit = raw === 'na';
    missingness[it.construct] = { n_total: 1, n_answered: x === null ? 0 : 1, n_missing: x === null ? 1 : 0, not_applicable: naExplicit };
    constructScores[it.construct] =
      x === null
        ? { status: naExplicit ? 'not_applicable' : 'missing', value_0_1: null }
        : { status: 'ok', raw: x, value_0_1: round((x - 1) / 4, 4) };
  }
  return { constructScores, missingness, ranking: null };
}

function choicePassthrough(instrument, responses) {
  const constructScores = {};
  const missingness = {};
  for (const it of instrument.items) {
    const v = responses[it.item_id];
    const has = typeof v === 'string' && it.options.includes(v);
    missingness[it.construct] = { n_total: 1, n_answered: has ? 1 : 0, n_missing: has ? 0 : 1 };
    constructScores[it.construct] = has ? { status: 'ok', value: v } : { status: 'missing', value: null };
  }
  return { constructScores, missingness, ranking: null };
}

const ENGINES = {
  riasec_mean: riasecMean,
  per_item_normalized: perItemNormalized,
  choice_passthrough: choicePassthrough,
};

/** Canonical, order-independent snapshot of the answer set that feeds the hash. */
export function answerSnapshot(responses) {
  return Object.keys(responses)
    .sort()
    .map((k) => [k, responses[k]]);
}

/**
 * Compute a score payload (without ids / timestamps, so it is replayable).
 * @param instrument  frozen instrument manifest
 * @param responses   { [item_id]: normalized_response } from a SEALED attempt
 */
export function computeScore(instrument, responses) {
  const engine = ENGINES[instrument.scoring.type];
  if (!engine) throw new Error(`No scoring engine for ${instrument.scoring.type}`);
  const { constructScores, missingness, ranking } = engine(instrument, responses);
  const input_hash = hashOf({ instrument_version_id: instrument.instrument_version_id, item_bank_hash: instrument.item_bank_hash, answers: answerSnapshot(responses) });
  const body = {
    instrument_id: instrument.instrument_id,
    instrument_version_id: instrument.instrument_version_id,
    item_bank_hash: instrument.item_bank_hash,
    algorithm_version: instrument.scoring.version,
    input_hash,
    construct_scores: constructScores,
    missingness,
    ranking,
    norm_reference: null, // no norms exist for any instrument in this prototype (AC-18)
  };
  return { ...body, execution_hash: hashOf(body) };
}

/** Replay a stored score_run against the sealed answers (AC-09). */
export function replayScore(instrument, responses, stored) {
  const again = computeScore(instrument, responses);
  return { match: again.execution_hash === stored.execution_hash, recomputed_hash: again.execution_hash, stored_hash: stored.execution_hash };
}

/** Completeness of an answer set vs. the instrument (used by submit). */
export function completeness(instrument, responses) {
  const missing = instrument.items.filter((i) => responses[i.item_id] === undefined).map((i) => i.item_id);
  return { total: instrument.items.length, answered: instrument.items.length - missing.length, missing };
}
