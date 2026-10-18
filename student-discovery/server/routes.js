// Route table. Base path /api/v1/discovery (spec §8). Identity endpoints live under
// /api/v1/identity-stub because they stand in for NextMind's real identity service.
import { reply } from './http.js';
import { POLICY, CONSENT_SCOPES } from './config.js';
import { forbidden, notFound } from './errors.js';
import { audit } from './audit.js';
import * as consent from './services/consent.js';
import * as assess from './services/assessments.js';
import * as student from './services/student.js';
import * as reco from './services/recommendations.js';
import * as counselor from './services/counselor.js';
import * as reports from './services/reports.js';
import * as advisor from './services/advisor.js';
import * as admin from './services/admin.js';
import * as assignments from './services/assignments.js';
import { TENANTS } from './seed.js';
import { own } from '../domain/util.js';
import { linkActive } from './policy.js';

const B = '/api/v1/discovery';
const ID = '/api/v1/identity-stub';

const deniedRole = (ctx, why) =>
  forbidden('role_not_permitted', why, { action: 'security.access_denied', tenant_id: ctx.actor?.tenant_id ?? null, subject_ref: null, meta: { reason: 'role_not_permitted' } });

/** The student identity is resolved from the token, never from the request body (spec §8.1). */
const self = (ctx) => {
  if (ctx.actor.role !== 'student') throw deniedRole(ctx, 'Only a student can do this for themselves.');
  return ctx.actor.id;
};

/** Students a guardian is linked to (UI convenience only; every data call is still authorized server-side). */
function linkedStudents(ctx) {
  const { db, actor } = ctx;
  if (actor?.role !== 'guardian') return [];
  return db.guardian_links.filter((l) => linkActive(l, actor.id, l.student_id, ctx.now)).map((l) => publicPersona(db.users[l.student_id]));
}

const publicPersona = (u) => ({ id: u.id, role: u.role, tenant_id: u.tenant_id, display_name: u.display_name, grade: u.grade ?? null, synthetic: true });

