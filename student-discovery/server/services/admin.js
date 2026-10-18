import { randomUUID } from 'node:crypto';
import { audit, emit, verifyAuditChain } from '../audit.js';
import { requireRole } from '../policy.js';
import { POLICY } from '../config.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { INSTRUMENTS, INSTRUMENT_STATES, getInstrument, instrumentUsability, publicationBlockers } from '../../domain/instruments/registry.js';
import { PROGRAMS, PATHWAYS, getProgram } from '../../domain/catalog/programs.js';
import { own } from '../../domain/util.js';
import { classifySource } from '../../domain/admission/gate.js';
import { CURRENT_CYCLE, activeRuleFor } from './common.js';
import { consentState } from '../policy.js';
import { publicRule } from './recommendations.js';

// ---------------------------------------------------------------- instruments (DISC-12)

export function listInstruments(ctx) {
  requireRole(ctx, 'psychometric_lead', 'platform_security');
  return {
    states: INSTRUMENT_STATES,
    items: INSTRUMENTS.map((i) => {
      const rt = ctx.db.instrument_state[i.instrument_id] ?? null;
      const use = instrumentUsability(i, rt, { syntheticMode: ctx.config.syntheticMode, now: ctx.now });
      return {
        instrument_id: i.instrument_id,
        instrument_version_id: i.instrument_version_id,
        name: i.name,
        version: i.version,
        construct: i.construct,
        items_total: i.items_total,
        item_bank_hash: i.item_bank_hash,
        scoring: i.scoring,
        usage_class: i.usage_class,
        locale_set: i.locale_set,
        governance: i.governance,
        runtime: { state: rt?.state ?? i.governance.state, suspended: Boolean(rt?.suspended), suspended_reason: rt?.suspended_reason ?? null, pending: rt?.pending ?? null },
        usability: use,
        publication_blockers: publicationBlockers(i, rt),
      };
    }),
  };
}

/**
 * Publication is blocked while licence / translation / expert / psychometric evidence is
 * missing. When nothing blocks, promotion needs a SECOND psychometric lead (four-eyes).
 */
export function publishInstrument(ctx, instrumentId, body) {
  const { db, actor } = ctx;
  requireRole(ctx, 'psychometric_lead');
  const inst = getInstrument(instrumentId);
  if (!inst) throw notFound('instrument');
  const target = body?.target_state;
  if (!['approved_for_pilot', 'approved_for_production'].includes(target)) throw badRequest('invalid_target', 'target_state must be approved_for_pilot or approved_for_production.');
  const rt = (db.instrument_state[instrumentId] ??= { state: inst.governance.state, suspended: false, history: [] });
  const blockers = publicationBlockers(inst, rt);
  if (blockers.length) {
    // Recorded after the transaction rolls back (see the request wrapper), so it survives the 409.
    throw conflict('publication_blocked', 'Publication is blocked until the listed evidence exists.', {
      public: { blockers },
      securityEvent: { action: 'instrument.publish_blocked', tenant_id: null, subject_ref: `instrument:${instrumentId}`, meta: { target, blockers } },
    });
  }
  if (!rt.pending || rt.pending.target_state !== target) {
    rt.pending = { target_state: target, requested_by: actor.id, requested_at: ctx.now.toISOString(), reason: String(body.reason ?? '').slice(0, 500) };
    audit(ctx, { action: 'instrument.publish_requested', tenant_id: null, subject_ref: `instrument:${instrumentId}`, meta: { target } });
    return { status: 'awaiting_second_approver', pending: rt.pending };
  }
  if (rt.pending.requested_by === actor.id) throw forbidden('four_eyes_required', 'A different psychometric lead must approve.', { action: 'security.access_denied', tenant_id: null, subject_ref: `instrument:${instrumentId}`, meta: { reason: 'four_eyes_required' } });
  rt.history.push({ from: rt.state, to: target, requested_by: rt.pending.requested_by, approved_by: actor.id, at: ctx.now.toISOString() });
  rt.state = target;
  rt.pending = null;
  audit(ctx, { action: 'instrument.published', tenant_id: null, subject_ref: `instrument:${instrumentId}`, after: { state: target } });
  return { status: 'published', state: target };
}

