import { randomUUID } from 'node:crypto';
import { audit, emit } from '../audit.js';
import { authorize } from '../policy.js';
import { notFound, badRequest } from '../errors.js';
import { PROGRAMS, UNIVERSITIES, CLUSTERS, PATHWAYS, getProgram } from '../../domain/catalog/programs.js';
import { runRecommendations, diffRuns } from '../../domain/matching/recommend.js';
import { classifySource } from '../../domain/admission/gate.js';
import { CURRENT_CYCLE, activePrograms, activeRuleFor, nextSeq, studentEvidenceMap, studentProfile } from './common.js';

const runsOf = (db, studentId) => Object.values(db.recommendation_runs).filter((r) => r.student_id === studentId).sort((a, b) => b.seq - a.seq);

export function createRecommendation(ctx, studentId, body) {
  const { db } = ctx;
  const { student } = authorize(ctx, studentId, 'recommendation.create');
  const profile = studentProfile(db, studentId);
  const evidence = studentEvidenceMap(db, studentId);
  const output = runRecommendations({
    profile,
    evidence,
    programs: activePrograms(db),
    ruleFor: (pid) => activeRuleFor(db, pid, CURRENT_CYCLE),
    now: ctx.now,
  });

  const history = runsOf(db, studentId);
  // Same inputs + same catalog + same algorithm => the same run (idempotent, reproducible).
  const same = history.find((r) => r.input_snapshot_hash === output.input_snapshot_hash && r.catalog_snapshot_id === output.catalog_snapshot_id && r.algorithm_version === output.algorithm_version);
  if (same && body?.force_recompute !== true) return { run: same, created: false };

  const prev = history[0] ?? null;
  const run = {
    id: randomUUID(),
    seq: nextSeq(db.recommendation_runs),
    tenant_id: student.tenant_id,
    student_id: studentId,
    input_snapshot_hash: output.input_snapshot_hash,
    catalog_snapshot_id: output.catalog_snapshot_id,
    algorithm_version: output.algorithm_version,
    // Deterministic output only. Never an admission probability, never generative text.
    decision_status: 'system_generated_non_authoritative',
    supersedes_run_id: prev?.id ?? null,
    recomputed: Boolean(prev),
    changes_since_previous: prev ? diffRuns(prev.output, output) : [],
    score_run_ids: profile.score_run_ids,
    generated_by: ctx.actor.id,
    created_at: ctx.now.toISOString(),
    output: { ...output, items: output.items.map((i) => ({ ...i, human_review_status: 'not_requested' })) },
  };
  db.recommendation_runs[run.id] = run;
  audit(ctx, { action: 'recommendation.generated', tenant_id: student.tenant_id, subject_ref: `recommendation_run:${run.id}`, after: { input_snapshot_hash: run.input_snapshot_hash, catalog_snapshot_id: run.catalog_snapshot_id }, meta: { algorithm_version: run.algorithm_version, recomputed: run.recomputed } });
  emit(ctx, 'discovery.recommendation.generated', run.id, { student_id: studentId, recommendation_run_id: run.id }, student.tenant_id);
  return { run, created: true };
}

export function getRecommendation(ctx, runId) {
  const run = ctx.db.recommendation_runs[runId];
  if (!run) throw notFound('recommendation_run');
  authorize(ctx, run.student_id, 'recommendation.read');
  if (ctx.actor.role === 'counselor') audit(ctx, { action: 'access.recommendation_read', tenant_id: run.tenant_id, subject_ref: `recommendation_run:${run.id}`, meta: { purpose: 'counselor_review' } });
  return run;
}

export function listRecommendations(ctx, studentId) {
  authorize(ctx, studentId, 'recommendation.read');
  return runsOf(ctx.db, studentId).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    recomputed: r.recomputed,
    catalog_snapshot_id: r.catalog_snapshot_id,
    algorithm_version: r.algorithm_version,
    changes_since_previous: r.changes_since_previous.length,
    summary: r.output.summary,
  }));
}

