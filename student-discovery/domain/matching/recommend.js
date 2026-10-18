// Deterministic recommendation run: ranks by interest fit, keeps readiness and eligibility
// as separate axes, and emits the explainability payload of spec §5.6.
// No generative text is produced here; the only authoritative output is this structured result.
import { hashOf } from '../util.js';
import { evaluateAdmission } from '../admission/gate.js';
import { interestFit, weightedAlignment, exploratoryFit, capabilityReadiness, FIT_ALGORITHM_VERSION } from './fit.js';

export const RECOMMENDATION_ALGORITHM_VERSION = `reco-demo-0.1.0+${FIT_ALGORITHM_VERSION}`;

const stripPrefix = (obj, prefix, pick) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), pick(v)]));

/**
 * Build the matching profile from the LATEST sealed score_run per instrument.
 * @param latest { [instrument_id]: score_run | undefined }
 */
export function buildProfile(latest) {
  const norm = (run, prefix) => stripPrefix(run?.construct_scores, prefix, (v) => (v.status === 'ok' ? v.value_0_1 : null));
  const riasecRun = latest.interest_exploratory;
  const constraintRun = latest.student_constraints;
  const lang = constraintRun?.construct_scores?.CONSTRAINT_instruction_language;
  return {
    riasec: riasecRun?.construct_scores ?? null,
    riasec_ranking: riasecRun?.ranking ?? null,
    subjects: norm(latest.subject_preference_exploratory, 'SUBJ_'),
    skills: norm(latest.skills_confidence_selfreport, 'SKILL_'),
    values: norm(latest.work_values_exploratory, 'VALUE_'),
    constraints: { instruction_language: lang?.status === 'ok' ? lang.value : null },
    module_status: Object.fromEntries(
      ['interest_exploratory', 'subject_preference_exploratory', 'skills_confidence_selfreport', 'work_values_exploratory', 'student_constraints'].map((id) => [id, latest[id] ? 'sealed' : 'missing']),
    ),
    score_run_ids: Object.fromEntries(Object.entries(latest).filter(([, r]) => r).map(([id, r]) => [id, r.id])),
  };
}

/** latest evidence per type: { [type]: {id,value,verification_state,expires_at} } */
export function latestEvidence(records) {
  const out = {};
  for (const r of [...records].sort((a, b) => (a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : 0))) {
    out[r.type] = { id: r.id, value: r.value, verification_state: r.verification_state, expires_at: r.expires_at ?? null };
  }
  return out;
}

const competitionRank = (sorted, key) => {
  const ranks = [];
  sorted.forEach((x, i) => ranks.push(i > 0 && x[key] === sorted[i - 1][key] ? ranks[i - 1] : i + 1));
  return ranks;
};

/**
 * @param {object} args
 * @param args.profile    from buildProfile
 * @param args.evidence   from latestEvidence
 * @param args.programs   active programs
 * @param args.ruleFor    (program_id) => active admission_rule_snapshot | null
 * @param args.now        Date
 */
