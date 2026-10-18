import { randomUUID } from 'node:crypto';
import { audit, emit } from '../audit.js';
import { activeAssignment, authorize } from '../policy.js';
import { POLICY } from '../config.js';
import { badRequest, conflict, forbidden, unprocessable } from '../errors.js';
import { hashOf } from '../../domain/util.js';
import { VERIFIED_STATES } from '../../domain/admission/gate.js';
import { buildReportHtml, PDF_LOCALES } from '../reportHtml.js';
import { pdfUnavailable } from '../pdf.js';
import { latestScoreRuns, nextSeq, studentEvidenceMap, byId, auditCounselorRead } from './common.js';

const LIMITATIONS = ['interest_unvalidated', 'no_norms_or_percentiles', 'aptitude_on_hold', 'not_an_admission_decision', 'fictional_catalog'];

function scoreSection(run) {
  if (!run) return { status: 'incomplete_evidence' };
  return {
    status: 'sealed',
    score_run_id: run.id,
    execution_hash: run.execution_hash,
    algorithm_version: run.algorithm_version,
    construct_scores: run.construct_scores,
    top: run.ranking?.top ?? null,
    ranking_complete: run.ranking?.complete ?? null,
  };
}

/** The payload is what a human approves; its hash is what the approval is bound to. */
function buildPayload(ctx, student) {
  const { db } = ctx;
  const runs = latestScoreRuns(db, student.id);
  const reco = Object.values(db.recommendation_runs).filter((r) => r.student_id === student.id).sort((a, b) => b.seq - a.seq)[0] ?? null;
  const ev = studentEvidenceMap(db, student.id);
  const evidenceTypes = ['pathway', 'secondary_percentage', 'gat', 'saat'];
  const overrides = Object.values(db.overrides).filter((o) => o.student_id === student.id && o.visibility === 'student').sort((a, b) => a.seq - b.seq);
  return {
    schema: 'discovery-report/1',
    student: { display_name: student.display_name, grade: student.grade },
    sections: {
      expressed_interests: scoreSection(runs.interest_exploratory),
      subject_preferences: scoreSection(runs.subject_preference_exploratory),
      work_values: scoreSection(runs.work_values_exploratory),
      self_reported_confidence: scoreSection(runs.skills_confidence_selfreport),
      demonstrated_capabilities: { status: 'not_available', reason: 'aptitude_on_hold' },
      recommendations: reco
        ? {
            recommendation_run_id: reco.id,
            catalog_snapshot_id: reco.catalog_snapshot_id,
            algorithm_version: reco.algorithm_version,
            items: reco.output.items.slice(0, 8).map((i) => ({
              program_id: i.program_id,
              rank: i.rank_if_available,
              interest_fit: i.interest_fit.value,
              eligibility: i.admission_status.eligibility,
              source_state: i.admission_status.source_state,
              rule_snapshot_id: i.admission_status.rule_snapshot_id,
              missing_inputs: i.missing_inputs,
            })),
          }
        : null,
      evidence_completeness: {
        present: evidenceTypes.filter((t) => ev[t]).length,
        verified: evidenceTypes.filter((t) => ev[t] && VERIFIED_STATES.includes(ev[t].verification_state)).length,
        total: evidenceTypes.length,
      },
      counselor_interpretation: overrides.map((o) => ({ override_id: o.id, score_run_id: o.score_run_id, text: o.text })),
    },
    limitations: LIMITATIONS,
    sources: {
      score_run_ids: Object.values(runs).map((r) => r.id).sort(),
      recommendation_run_id: reco?.id ?? null,
      rule_snapshot_ids: reco ? [...new Set(reco.output.items.map((i) => i.admission_status.rule_snapshot_id).filter(Boolean))].sort() : [],
    },
  };
}

export function generateReport(ctx, studentId) {
  const { db } = ctx;
  const { student } = authorize(ctx, studentId, 'report.generate');
  const payload = buildPayload(ctx, student);
  if (!payload.sources.score_run_ids.length) throw unprocessable('no_sealed_results', 'Complete and submit at least one module before creating a report.');
  const payload_hash = hashOf(payload);
  const existing = Object.values(db.reports).find((r) => r.student_id === studentId && r.payload_hash === payload_hash);
  if (existing) return { report: existing, created: false };
  const report = {
    id: randomUUID(),
    seq: nextSeq(db.reports),
    tenant_id: student.tenant_id,
    student_id: studentId,
    status: 'draft',
    payload,
    payload_hash,
    created_by: ctx.actor.id,
    created_at: ctx.now.toISOString(),
    review_requested_at: null,
    decided_at: null,
    approval_id: null,
  };
  db.reports[report.id] = report;
  audit(ctx, { action: 'report.generated', tenant_id: report.tenant_id, subject_ref: `report:${report.id}`, after: { payload_hash } });
  return { report, created: true };
}