// ---------------------------------------------------------------- program catalog (read)

function programView(db, p, now) {
  const rule = activeRuleFor(db, p.program_id, CURRENT_CYCLE);
  const source_state = classifySource(rule, now);
  const uni = UNIVERSITIES[p.university_id];
  return {
    program_id: p.program_id,
    fictional: p.fictional,
    university: { id: p.university_id, name: uni.name, city: uni.city },
    official_name: p.official_name,
    degree_level: p.degree_level,
    instruction_language: p.instruction_language,
    taxonomy_code: p.taxonomy_code,
    field_cluster: p.field_cluster,
    cluster_name: CLUSTERS[p.field_cluster],
    status: db.programs[p.program_id]?.status ?? p.status,
    admission: { cycle: CURRENT_CYCLE, source_state, rule_snapshot_id: rule?.id ?? null, review_due_at: rule?.review_due_at ?? null },
    profile_source: p.profile.source,
  };
}

export function listPrograms(ctx, query) {
  const { db } = ctx;
  let rows = PROGRAMS.map((p) => programView(db, p, ctx.now));
  const q = String(query.q ?? '').trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.official_name.en.toLowerCase().includes(q) || r.official_name['ar-SA'].includes(q));
  if (query.cluster) rows = rows.filter((r) => r.field_cluster === query.cluster);
  if (query.university) rows = rows.filter((r) => r.university.id === query.university);
  if (query.language) rows = rows.filter((r) => r.instruction_language === query.language || r.instruction_language === 'both');
  if (query.source_state) rows = rows.filter((r) => r.admission.source_state === query.source_state);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { total: rows.length, limit, offset, items: rows.slice(offset, offset + limit), facets: { clusters: CLUSTERS, universities: Object.fromEntries(Object.entries(UNIVERSITIES).map(([k, v]) => [k, v.name])) } };
}

export function getProgramDetail(ctx, programId) {
  const p = getProgram(programId);
  if (!p) throw notFound('program');
  const view = programView(ctx.db, p, ctx.now);
  return {
    ...view,
    profile: {
      model_version: p.profile.model_version,
      source: p.profile.source,
      reviewer: p.profile.reviewer,
      riasec: p.profile.riasec,
      subject_relevance: p.profile.subject_relevance,
      values_emphasis: p.profile.values_emphasis,
      skills_emphasis: p.profile.skills_emphasis,
      required_preparation: p.profile.required_preparation,
    },
    pathways: PATHWAYS,
  };
}

export function programAdmissions(ctx, programId, query) {
  const { db } = ctx;
  if (!getProgram(programId)) throw notFound('program');
  const cycle = query.cycle ?? CURRENT_CYCLE;
  if (!/^\d{4}$/.test(cycle)) throw badRequest('invalid_query', '`cycle` must be a year.');
  const rule = activeRuleFor(db, programId, cycle);
  const history = Object.values(db.rule_snapshots).filter((r) => r.program_id === programId && r.cycle === cycle).sort((a, b) => b.version - a.version);
  const steward = ['catalog_steward', 'psychometric_lead', 'platform_security'].includes(ctx.actor.role);
  return {
    program_id: programId,
    cycle,
    source_state: classifySource(rule, ctx.now),
    rule: rule ? publicRule(rule) : null,
    versions: history.map((r) => ({ id: r.id, version: r.version, state: r.state, published_at: r.published_at, review_due_at: r.review_due_at })),
    drafts: steward ? history.filter((r) => r.state === 'draft').map(publicRule) : undefined,
  };
}

export const publicRule = (r) => ({
  id: r.id,
  program_id: r.program_id,
  cycle: r.cycle,
  version: r.version,
  state: r.state,
  rules: r.rules,
  source: r.source,
  effective_from: r.effective_from,
  effective_to: r.effective_to,
  review_due_at: r.review_due_at,
  authored_by: r.authored_by,
  verified_by: r.verified_by,
  conflict_detail: r.conflict_detail,
  published_at: r.published_at,
});