export function runRecommendations({ profile, evidence, programs, ruleFor, now }) {
  const rows = programs.map((p) => {
    const snapshot = ruleFor(p.program_id);
    const fit = interestFit(profile.riasec, p.profile.riasec);
    const subject = weightedAlignment(profile.subjects, p.profile.subject_relevance);
    const values = weightedAlignment(profile.values, p.profile.values_emphasis);
    const skillsSelf = weightedAlignment(profile.skills, p.profile.skills_emphasis);
    const demonstrated = { status: 'not_available', value: null, reason: 'aptitude_on_hold' };
    const composite = exploratoryFit({
      interest_similarity: fit,
      subject_alignment: subject,
      demonstrated_skills_alignment: demonstrated,
      work_values_alignment: values,
    });
    const readiness = capabilityReadiness(p.profile.required_preparation, evidence, now);
    const admission = evaluateAdmission(snapshot, evidence, now);

    const tensions = [];
    const pref = profile.constraints.instruction_language;
    if (pref && pref !== 'either' && p.instruction_language !== 'both' && p.instruction_language !== pref) {
      tensions.push({ key: 'instruction_language_mismatch', params: { preferred: pref, program: p.instruction_language } });
    }
    const gaps = readiness.items.filter((i) => i.result === 'not_met' || i.result === 'unverified_not_met');
    if (gaps.length) tensions.push({ key: 'preparation_gap', params: { subjects: gaps.map((g) => g.subject) } });
    if (admission.eligibility === 'verified_ineligible') {
      tensions.push({ key: 'admission_condition_not_met', params: { conditions: admission.conditions.filter((c) => c.result === 'not_met').map((c) => c.key) } });
    }

    const missing = new Set();
    for (const m of fit.missing ?? []) missing.add(`riasec:${m}`);
    if (fit.reason === 'riasec_dimension_incomplete' && !fit.missing?.length) missing.add('riasec:all');
    for (const m of subject.missing ?? []) missing.add(`subject:${m}`);
    for (const m of values.missing ?? []) missing.add(`value:${m}`);
    for (const m of admission.required_evidence) missing.add(`evidence:${m}`);
    for (const i of readiness.items.filter((x) => x.result === 'unknown')) missing.add(`evidence:subject_grade:${i.subject}`);

    const unverified = [...admission.conditions, ...readiness.items].some((c) => c.result?.startsWith('unverified'));
    const uncertainties = ['interest_instrument_unvalidated', 'aptitude_on_hold', 'program_profile_synthetic'];
    if (admission.competitive) uncertainties.push('acceptance_is_competitive');
    if (unverified) uncertainties.push('evidence_unverified');
    if (['source_stale', 'manual_review_required', 'not_evaluated'].includes(admission.eligibility) && admission.source_state !== 'verified_current') uncertainties.push(`source_${admission.source_state}`);

    return {
      program_id: p.program_id,
      rank_if_available: null,
      interest_fit: fit,
      subject_alignment: subject,
      work_values_alignment: values,
      self_reported_skills_alignment: skillsSelf,
      demonstrated_skills_alignment: demonstrated,
      composite_fit: composite,
      capability_readiness: readiness,
      admission_status: admission,
      rule_version: snapshot ? { snapshot_id: snapshot.id, version: snapshot.version, cycle: snapshot.cycle, state: snapshot.state } : null,
      interest_evidence: fit.status === 'ok' ? { cosine: fit.cosine, contributions: fit.contributions } : null,
      academic_evidence: { evidence_ids: collectEvidenceIds(evidence, admission, readiness) },
      tensions,
      missing_inputs: [...missing].sort(),
      uncertainties,
      alternatives: [],
      human_review_status: 'not_requested',
      _cluster: p.field_cluster,
    };
  });

  // rank: by interest fit value desc, then program_id; unavailable fit unranked, listed after
  const ranked = rows.filter((r) => r.interest_fit.status === 'ok').sort((a, b) => b.interest_fit.value - a.interest_fit.value || a.program_id.localeCompare(b.program_id));
  const ranks = competitionRank(ranked.map((r) => ({ v: r.interest_fit.value })), 'v');
  ranked.forEach((r, i) => (r.rank_if_available = ranks[i]));
  const unranked = rows.filter((r) => r.interest_fit.status !== 'ok').sort((a, b) => a.program_id.localeCompare(b.program_id));
  const items = [...ranked, ...unranked];

  for (const r of items) {
    const same = ranked.filter((x) => x._cluster === r._cluster && x.program_id !== r.program_id);
    const other = ranked.filter((x) => x._cluster !== r._cluster && x.program_id !== r.program_id);
    r.alternatives = [...same, ...other].slice(0, 3).map((x) => x.program_id);
  }
  items.forEach((r) => delete r._cluster);

  const catalog_snapshot_id = `cat-${hashOf(programs.map((p) => [p.program_id, ruleFor(p.program_id)?.id ?? null, ruleFor(p.program_id)?.state ?? null]).sort()).slice(0, 16)}`;
  const input_snapshot_hash = hashOf({
    riasec: profile.riasec,
    subjects: profile.subjects,
    skills: profile.skills,
    values: profile.values,
    constraints: profile.constraints,
    evidence: Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k, [v.value, v.verification_state, v.expires_at]])),
    score_run_ids: profile.score_run_ids,
  });

  return {
    algorithm_version: RECOMMENDATION_ALGORITHM_VERSION,
    catalog_snapshot_id,
    input_snapshot_hash,
    summary: {
      programs: items.length,
      with_interest_fit: ranked.length,
      by_eligibility: items.reduce((m, r) => ((m[r.admission_status.eligibility] = (m[r.admission_status.eligibility] || 0) + 1), m), {}),
    },
    items,
  };
}

function collectEvidenceIds(evidence, admission, readiness) {
  const ids = new Set();
  for (const c of admission.conditions) if (evidence[c.key]?.id) ids.add(evidence[c.key].id);
  for (const i of readiness.items) if (evidence[`subject_grade:${i.subject}`]?.id) ids.add(evidence[`subject_grade:${i.subject}`].id);
  return [...ids].sort();
}

/** What changed between two runs for the same student (AC-16: new readiness is labelled as recomputed). */
export function diffRuns(prev, next) {
  if (!prev) return [];
  const byId = new Map(prev.items.map((i) => [i.program_id, i]));
  const changes = [];
  for (const n of next.items) {
    const p = byId.get(n.program_id);
    if (!p) continue;
    if (p.admission_status.eligibility !== n.admission_status.eligibility) {
      changes.push({ program_id: n.program_id, field: 'eligibility', from: p.admission_status.eligibility, to: n.admission_status.eligibility });
    }
    if ((p.rule_version?.snapshot_id ?? null) !== (n.rule_version?.snapshot_id ?? null)) {
      changes.push({ program_id: n.program_id, field: 'rule_snapshot', from: p.rule_version?.snapshot_id ?? null, to: n.rule_version?.snapshot_id ?? null });
    }
    if (p.interest_fit.value !== n.interest_fit.value) {
      changes.push({ program_id: n.program_id, field: 'interest_fit', from: p.interest_fit.value, to: n.interest_fit.value });
    }
    if (p.capability_readiness.status !== n.capability_readiness.status) {
      changes.push({ program_id: n.program_id, field: 'readiness', from: p.capability_readiness.status, to: n.capability_readiness.status });
    }
  }
  return changes;
}

