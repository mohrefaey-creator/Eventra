// Bounded "advisor": read / explain / draft only (spec §10).
//
// This prototype calls NO external model. Explanations are assembled from deterministic results
// into structured message keys that the client renders in either language, so numbers and
// caveats are preserved exactly across languages. Everything returned is non-authoritative and
// carries the ids of the sources it was built from. With no verified source it abstains.
import { audit } from '../audit.js';
import { authorize } from '../policy.js';
import { badRequest, notFound } from '../errors.js';
import { RIASEC_DIMENSIONS } from '../../domain/instruments/interest.js';
import { latestScoreRuns, studentEvidenceMap } from './common.js';

export const PURPOSE_ALLOWLIST = ['career_guidance', 'university_guidance'];

const latestRun = (db, studentId) => Object.values(db.recommendation_runs).filter((r) => r.student_id === studentId).sort((a, b) => b.seq - a.seq)[0] ?? null;

/**
 * Canonical advisor tool contract (spec §10): minimal, purpose-authorised evidence references.
 * Never returns raw answers, evidence values or notes.
 */
export function getStudentDiscoverySummary(ctx, args) {
  const { db } = ctx;
  if (!PURPOSE_ALLOWLIST.includes(args?.purpose)) throw badRequest('purpose_not_allowed', `purpose must be one of ${PURPOSE_ALLOWLIST.join(', ')}.`);
  const { student } = authorize(ctx, args.student_id, 'advisor.explain'); // same tenant, relationship, consent scope
  const runs = latestScoreRuns(db, student.id);
  const reco = latestRun(db, student.id);
  const ev = studentEvidenceMap(db, student.id);
  const warning_flags = [];
  if (!runs.interest_exploratory) warning_flags.push('interest_module_missing');
  else if (!runs.interest_exploratory.ranking.complete) warning_flags.push('interest_profile_incomplete');
  if (!['pathway', 'secondary_percentage', 'gat', 'saat'].every((t) => ev[t])) warning_flags.push('missing_academic_evidence');
  warning_flags.push('aptitude_on_hold');
  if (reco?.output.items.some((i) => ['source_stale', 'manual_review_required', 'not_evaluated'].includes(i.admission_status.eligibility) && i.admission_status.source_state !== 'verified_current')) warning_flags.push('some_program_sources_not_current');
  const summary = {
    approved_score_run_ids: Object.values(runs).map((r) => r.id).sort(),
    recommendation_run_id: reco?.id ?? null,
    admission_source_snapshot_ids: reco ? [...new Set(reco.output.items.map((i) => i.admission_status.rule_snapshot_id).filter(Boolean))].sort() : [],
    warning_flags,
  };
  audit(ctx, { action: 'advisor.tool_invoked', tenant_id: student.tenant_id, subject_ref: `student:${student.id}`, meta: { tool: 'get_student_discovery_summary', purpose: args.purpose } });
  return summary;
}

const abstain = (reason, route_to) => ({ authoritative: false, abstained: true, reason, route_to, blocks: [], sources: {} });

export function explain(ctx, studentId, body) {
  const { db } = ctx;
  const purpose = body?.purpose ?? 'career_guidance';
  getStudentDiscoverySummary(ctx, { student_id: studentId, purpose });
  const topic = body?.topic;
  const runs = latestScoreRuns(db, studentId);
  const reco = latestRun(db, studentId);

  if (topic === 'results') {
    const run = runs.interest_exploratory;
    if (!run) return abstain('no_verified_source', 'counselor'); // AC-10
    const blocks = [];
    const rk = run.ranking;
    blocks.push({ key: 'advisor.top_interests', params: { dimensions: rk.top, complete: rk.complete, tied: rk.top.length > 3 || rk.order.some((o) => o.tied_with.length) } });
    const insufficient = RIASEC_DIMENSIONS.filter((d) => run.construct_scores[`RIASEC_${d}`].status !== 'ok');
    if (insufficient.length) blocks.push({ key: 'advisor.insufficient_dimensions', params: { dimensions: insufficient } });
    blocks.push({ key: 'advisor.low_interest_not_inability', params: {} });
    blocks.push({ key: 'advisor.not_holland_code', params: {} });
    blocks.push({ key: 'advisor.no_norms', params: {} });
    blocks.push({ key: 'advisor.questions_for_counselor', params: { items: ['q.top_interests_resonate', 'q.surprises', 'q.subjects_vs_interests'] } });
    return { authoritative: false, abstained: false, topic, blocks, sources: { score_run_ids: [run.id] } };
  }

  if (topic === 'missing_evidence') {
    if (!reco) return abstain('no_verified_source', 'counselor');
    const missing = new Set();
    for (const i of reco.output.items) for (const m of i.missing_inputs) missing.add(m);
    return { authoritative: false, abstained: false, topic, blocks: [{ key: 'advisor.missing_evidence', params: { items: [...missing].sort() } }, { key: 'advisor.questions_for_counselor', params: { items: ['q.which_documents', 'q.verify_scores'] } }], sources: { recommendation_run_id: reco.id } };
  }

  if (topic === 'program') {
    const programId = body?.program_id;
    if (!reco || typeof programId !== 'string') return abstain('no_verified_source', 'counselor');
    const item = reco.output.items.find((i) => i.program_id === programId);
    if (!item) throw notFound('program in the latest recommendation run');
    // Abstain unless the admission source behind this program is verified and current (AC-10).
    if (item.admission_status.source_state !== 'verified_current') return abstain(`source_${item.admission_status.source_state}`, 'catalog_review');
    const blocks = [];
    if (item.interest_fit.status === 'ok') {
      const top = [...item.interest_evidence.contributions].sort((a, b) => b.share - a.share);
      blocks.push({ key: 'advisor.program_fit', params: { program_id: programId, interest_fit: item.interest_fit.value, top_aligned: top.filter((c) => c.share > 0).slice(0, 2).map((c) => c.dimension), top_divergent: top.filter((c) => c.share < 0).slice(-1).map((c) => c.dimension) } });
    } else {
      blocks.push({ key: 'advisor.program_fit_incomplete', params: { program_id: programId } });
    }
    blocks.push({ key: 'advisor.admission_status', params: { program_id: programId, eligibility: item.admission_status.eligibility, required_evidence: item.admission_status.required_evidence, competitive: item.admission_status.competitive } });
    for (const t of item.tensions) blocks.push({ key: `advisor.tension.${t.key}`, params: t.params });
    blocks.push({ key: 'advisor.no_acceptance_probability', params: {} });
    blocks.push({ key: 'advisor.questions_for_counselor', params: { items: ['q.alternatives', 'q.readiness_plan'] } });
    return { authoritative: false, abstained: false, topic, blocks, sources: { recommendation_run_id: reco.id, rule_snapshot_ids: [item.admission_status.rule_snapshot_id] } };
  }

  throw badRequest('unknown_topic', "topic must be 'results', 'missing_evidence' or 'program'.");
}
