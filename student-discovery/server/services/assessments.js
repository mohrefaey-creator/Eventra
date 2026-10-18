import { randomUUID } from 'node:crypto';
import { audit, emit } from '../audit.js';
import { authorize } from '../policy.js';
import { POLICY } from '../config.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { SCALES } from '../../domain/instruments/scales.js';
import { MODULE_SEQUENCE, DURATION_ESTIMATE_MIN, getInstrument, getInstrumentByVersionId, instrumentUsability } from '../../domain/instruments/registry.js';
import { computeScore, replayScore, completeness, storedPayloadIntact } from '../../domain/scoring/index.js';
import { validateResponse, ValidationError } from '../../domain/validation.js';
import { nextSeq, sessionResponses, instrumentOf, byId } from './common.js';

const usability = (ctx, instrument) =>
  instrumentUsability(instrument, ctx.db.instrument_state[instrument.instrument_id], { syntheticMode: ctx.config.syntheticMode, now: ctx.now });

/** The client never receives anything beyond what it needs to render an item (no keys exist for self-report). */
function publicItem(item) {
  return {
    item_id: item.item_id,
    construct: item.construct,
    content: item.content,
    response_type: item.response_type,
    scale: item.scale,
    options: item.options ?? null,
    status: item.status,
  };
}

const publicInstrument = (i) => ({
  instrument_id: i.instrument_id,
  instrument_version_id: i.instrument_version_id,
  version: i.version,
  name: i.name,
  purpose: i.purpose,
  stem: i.stem,
  construct: i.construct,
  items_total: i.items_total,
  locale_set: i.locale_set,
  usage_class: i.usage_class,
  interpretation_warning: i.governance.interpretation_warning,
});

const studentSessions = (db, studentId, instrumentId) =>
  Object.values(db.sessions)
    .filter((s) => s.student_id === studentId && (!instrumentId || s.instrument_id === instrumentId))
    .sort((a, b) => a.seq - b.seq);

export function moduleCards(ctx, studentId) {
  const { db } = ctx;
  const cards = MODULE_SEQUENCE.map((id) => {
    const inst = getInstrument(id);
    const use = usability(ctx, inst);
    const sessions = studentSessions(db, studentId, id);
    const last = sessions.at(-1) ?? null;
    const submitted = sessions.filter((s) => s.status === 'submitted');
    const answered = last ? Object.values(sessionResponses(db, last.id)).length : 0;
    let status;
    let blocked_reason = null;
    if (!use.usable && !last) status = 'unavailable';
    else if (!use.usable) status = 'needs_review';
    else if (!last) status = 'not_started';
    else if (last.status === 'submitted') status = 'completed';
    else if (last.status === 'suspended_consent') {
      status = 'in_progress';
      blocked_reason = 'consent_required';
    } else status = 'in_progress';
    const canRetake =
      use.usable &&
      Boolean(last) &&
      last.status === 'submitted' &&
      submitted.length < POLICY.retake.max_attempts &&
      (POLICY.retake.min_days_between === 0 || ctx.now - new Date(last.submitted_at) >= POLICY.retake.min_days_between * 86400000);
    return {
      ...publicInstrument(inst),
      duration_estimate_min: DURATION_ESTIMATE_MIN[id],
      usable: use.usable,
      unavailable_reason: use.reason,
      hold_reason: inst.usage_class === 'hold' ? inst.governance.hold_reason : null,
      status,
      blocked_reason,
      session_id: last && last.status !== 'submitted' ? last.id : null,
      last_session_id: last?.id ?? null,
      progress: last ? { answered, total: inst.items_total } : { answered: 0, total: inst.items_total },
      attempts: submitted.length,
      last_submitted_at: submitted.at(-1)?.submitted_at ?? null,
      can_retake: canRetake,
    };
  });
  return cards;
}

export function listAssessments(ctx, studentId) {
  authorize(ctx, studentId, 'session.read');
  return { sequence: MODULE_SEQUENCE, modules: moduleCards(ctx, studentId) };
}