export function setInstrumentSuspension(ctx, instrumentId, body, suspend) {
  const { db } = ctx;
  requireRole(ctx, 'psychometric_lead');
  const inst = getInstrument(instrumentId);
  if (!inst) throw notFound('instrument');
  const reason = String(body?.reason ?? '').trim();
  if (reason.length < 5) throw unprocessable('reason_required', 'A reason of at least 5 characters is required.');
  const rt = (db.instrument_state[instrumentId] ??= { state: inst.governance.state, suspended: false, history: [] });
  if (rt.suspended === suspend) return { changed: false, suspended: rt.suspended };
  rt.suspended = suspend;
  rt.suspended_reason = suspend ? reason.slice(0, 500) : null;
  rt.history.push({ event: suspend ? 'suspended' : 'resumed', by: ctx.actor.id, reason: reason.slice(0, 500), at: ctx.now.toISOString() });
  audit(ctx, { action: suspend ? 'instrument.suspended' : 'instrument.resumed', tenant_id: null, subject_ref: `instrument:${instrumentId}`, meta: { reason } });
  if (suspend) emit(ctx, 'discovery.instrument.suspended', instrumentId, { instrument_id: instrumentId }, null);
  return { changed: true, suspended: suspend };
}

// ---------------------------------------------------------------- admission rules (DISC-13)

export function listRules(ctx) {
  requireRole(ctx, 'catalog_steward', 'psychometric_lead', 'platform_security');
  const items = PROGRAMS.map((p) => {
    const active = activeRuleFor(ctx.db, p.program_id, CURRENT_CYCLE);
    const all = Object.values(ctx.db.rule_snapshots).filter((r) => r.program_id === p.program_id).sort((a, b) => b.version - a.version);
    return {
      program_id: p.program_id,
      official_name: p.official_name,
      university_id: p.university_id,
      source_state: classifySource(active, ctx.now),
      active: active ? publicRule(active) : null,
      drafts: all.filter((r) => r.state === 'draft').map((r) => publicRule(r)),
      versions: all.map((r) => ({ id: r.id, version: r.version, state: r.state, cycle: r.cycle, published_at: r.published_at })),
    };
  });
  return { cycle: CURRENT_CYCLE, items };
}

const isoDate = (v, field) => {
  const d = new Date(v);
  if (Number.isNaN(+d)) throw unprocessable('invalid_date', `${field} must be a valid date.`);
  return d.toISOString();
};

export function createRuleDraft(ctx, body) {
  const { db, actor } = ctx;
  requireRole(ctx, 'catalog_steward');
  if (!getProgram(body?.program_id)) throw notFound('program');
  const cycle = String(body.cycle ?? CURRENT_CYCLE);
  if (!/^\d{4}$/.test(cycle)) throw unprocessable('invalid_cycle', 'cycle must be a year.');
  const src = body.source ?? {};
  for (const f of ['publisher', 'source_url', 'published_at', 'captured_at']) if (!src[f]) throw unprocessable('source_required', `source.${f} is required (every rule needs provenance).`);
  for (const f of ['effective_from', 'effective_to', 'review_due_at']) if (!body[f]) throw unprocessable('date_required', `${f} is required.`);
  if (!Array.isArray(body.conditions) || !body.conditions.length) throw unprocessable('conditions_required', 'At least one condition is required.');
  const conditions = body.conditions.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw unprocessable('invalid_condition', 'Each condition must be an object.');
    if (!['pathway', 'secondary_percentage', 'gat', 'saat'].includes(c.key)) throw unprocessable('invalid_condition', 'Unsupported condition key.');
    if (c.key === 'pathway') {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      if (!list.length || !list.every((p) => typeof p === 'string' && Object.hasOwn(PATHWAYS, p))) throw unprocessable('invalid_condition', 'pathway must list known pathways.');
      return { key: 'pathway', op: 'in', value: list };
    }
    // Number(null), Number('') and Number([]) are all 0: only real numbers or numeric strings are accepted.
    const n = typeof c.value === 'number' ? c.value : typeof c.value === 'string' && c.value.trim() !== '' ? Number(c.value) : Number.NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) throw unprocessable('invalid_condition', `${c.key} must be a number from 0 to 100.`);
    return { key: c.key, op: 'gte', value: n };
  });
  const prev = Object.values(db.rule_snapshots).filter((r) => r.program_id === body.program_id && r.cycle === cycle);
  const version = Math.max(0, ...prev.map((r) => r.version)) + 1;
  const draft = {
    id: randomUUID(),
    program_id: body.program_id,
    cycle,
    version,
    state: 'draft',
    rules: { conditions, competitive: body.competitive !== false, application_window: body.application_window ?? null },
    source: { publisher: String(src.publisher).slice(0, 200), source_url: String(src.source_url).slice(0, 500), published_at: isoDate(src.published_at, 'source.published_at'), captured_at: isoDate(src.captured_at, 'source.captured_at') },
    effective_from: isoDate(body.effective_from, 'effective_from'),
    effective_to: isoDate(body.effective_to, 'effective_to'),
    review_due_at: isoDate(body.review_due_at, 'review_due_at'),
    authored_by: actor.id,
    verified_by: null,
    conflict_detail: null,
    supersedes_id: activeRuleFor(db, body.program_id, cycle)?.id ?? null,
    created_at: ctx.now.toISOString(),
    published_at: null,
  };
  if (draft.effective_to <= draft.effective_from) throw unprocessable('invalid_dates', 'effective_to must be after effective_from.');
  db.rule_snapshots[draft.id] = draft;
  audit(ctx, { action: 'rule.draft_created', tenant_id: null, subject_ref: `rule:${draft.id}`, after: { program_id: draft.program_id, version, cycle } });
  return publicRule(draft);
}