export function requestReview(ctx, reportId) {
  const { db } = ctx;
  const r = byId(ctx, db.reports, reportId, 'report');
  authorize(ctx, r.student_id, 'report.generate');
  if (r.status === 'review_requested') return r;
  if (r.status !== 'draft') throw conflict('report_not_draft', `Report is ${r.status}.`);
  r.status = 'review_requested';
  r.review_requested_at = ctx.now.toISOString();
  const assignee = activeAssignment(db, r.student_id)?.counselor_id ?? null;
  const caseId = randomUUID();
  db.cases[caseId] = { id: caseId, seq: nextSeq(db.cases), tenant_id: r.tenant_id, student_id: r.student_id, reason_code: 'report_review', status: 'open', opened_by: { id: ctx.actor.id, role: ctx.actor.role }, assignee_id: assignee, student_message: null, subject_ref: `report:${r.id}`, created_at: r.review_requested_at, updated_at: r.review_requested_at, resolved_at: null, resolution: null, next_review_at: null };
  audit(ctx, { action: 'report.review_requested', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, after: { payload_hash: r.payload_hash } });
  emit(ctx, 'discovery.report.review_requested', r.id, { student_id: r.student_id, report_id: r.id }, r.tenant_id);
  return r;
}

/** Approval is bound to the exact payload hash (spec J-05, AC: hash must match). */
export function decideReport(ctx, reportId, body) {
  const { db } = ctx;
  const r = byId(ctx, db.reports, reportId, 'report');
  authorize(ctx, r.student_id, 'report.approve');
  const action = body?.action;
  if (!['approve', 'reject'].includes(action)) throw badRequest('invalid_action', "action must be 'approve' or 'reject'.");
  if (r.status !== 'review_requested') throw conflict('report_not_in_review', `Report is ${r.status}; only a report in review can be decided.`);
  // Separation of duties: whoever created the report cannot be the one to approve it.
  if (r.created_by === ctx.actor.id) {
    throw forbidden('separation_of_duties', 'The person who created a report cannot approve it.', { action: 'security.access_denied', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, meta: { reason: 'separation_of_duties' } });
  }
  // The stored content must still hash to the recorded fingerprint, otherwise an approval would sign altered content.
  if (hashOf(r.payload) !== r.payload_hash) throw conflict('report_integrity_failure', 'The stored report no longer matches its fingerprint.');
  if (body.payload_hash !== r.payload_hash) throw conflict('payload_hash_mismatch', 'The report content you reviewed is not the current content.', { public: { current_payload_hash: r.payload_hash } });
  const reason = String(body.reason ?? '').trim();
  if (action === 'reject' && reason.length < 5) throw unprocessable('reason_required', 'Say why the report is rejected.');
  const approval = { id: randomUUID(), subject_type: 'report', subject_id: r.id, exact_payload_hash: r.payload_hash, approver_id: ctx.actor.id, action, reason: reason.slice(0, 1000), timestamp: ctx.now.toISOString() };
  db.approvals[approval.id] = approval;
  r.status = action === 'approve' ? 'approved' : 'rejected';
  r.approval_id = approval.id;
  r.decided_at = approval.timestamp;
  for (const c of Object.values(db.cases)) if (c.subject_ref === `report:${r.id}` && c.student_id === r.student_id && c.status !== 'resolved') Object.assign(c, { status: 'resolved', resolved_at: approval.timestamp, updated_at: approval.timestamp, resolution: `Report ${r.status}.` });
  audit(ctx, { action: action === 'approve' ? 'report.approved' : 'report.rejected', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, after: { payload_hash: r.payload_hash, approval_id: approval.id } });
  if (action === 'approve') emit(ctx, 'discovery.report.approved', r.id, { student_id: r.student_id, report_id: r.id }, r.tenant_id);
  return { report: r, approval };
}

export function listReports(ctx, studentId) {
  const { student } = authorize(ctx, studentId, 'report.read');
  auditCounselorRead(ctx, student, 'access.reports_read');
  return Object.values(ctx.db.reports)
    .filter((r) => r.student_id === studentId)
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, payload_hash: r.payload_hash, review_requested_at: r.review_requested_at, decided_at: r.decided_at }));
}

const activeShare = (db, reportId, now) => Object.values(db.shares).find((s) => s.report_id === reportId && s.recipient_role === 'guardian' && !s.revoked_at && new Date(s.expires_at) > now);

export function getReport(ctx, reportId) {
  const { db, actor } = ctx;
  const r = byId(ctx, db.reports, reportId, 'report');
  if (actor?.role === 'guardian') {
    authorize(ctx, r.student_id, 'guardian.summary'); // relationship + processing + guardian_summary_sharing
    const share = activeShare(db, r.id, ctx.now);
    if (r.status !== 'approved' || !share) {
      throw forbidden('report_not_shared', 'This report has not been shared with you, or the share has expired.', { action: 'security.access_denied', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, meta: { reason: 'report_not_shared' } });
    }
    audit(ctx, { action: 'access.report_guardian', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, meta: { share_id: share.id } });
    return reportView(db, r, { share });
  }
  authorize(ctx, r.student_id, 'report.read');
  if (actor.role === 'counselor') audit(ctx, { action: 'access.report_read', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, meta: { purpose: 'counselor_review' } });
  return reportView(db, r, { shares: Object.values(db.shares).filter((s) => s.report_id === r.id) });
}