export function createSession(ctx, studentId, body) {
  const { db } = ctx;
  const { student, consent } = authorize(ctx, studentId, 'session.create'); // AC-01: no consent => 403 consent_required
  const instrument = getInstrumentByVersionId(body?.instrument_version_id);
  if (!instrument) throw badRequest('unknown_instrument', 'Unknown instrument_version_id.');
  const idem = body.idempotency_key;
  if (typeof idem !== 'string' || idem.length < 8 || idem.length > 64) throw badRequest('invalid_body', '`idempotency_key` (8-64 chars) is required.');
  const locale = body.locale ?? 'ar-SA';

  const sessions = studentSessions(db, studentId, instrument.instrument_id);
  const same = sessions.find((s) => s.idempotency_key === idem);
  if (same) return { session: sessionSummary(db, same), created: false };

  const use = usability(ctx, instrument);
  if (!use.usable) throw conflict('instrument_unavailable', 'This instrument cannot be started.', { reason: use.reason, public: { reason: use.reason, replacement: use.reason === 'instrument_retired' ? 'ask_counselor' : null } }); // AC-06
  if (!instrument.locale_set.includes(locale)) throw badRequest('unsupported_locale', `Locale ${locale} is not available for this instrument.`);

  const open = sessions.find((s) => s.status === 'in_progress' || s.status === 'suspended_consent');
  if (open) return { session: sessionSummary(db, open), created: false };

  const submitted = sessions.filter((s) => s.status === 'submitted');
  if (submitted.length >= POLICY.retake.max_attempts) throw conflict('retake_limit_reached', 'The maximum number of attempts has been reached.', { public: { max_attempts: POLICY.retake.max_attempts } });
  const last = submitted.at(-1);
  if (last && POLICY.retake.min_days_between > 0 && ctx.now - new Date(last.submitted_at) < POLICY.retake.min_days_between * 86400000) {
    throw conflict('retake_too_soon', 'Retake is not available yet.', { public: { min_days_between: POLICY.retake.min_days_between } });
  }
  if (body.consent_record_id) {
    const rec = db.consent_records[body.consent_record_id];
    if (!rec || rec.subject_id !== studentId || rec.scope !== 'assessment_processing' || rec.state !== 'granted') {
      throw unprocessable('invalid_consent_record', '`consent_record_id` is not an active processing consent for this student.');
    }
  }

  const session = {
    id: randomUUID(),
    seq: nextSeq(db.sessions),
    tenant_id: student.tenant_id,
    student_id: studentId,
    instrument_id: instrument.instrument_id,
    instrument_version_id: instrument.instrument_version_id,
    locale,
    status: 'in_progress',
    attempt_no: submitted.length + 1,
    consent_snapshot_id: [consent.scopes.assessment_processing.parties.student.record_id, consent.scopes.assessment_processing.parties.guardian.record_id].filter(Boolean).join('+'),
    mode: use.mode,
    started_at: ctx.now.toISOString(),
    last_activity_at: ctx.now.toISOString(),
    submitted_at: null,
    idempotency_key: idem,
  };
  db.sessions[session.id] = session;
  audit(ctx, { action: 'session.started', tenant_id: session.tenant_id, subject_ref: `session:${session.id}`, after: { instrument: session.instrument_version_id, attempt: session.attempt_no }, meta: { mode: use.mode } });
  emit(ctx, 'discovery.session.started', session.id, { student_id: studentId, instrument_version_id: session.instrument_version_id }, session.tenant_id);
  return { session: sessionSummary(db, session), created: true };
}

function sessionSummary(db, s) {
  const inst = instrumentOf(s);
  return {
    session_id: s.id,
    status: s.status,
    locale: s.locale,
    instrument_version: inst.version,
    instrument_id: s.instrument_id,
    instrument_version_id: s.instrument_version_id,
    items_total: inst.items_total,
    progress: { answered: Object.keys(sessionResponses(db, s.id)).length },
    attempt_no: s.attempt_no,
    started_at: s.started_at,
    submitted_at: s.submitted_at,
    expires_at: null,
  };
}

const loadSession = (ctx, sessionId) => byId(ctx, ctx.db.sessions, sessionId, 'session');

export function getSession(ctx, sessionId) {
  const s = loadSession(ctx, sessionId);
  authorize(ctx, s.student_id, 'session.read');
  const inst = instrumentOf(s);
  const res = sessionResponses(ctx.db, s.id);
  return {
    ...sessionSummary(ctx.db, s),
    instrument: publicInstrument(inst),
    scales: Object.fromEntries([...new Set(inst.items.map((i) => i.scale))].map((k) => [k, SCALES[k]])),
    items: inst.items.map(publicItem),
    responses: Object.fromEntries(Object.values(res).map((r) => [r.item_id, { value: r.normalized_response, revision_seq: r.revision_seq }])),
    can_edit: s.status === 'in_progress' && usability(ctx, inst).usable,
  };
}