/** Four-eyes: the verifier must be a different steward from the author. */
export function publishRule(ctx, ruleId) {
  const { db, actor } = ctx;
  requireRole(ctx, 'catalog_steward');
  const r = own(db.rule_snapshots, ruleId);
  if (!r) throw notFound('rule');
  if (r.state !== 'draft') throw conflict('rule_not_draft', `Rule is ${r.state}.`);
  // A draft was written against the rule that was active at the time. If something else was published since,
  // publishing it now would silently replace newer, verified content with older content.
  const current = activeRuleFor(db, r.program_id, r.cycle);
  if ((current?.id ?? null) !== (r.supersedes_id ?? null)) throw conflict('draft_out_of_date', 'A newer rule was published after this draft was written. Create a new draft from the current rule.');
  if (r.authored_by === actor.id) {
    throw forbidden('four_eyes_required', 'A different steward must verify and publish this rule.', { action: 'security.access_denied', tenant_id: null, subject_ref: `rule:${r.id}`, meta: { reason: 'four_eyes_required' } });
  }
  const before = activeRuleFor(db, r.program_id, r.cycle);
  if (before && before.state === 'published') before.state = 'superseded';
  if (before && before.state === 'conflicting') before.state = 'superseded';
  r.state = 'published';
  r.verified_by = actor.id;
  r.published_at = ctx.now.toISOString();
  r.supersedes_id = before?.id ?? null;
  audit(ctx, { action: 'rule.published', tenant_id: null, subject_ref: `rule:${r.id}`, before: before ? { id: before.id, version: before.version } : null, after: { id: r.id, version: r.version }, meta: { program_id: r.program_id, cycle: r.cycle } });
  emit(ctx, 'catalog.admission_rule.published', r.id, { program_id: r.program_id, cycle: r.cycle, version: r.version }, null);
  return publicRule(r);
}

/** Emits `catalog.admission_rule.expired` once per rule whose review date has passed. */
export function sweepExpiredRules(ctx) {
  for (const r of Object.values(ctx.db.rule_snapshots)) {
    if (r.state === 'published' && !r.expiry_notified_at && new Date(r.review_due_at) <= ctx.now) {
      r.expiry_notified_at = ctx.now.toISOString();
      emit(ctx, 'catalog.admission_rule.expired', r.id, { program_id: r.program_id, cycle: r.cycle }, null);
    }
  }
}

// ---------------------------------------------------------------- control tower (DISC-14)

const suppress = (n) => (n < POLICY.min_cell_size ? { suppressed: true, value: null } : { suppressed: false, value: n });