export function registerRoutes(router, { sessions, clock }) {
  const get = (p, h, o) => router.add('GET', p, h, o);
  const post = (p, h, o) => router.add('POST', p, h, o);
  const put = (p, h, o) => router.add('PUT', p, h, o);
  const del = (p, h, o) => router.add('DELETE', p, h, o);
  const patch = (p, h, o) => router.add('PATCH', p, h, o);
  const during = { allowDuringIncident: true };

  // ------------------------------------------------------------ platform / identity stand-in
  get('/api/health', (ctx) => ({ status: 'ok', synthetic_mode: ctx.config.syntheticMode, incident_mode: ctx.db.meta.kill_switch.enabled }), { public: true, ...during });

  get(`${ID}/personas`, (ctx) => ({
    notice: 'Synthetic personas for the local prototype. This is not authentication.',
    tenants: TENANTS,
    items: Object.values(ctx.db.users).map(publicPersona),
  }), { public: true, ...during });

  post(`${ID}/login`, (ctx) => {
    const p = own(ctx.db.users, ctx.body?.persona_id);
    if (!p) throw notFound('persona');
    const s = sessions.login(p.id);
    audit({ ...ctx, actor: p }, { action: 'identity_stub.login', tenant_id: p.tenant_id, subject_ref: `user:${p.id}`, meta: { synthetic: true } });
    return reply(200, { persona: publicPersona(p), csrf_token: s.csrf }, { 'Set-Cookie': `sd_session=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(POLICY.session_ttl_ms / 1000)}` });
  }, { public: true, noCsrf: true, ...during });

  post(`${ID}/logout`, (ctx) => {
    if (ctx.session) sessions.destroy(ctx.session.token);
    return reply(200, { ok: true }, { 'Set-Cookie': 'sd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }, { public: true, noCsrf: true, tx: false, ...during });

  get(`${ID}/me`, (ctx) => ({
    authenticated: Boolean(ctx.actor),
    persona: ctx.actor ? publicPersona(ctx.actor) : null,
    csrf_token: ctx.session?.csrf ?? null,
    linked_students: linkedStudents(ctx),
    synthetic_mode: ctx.config.syntheticMode,
    // The free-text reason may describe an ongoing incident; only the security role sees it.
    incident_mode: ctx.actor?.role === 'platform_security' ? ctx.db.meta.kill_switch : { enabled: ctx.db.meta.kill_switch.enabled },
    consent_scopes: Object.keys(CONSENT_SCOPES),
    policy: { policy_version: POLICY.policy_version, legal_basis_ref: POLICY.legal_basis_ref, guardian_required_below_age: POLICY.guardian_required_below_age },
    server_time: clock().toISOString(),
  }), { public: true, tx: false, ...during });

  // ------------------------------------------------------------ assessments & sessions
  get(`${B}/assessments`, (ctx) => assess.listAssessments(ctx, self(ctx)));
  get(`${B}/students/:id/assessments`, (ctx) => assess.listAssessments(ctx, ctx.params.id));
  post(`${B}/sessions`, (ctx) => {
    const out = assess.createSession(ctx, self(ctx), ctx.body ?? {});
    return reply(out.created ? 201 : 200, { ...out.session, created: out.created });
  });
  get(`${B}/sessions/:id`, (ctx) => assess.getSession(ctx, ctx.params.id), { tx: false });
  put(`${B}/sessions/:id/responses/:itemId`, (ctx) => {
    const out = assess.putResponse(ctx, ctx.params.id, ctx.params.itemId, ctx.body, ctx.headers['if-match']);
    return reply(200, out, { ETag: `"${out.revision_seq}"` });
  });
  post(`${B}/sessions/:id/submit`, (ctx) => {
    const out = assess.submitSession(ctx, ctx.params.id, ctx.body ?? {});
    return reply(out.already_submitted ? 200 : 201, out);
  });
  get(`${B}/sessions/:id/score`, (ctx) => assess.getScore(ctx, ctx.params.id), { tx: true });
  get(`${B}/sessions/:id/responses`, (ctx) => assess.getRawResponses(ctx, ctx.params.id), { tx: true });
  post(`${B}/sessions/:id/replay`, (ctx) => assess.replaySession(ctx, ctx.params.id));

  // ------------------------------------------------------------ student data
  get(`${B}/students/:id/discovery-profile`, (ctx) => student.discoveryProfile(ctx, ctx.params.id), { tx: true });
  get(`${B}/students/:id/consent`, (ctx) => consent.getConsent(ctx, ctx.params.id), { tx: true });
  post(`${B}/students/:id/consent`, (ctx) => consent.setConsent(ctx, ctx.params.id, ctx.body), during);
  get(`${B}/students/:id/evidence`, (ctx) => student.listEvidence(ctx, ctx.params.id), { tx: true });
  put(`${B}/students/:id/evidence/:type`, (ctx) => student.putEvidence(ctx, ctx.params.id, ctx.params.type, ctx.body));
  post(`${B}/students/:id/evidence/:evidenceId/verify`, (ctx) => student.verifyEvidence(ctx, ctx.params.id, ctx.params.evidenceId, ctx.body));
  put(`${B}/students/:id/preferences`, (ctx) => student.putPreferences(ctx, ctx.params.id, ctx.body));
  put(`${B}/students/:id/aspirations/:programId`, (ctx) => student.putAspiration(ctx, ctx.params.id, ctx.params.programId, ctx.body));
  del(`${B}/students/:id/aspirations/:programId`, (ctx) => student.deleteAspiration(ctx, ctx.params.id, ctx.params.programId));
  get(`${B}/students/:id/guardian-summary`, (ctx) => student.guardianSummary(ctx, ctx.params.id), { tx: true });

  // ------------------------------------------------------------ recommendations & programs
  post(`${B}/students/:id/recommendations`, (ctx) => {
    const out = reco.createRecommendation(ctx, ctx.params.id);
    return reply(out.created ? 201 : 200, { ...out.run, reused: !out.created });
  });
  get(`${B}/students/:id/recommendations`, (ctx) => reco.listRecommendations(ctx, ctx.params.id), { tx: true });
  get(`${B}/recommendations/:runId`, (ctx) => reco.getRecommendation(ctx, ctx.params.runId), { tx: true });
  get(`${B}/programs`, (ctx) => reco.listPrograms(ctx, ctx.query), { tx: false });
  get(`${B}/programs/:id`, (ctx) => reco.getProgramDetail(ctx, ctx.params.id), { tx: false });
  get(`${B}/programs/:id/admissions`, (ctx) => reco.programAdmissions(ctx, ctx.params.id, ctx.query), { tx: false });

  // ------------------------------------------------------------ cases, notes, overrides
  const openCase = (ctx) => reply(201, counselor.openCase(ctx, ctx.params.id, ctx.body));
  post(`${B}/students/:id/cases`, openCase);
  post(`${B}/students/:id/counselor-review`, openCase); // spec route name
  get(`${B}/students/:id/cases`, (ctx) => counselor.listStudentCases(ctx, ctx.params.id), { tx: true });
  patch(`${B}/cases/:id`, (ctx) => counselor.updateCase(ctx, ctx.params.id, ctx.body));
  post(`${B}/students/:id/notes`, (ctx) => reply(201, counselor.addNote(ctx, ctx.params.id, ctx.body)));
  post(`${B}/students/:id/overrides`, (ctx) => reply(201, counselor.createOverride(ctx, ctx.params.id, ctx.body)));
  get(`${B}/counselor/queue`, (ctx) => counselor.counselorQueue(ctx), { tx: false });
  get(`${B}/students/:id/case360`, (ctx) => counselor.caseView(ctx, ctx.params.id, ctx.query), { tx: true });
  post(`${B}/students/:id/conflict-of-interest`, (ctx) => assignments.declareConflict(ctx, ctx.params.id, ctx.body));

  // ------------------------------------------------------------ reports
  post(`${B}/students/:id/reports`, (ctx) => {
    const out = reports.generateReport(ctx, ctx.params.id);
    return reply(out.created ? 201 : 200, { ...out.report, created: out.created });
  });
  get(`${B}/students/:id/reports`, (ctx) => reports.listReports(ctx, ctx.params.id), { tx: true });
  get(`${B}/reports/:id`, (ctx) => reports.getReport(ctx, ctx.params.id), { tx: true });
  get(`${B}/reports/:id/pdf`, (ctx) => reports.prepareReportPdf(ctx, ctx.params.id, ctx.query), { tx: true, finish: async (ctx, job) => {
    const { pdf, filename } = await reports.renderReportPdf(ctx, job);
    return reply(200, pdf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
  } });
  post(`${B}/reports/:id/review-request`, (ctx) => reports.requestReview(ctx, ctx.params.id));
  post(`${B}/reports/:id/approval`, (ctx) => reports.decideReport(ctx, ctx.params.id, ctx.body));
  post(`${B}/reports/:id/shares`, (ctx) => reply(201, reports.shareReport(ctx, ctx.params.id, ctx.body ?? {})));
  del(`${B}/shares/:id`, (ctx) => reports.revokeShare(ctx, ctx.params.id));

  // ------------------------------------------------------------ advisor (explain only)
  post(`${B}/advisor/tools/get_student_discovery_summary`, (ctx) => advisor.getStudentDiscoverySummary(ctx, ctx.body ?? {}));
  post(`${B}/students/:id/advisor/explain`, (ctx) => advisor.explain(ctx, ctx.params.id, ctx.body ?? {}));

  // ------------------------------------------------------------ admin / governance
  get(`${B}/admin/instruments`, (ctx) => admin.listInstruments(ctx), { tx: false });
  post(`${B}/admin/instruments/:id/publish`, (ctx) => admin.publishInstrument(ctx, ctx.params.id, ctx.body ?? {}));
  post(`${B}/admin/instruments/:id/suspend`, (ctx) => admin.setInstrumentSuspension(ctx, ctx.params.id, ctx.body, true));
  post(`${B}/admin/instruments/:id/resume`, (ctx) => admin.setInstrumentSuspension(ctx, ctx.params.id, ctx.body, false));
  get(`${B}/admin/program-rules`, (ctx) => admin.listRules(ctx), { tx: false });
  post(`${B}/admin/program-rules`, (ctx) => reply(201, admin.createRuleDraft(ctx, ctx.body ?? {})));
  post(`${B}/admin/program-rules/:id/publish`, (ctx) => admin.publishRule(ctx, ctx.params.id));
  get(`${B}/admin/assignments`, (ctx) => assignments.listAssignments(ctx), { tx: false });
  post(`${B}/admin/assignments`, (ctx) => assignments.reassign(ctx, ctx.body));
  get(`${B}/admin/control-tower`, (ctx) => admin.controlTower(ctx), { tx: false, ...during });
  get(`${B}/admin/audit`, (ctx) => admin.auditLog(ctx, ctx.query), { tx: true, ...during });
  post(`${B}/admin/kill-switch`, (ctx) => admin.setKillSwitch(ctx, ctx.body), during);

}