export function putResponse(ctx, sessionId, itemId, body, ifMatch) {
  const { db } = ctx;
  const s = loadSession(ctx, sessionId);
  authorize(ctx, s.student_id, 'session.write');
  if (s.status === 'submitted') throw conflict('session_sealed', 'This attempt has been submitted and sealed. Start a new attempt to change answers.');
  if (s.status !== 'in_progress') throw conflict('session_not_active', `Session is ${s.status}.`);
  const inst = instrumentOf(s);
  const use = usability(ctx, inst);
  if (!use.usable) throw conflict('instrument_unavailable', 'This instrument is no longer available.', { reason: use.reason, public: { reason: use.reason } });
  const item = inst.items.find((i) => i.item_id === itemId);
  if (!item) throw notFound('item');
  let value;
  try {
    value = validateResponse(item, body?.value);
  } catch (e) {
    if (e instanceof ValidationError) throw unprocessable(e.code, e.message);
    throw e;
  }
  const key = `${s.id}:${itemId}`;
  const existing = db.responses[key];
  const current = existing ? existing.revision_seq : 0;
  if (ifMatch !== undefined && ifMatch !== null && String(ifMatch).replaceAll('"', '') !== String(current)) {
    throw new AppError(412, 'precondition_failed', 'Precondition failed', 'The answer changed elsewhere. Reload and try again.', { public: { current_revision: current } });
  }
  const rec = { id: existing?.id ?? randomUUID(), session_id: s.id, item_id: itemId, normalized_response: value, captured_at: ctx.now.toISOString(), revision_seq: current + 1, sealed_at: null };
  db.responses[key] = rec;
  s.last_activity_at = ctx.now.toISOString();
  return { item_id: itemId, value, revision_seq: rec.revision_seq, progress: { answered: Object.keys(sessionResponses(db, s.id)).length, total: inst.items_total } };
}

export function submitSession(ctx, sessionId, body) {
  const { db } = ctx;
  const s = loadSession(ctx, sessionId);
  authorize(ctx, s.student_id, 'session.write');
  const inst = instrumentOf(s);

  if (s.status === 'submitted') {
    // AC-14: a duplicate / concurrent submit resolves to the single sealed attempt and its one score_run.
    const run = Object.values(db.score_runs).find((r) => r.session_id === s.id && r.status === 'final');
    return { session: sessionSummary(db, s), score_run_id: run?.id ?? null, already_submitted: true };
  }
  if (s.status !== 'in_progress') throw conflict('session_not_active', `Session is ${s.status}.`);
  if (!usability(ctx, inst).usable) throw conflict('instrument_unavailable', 'This instrument is no longer available.');

  const recs = sessionResponses(db, s.id);
  const answers = Object.fromEntries(Object.values(recs).map((r) => [r.item_id, r.normalized_response]));
  const comp = completeness(inst, answers);
  if (comp.missing.length && body?.acknowledge_incomplete !== true) {
    throw unprocessable('incomplete', 'Some questions are unanswered.', { public: { unanswered: comp.missing.length, total: comp.total, hint: 'Resend with acknowledge_incomplete=true to submit anyway; unscored areas will show "insufficient data".' } });
  }

  const sealedAt = ctx.now.toISOString();
  for (const r of Object.values(recs)) r.sealed_at = sealedAt;
  s.status = 'submitted';
  s.submitted_at = sealedAt;
  const payload = computeScore(inst, answers);
  const run = {
    id: randomUUID(),
    seq: nextSeq(db.score_runs),
    tenant_id: s.tenant_id,
    student_id: s.student_id,
    session_id: s.id,
    status: 'final',
    supersedes_id: null,
    reason: 'initial',
    executed_at: sealedAt,
    ...payload,
  };
  db.score_runs[run.id] = run;
  audit(ctx, { action: 'session.submitted', tenant_id: s.tenant_id, subject_ref: `session:${s.id}`, after: { answered: comp.answered, total: comp.total, input_hash: payload.input_hash } });
  audit(ctx, { action: 'score.computed', tenant_id: s.tenant_id, subject_ref: `score_run:${run.id}`, after: { execution_hash: payload.execution_hash }, meta: { algorithm_version: payload.algorithm_version } });
  emit(ctx, 'discovery.session.submitted', s.id, { student_id: s.student_id, instrument_id: s.instrument_id }, s.tenant_id);
  emit(ctx, 'discovery.score.ready', run.id, { student_id: s.student_id, instrument_id: s.instrument_id }, s.tenant_id);
  emit(ctx, 'discovery.profile.updated', s.student_id, { student_id: s.student_id }, s.tenant_id);
  return { session: sessionSummary(db, s), score_run_id: run.id, already_submitted: false };
}