export function controlTower(ctx) {
  const { db, actor } = ctx;
  requireRole(ctx, 'tenant_admin', 'platform_security');
  const scoped = (t) => actor.role === 'platform_security' || t === actor.tenant_id;
  const mine = (rows) => rows.filter((e) => scoped(e.tenant_id));
  // Only students who opted in to aggregate analytics contribute to student-derived numbers.
  const students = Object.values(db.users).filter((u) => u.role === 'student' && scoped(u.tenant_id) && consentState(db, u.id, ctx.now).scopes.aggregate_analytics.active);
  const ids = new Set(students.map((s) => s.id));
  const sessions = Object.values(db.sessions).filter((s) => ids.has(s.student_id));
  const byModule = {};
  for (const s of sessions) {
    const k = `${s.instrument_id}|${s.locale}`;
    byModule[k] ??= { instrument_id: s.instrument_id, locale: s.locale, started: 0, submitted: 0, durations: [] };
    byModule[k].started++;
    if (s.status === 'submitted') {
      byModule[k].submitted++;
      byModule[k].durations.push(new Date(s.submitted_at) - new Date(s.started_at));
    }
  }
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const modules = Object.values(byModule).map((m) => ({
    instrument_id: m.instrument_id,
    locale: m.locale,
    started: suppress(m.started),
    submitted: suppress(m.submitted),
    median_completion_seconds: m.durations.length >= POLICY.min_cell_size ? Math.round(median(m.durations) / 1000) : { suppressed: true, value: null },
  }));

  const sources = { verified_current: 0, stale: 0, conflicting: 0, none: 0, not_published: 0 };
  for (const p of PROGRAMS) sources[classifySource(activeRuleFor(db, p.program_id, CURRENT_CYCLE), ctx.now)]++;
  const denied = db.audit.filter((e) => e.action === 'security.access_denied' && (actor.role === 'platform_security' || e.tenant_id === actor.tenant_id));
  const consentDenials = denied.filter((e) => String(e.meta?.reason ?? '').startsWith('consent_')).length;
  const cases = Object.values(db.cases).filter((c) => ids.has(c.student_id));
  const appeals = cases.filter((c) => c.reason_code === 'appeal' || c.reason_code === 'interpretation_dispute').length;

  return {
    min_cell_size: POLICY.min_cell_size,
    cohort: { opted_in_students: suppress(students.length), sessions: suppress(sessions.length) },
    modules,
    appeals: suppress(appeals),
    catalog_freshness: { programs: PROGRAMS.length, ...sources },
    instruments: INSTRUMENTS.map((i) => ({ instrument_id: i.instrument_id, state: db.instrument_state[i.instrument_id]?.state ?? i.governance.state, suspended: Boolean(db.instrument_state[i.instrument_id]?.suspended) })),
    security: { access_denied_total: denied.length, no_consent_denials: consentDenials },
    // A school admin sees only their own school's operational counters, never platform-wide or other schools' totals.
    operations: {
      outbox_pending: mine(db.outbox.filter((e) => !e.published_at)).length,
      outbox_retrying: mine(db.outbox.filter((e) => !e.published_at && e.retry_count > 0)).length,
      audit_events: mine(db.audit).length,
      audit_chain: actor.role === 'platform_security' ? verifyAuditChain(db) : null,
    },
    incident_mode: { enabled: db.meta.kill_switch.enabled, reason: actor.role === 'platform_security' ? db.meta.kill_switch.reason : null },
  };
}

export function auditLog(ctx, query) {
  requireRole(ctx, 'platform_security');
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  let rows = [...ctx.db.audit].reverse();
  if (query.action) rows = rows.filter((e) => e.action.startsWith(String(query.action)));
  const out = { total: rows.length, chain: verifyAuditChain(ctx.db), items: rows.slice(offset, offset + limit) };
  // Reading the audit log is itself recorded (written after the result is built, so it appears from the next read).
  audit(ctx, { action: 'access.audit_read', tenant_id: null, subject_ref: 'audit_log', meta: { filter: query.action ? String(query.action).slice(0, 60) : null, returned: out.items.length } });
  return out;
}

export function setKillSwitch(ctx, body) {
  requireRole(ctx, 'platform_security');
  if (typeof body?.enabled !== 'boolean') throw badRequest('invalid_body', '`enabled` must be true or false.');
  const reason = String(body.reason ?? '').trim();
  if (body.enabled && reason.length < 5) throw unprocessable('reason_required', 'A reason of at least 5 characters is required.');
  const ks = ctx.db.meta.kill_switch;
  Object.assign(ks, { enabled: body.enabled, reason: body.enabled ? reason.slice(0, 500) : null, by: ctx.actor.id, at: ctx.now.toISOString() });
  audit(ctx, { action: body.enabled ? 'killswitch.enabled' : 'killswitch.disabled', tenant_id: null, subject_ref: 'module:student_discovery', meta: { reason } });
  return ks;
}