function reportView(db, r, extra) {
  const approval = r.approval_id ? db.approvals[r.approval_id] : null;
  return {
    id: r.id,
    student_id: r.student_id,
    status: r.status,
    watermark: r.status === 'approved' ? null : 'DRAFT', // spec DISC-09: watermark draft
    payload: r.payload,
    payload_hash: r.payload_hash,
    created_at: r.created_at,
    review_requested_at: r.review_requested_at,
    decided_at: r.decided_at,
    approval: approval ? { id: approval.id, action: approval.action, timestamp: approval.timestamp, exact_payload_hash: approval.exact_payload_hash } : null,
    ...extra,
  };
}

export function shareReport(ctx, reportId, body) {
  const { db } = ctx;
  const r = byId(ctx, db.reports, reportId, 'report');
  authorize(ctx, r.student_id, 'report.share');
  if (r.status !== 'approved') throw conflict('report_not_approved', 'Only a counselor-approved report can be shared.');
  const consent = authorize(ctx, r.student_id, 'consent.read').consent;
  if (!consent.scopes.guardian_summary_sharing.active) throw forbidden('consent_scope_inactive', 'Turn on guardian summary sharing first.', { action: 'security.access_denied', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, meta: { reason: 'consent_scope_inactive' } });
  const days = Number(body?.days ?? POLICY.report_share_default_days);
  if (!Number.isInteger(days) || days < 1 || days > POLICY.report_share_max_days) throw badRequest('invalid_days', `days must be 1-${POLICY.report_share_max_days}.`);
  const existing = activeShare(db, r.id, ctx.now);
  if (existing) existing.revoked_at = ctx.now.toISOString();
  const share = { id: randomUUID(), report_id: r.id, student_id: r.student_id, tenant_id: r.tenant_id, recipient_role: 'guardian', purpose: 'guardian_summary', created_by: ctx.actor.id, created_at: ctx.now.toISOString(), expires_at: new Date(+ctx.now + days * 86400000).toISOString(), revoked_at: null, revoked_reason: null };
  db.shares[share.id] = share;
  audit(ctx, { action: 'report.shared', tenant_id: r.tenant_id, subject_ref: `report:${r.id}`, after: { share_id: share.id, expires_at: share.expires_at }, meta: { recipient: 'guardian' } });
  return share;
}

export function revokeShare(ctx, shareId) {
  const { db } = ctx;
  const s = byId(ctx, db.shares, shareId, 'share');
  authorize(ctx, s.student_id, 'report.share');
  if (!s.revoked_at) {
    s.revoked_at = ctx.now.toISOString();
    s.revoked_reason = 'revoked_by_student';
    audit(ctx, { action: 'report.share_revoked', tenant_id: s.tenant_id, subject_ref: `report:${s.report_id}`, after: { share_id: s.id } });
  }
  return s;
}

// ---------------------------------------------------------------- PDF export (approved reports only)

/**
 * Phase one, inside the transaction: authorize exactly like reading the report, require approval, record the
 * export, and hand over the page to print. Rendering happens afterwards (see the route's `finish`).
 * Nothing user-specific is printed, so the same approved content and language always produce the same file.
 */
export function prepareReportPdf(ctx, reportId, query) {
  const locale = query?.locale ?? 'ar-SA';
  if (!PDF_LOCALES.includes(locale)) throw badRequest('invalid_locale', `locale must be one of: ${PDF_LOCALES.join(', ')}`);
  const view = getReport(ctx, reportId); // same authorization as the screen: owner, assigned counselor with consent, or a guardian through an active share
  if (view.status !== 'approved') throw conflict('report_not_approved', 'Only a counselor-approved report can be exported as PDF.');
  if (!ctx.pdf?.available()) throw pdfUnavailable();
  const tenant_id = ctx.db.reports[view.id].tenant_id;
  audit(ctx, { action: 'report.exported', tenant_id, subject_ref: `report:${view.id}`, after: { payload_hash: view.payload_hash }, meta: { format: 'pdf', locale } });
  return {
    report_id: view.id,
    tenant_id,
    locale,
    html: buildReportHtml(view, locale),
    cache_key: `${view.id}:${view.payload_hash}:${view.approval.id}:${locale}`,
    filename: `discovery-report-${view.id.slice(0, 8)}-${locale === 'en' ? 'en' : 'ar'}.pdf`,
  };
}

/** Phase two, after the commit. A failed render is recorded; the caller still sees the problem. */
export async function renderReportPdf(ctx, job) {
  try {
    return { pdf: await ctx.pdf.render(job.html, job.cache_key), filename: job.filename };
  } catch (e) {
    try {
      ctx.store.tx((db) => audit({ ...ctx, db }, { action: 'report.export_failed', tenant_id: job.tenant_id, subject_ref: `report:${job.report_id}`, meta: { format: 'pdf', status: e.status ?? 500 } }));
    } catch (auditErr) {
      console.error('audit of failed export failed', auditErr);
    }
    throw e;
  }
}
