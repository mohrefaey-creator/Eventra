// Independent deterministic admission-requirement gate (spec §5.5).
//
//  - Missing / unknown / expired input => never "eligible".
//  - Hard rejection (`verified_ineligible`) only on VERIFIED evidence; unverified factors go to review.
//  - Eligibility is NOT acceptance. `acceptance_probability` is always null in Release 1 (§5.1.6).
export const ELIGIBILITY = ['verified_eligible', 'verified_ineligible', 'evidence_missing', 'source_stale', 'manual_review_required', 'not_evaluated'];

/** Evidence verification states that count as proof. Policy placeholder pending D-08/D-03. */
export const VERIFIED_STATES = ['counselor_verified', 'official_verified'];

const SUPPORTED_OPS = { gte: (a, b) => a >= b, lte: (a, b) => a <= b, in: (a, b) => b.includes(a), eq: (a, b) => a === b };

/**
 * Evaluate one rule condition against one evidence record.
 * result: met | not_met | unknown | unverified_met | unverified_not_met
 */
export function evaluateCondition(cond, ev, now) {
  const op = SUPPORTED_OPS[cond.op];
  if (!op) return { key: cond.key, op: cond.op, required: cond.value, provided: null, verification_state: null, result: 'unknown', reason: 'unsupported_operator' };
  if (!ev) return { key: cond.key, op: cond.op, required: cond.value, provided: null, verification_state: null, result: 'unknown', reason: 'no_evidence' };
  if (ev.expires_at && new Date(ev.expires_at) <= now) return { key: cond.key, op: cond.op, required: cond.value, provided: ev.value, verification_state: ev.verification_state, result: 'unknown', reason: 'evidence_expired' };
  const pass = op(ev.value, cond.value);
  const verified = VERIFIED_STATES.includes(ev.verification_state);
  const result = verified ? (pass ? 'met' : 'not_met') : pass ? 'unverified_met' : 'unverified_not_met';
  return { key: cond.key, op: cond.op, required: cond.value, provided: ev.value, verification_state: ev.verification_state, result, reason: null };
}

/** Classify the source snapshot itself before looking at the student. */
export function classifySource(snapshot, now) {
  if (!snapshot) return 'none';
  if (snapshot.state === 'conflicting') return 'conflicting';
  if (snapshot.state !== 'published') return 'not_published';
  if (now < new Date(snapshot.effective_from) || now > new Date(snapshot.effective_to)) return 'stale';
  if (now > new Date(snapshot.review_due_at)) return 'stale';
  return 'verified_current';
}

/**
 * @param snapshot  admission_rule_snapshot (or null)
 * @param evidence  { [type]: { value, verification_state, expires_at } } latest evidence per type
 */
export function evaluateAdmission(snapshot, evidence, now) {
  const base = {
    acceptance_probability: null,
    competitive: Boolean(snapshot?.rules?.competitive),
    rule_snapshot_id: snapshot?.id ?? null,
    cycle: snapshot?.cycle ?? null,
    application_window: snapshot?.rules?.application_window ?? null,
    source: snapshot ? { ...snapshot.source, review_due_at: snapshot.review_due_at, effective_from: snapshot.effective_from, effective_to: snapshot.effective_to } : null,
    conditions: [],
    required_evidence: [],
  };

  const source_state = classifySource(snapshot, now);
  if (source_state === 'none' || source_state === 'not_published') {
    return { ...base, eligibility: 'not_evaluated', source_state, message_key: 'admission.readiness.not_evaluated' };
  }
  if (source_state === 'conflicting') {
    return { ...base, eligibility: 'manual_review_required', source_state, message_key: 'admission.readiness.source_conflict' };
  }
  if (source_state === 'stale') {
    return { ...base, eligibility: 'source_stale', source_state, message_key: 'admission.readiness.source_stale' };
  }

  const conditions = snapshot.rules.conditions.map((c) => evaluateCondition(c, evidence[c.key], now));
  const required_evidence = conditions.filter((c) => c.result === 'unknown').map((c) => c.key);

  let eligibility;
  let message_key;
  if (conditions.some((c) => c.result === 'not_met')) {
    eligibility = 'verified_ineligible';
    message_key = 'admission.readiness.ineligible';
  } else if (required_evidence.length) {
    eligibility = 'evidence_missing';
    message_key = 'admission.readiness.missing_evidence';
  } else if (conditions.some((c) => c.result === 'unverified_met' || c.result === 'unverified_not_met')) {
    eligibility = 'manual_review_required';
    message_key = 'admission.readiness.needs_verification';
  } else {
    eligibility = 'verified_eligible';
    message_key = 'admission.readiness.eligible';
  }
  return { ...base, eligibility, source_state, conditions, required_evidence, message_key };
}