export function scoreView(ctx, run) {
  const inst = getInstrumentByVersionId(run.instrument_version_id);
  const overrides = Object.values(ctx.db.overrides).filter((o) => o.score_run_id === run.id && (ctx.actor.role === 'counselor' || o.visibility === 'student'));
  return {
    score_run_id: run.id,
    session_id: run.session_id,
    instrument: publicInstrument(inst),
    algorithm_version: run.algorithm_version,
    input_hash: run.input_hash,
    execution_hash: run.execution_hash,
    executed_at: run.executed_at,
    status: run.status,
    supersedes_id: run.supersedes_id,
    construct_scores: run.construct_scores,
    missingness: run.missingness,
    ranking: run.ranking,
    norm_reference: run.norm_reference, // always null: no norms or percentiles exist
    interpretation_warning: inst.governance.interpretation_warning,
    overrides: overrides.map((o) => ({ id: o.id, text: o.text, reason: ctx.actor.role === 'counselor' ? o.reason : undefined, visibility: o.visibility, counselor_id: ctx.actor.role === 'counselor' ? o.counselor_id : undefined, created_at: o.created_at })),
  };
}

export function getScore(ctx, sessionId) {
  const s = loadSession(ctx, sessionId);
  authorize(ctx, s.student_id, 'score.read');
  if (s.status !== 'submitted') throw conflict('not_scored', 'This attempt has not been submitted yet.');
  const run = Object.values(ctx.db.score_runs).find((r) => r.session_id === s.id && r.status === 'final');
  if (!run) throw notFound('score_run');
  if (!storedPayloadIntact(run)) throw conflict('integrity_failure', 'The stored result no longer matches its recorded hash.');
  if (ctx.actor.role === 'counselor') audit(ctx, { action: 'access.score_read', tenant_id: s.tenant_id, subject_ref: `score_run:${run.id}`, meta: { purpose: 'counselor_review' } });
  return scoreView(ctx, run);
}

/** Raw answers are a distinct visibility class: the student and a consented, assigned counselor only. */
export function getRawResponses(ctx, sessionId) {
  const s = loadSession(ctx, sessionId);
  authorize(ctx, s.student_id, 'responses.read_raw'); // guardian role is absent from this rule => AC-12 denial
  const inst = instrumentOf(s);
  const res = sessionResponses(ctx.db, s.id);
  if (ctx.actor.role === 'counselor') audit(ctx, { action: 'access.raw_responses_read', tenant_id: s.tenant_id, subject_ref: `session:${s.id}`, meta: { purpose: 'counselor_review' } });
  return {
    session_id: s.id,
    sealed: s.status === 'submitted',
    answers: inst.items.map((i) => ({ item_id: i.item_id, construct: i.construct, content: i.content, value: res[i.item_id]?.normalized_response ?? null, sealed_at: res[i.item_id]?.sealed_at ?? null })),
  };
}

export function replaySession(ctx, sessionId) {
  const s = loadSession(ctx, sessionId);
  authorize(ctx, s.student_id, 'score.replay');
  if (s.status !== 'submitted') throw conflict('not_scored', 'This attempt has not been submitted yet.');
  const run = Object.values(ctx.db.score_runs).find((r) => r.session_id === s.id && r.status === 'final');
  const inst = instrumentOf(s);
  const answers = Object.fromEntries(Object.values(sessionResponses(ctx.db, s.id)).map((r) => [r.item_id, r.normalized_response]));
  const result = replayScore(inst, answers, run);
  // The stored result itself must still hash to its recorded execution_hash, not only the answers.
  const intact = storedPayloadIntact(run);
  audit(ctx, { action: 'score.replayed', tenant_id: s.tenant_id, subject_ref: `score_run:${run.id}`, after: { match: result.match && intact } });
  return { score_run_id: run.id, algorithm_version: run.algorithm_version, ...result, match: result.match && intact, stored_payload_intact: intact };
}

