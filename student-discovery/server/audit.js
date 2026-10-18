// Append-only, hash-chained audit log and transactional outbox (spec §7, §8.3, NFR-08).
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { hashOf, canonicalize } from '../domain/util.js';

const GENESIS = '0'.repeat(64);

/**
 * Record a consequential action. `before`/`after` are hashed, never stored (no PII in the log).
 * Must be called inside the same store.tx as the change it describes.
 */
/**
 * Before/after values are recorded as a KEYED hash. A plain SHA-256 of a small-domain value (a grade
 * from 0 to 100, a pathway name) can be brute-forced back into the value by anyone who can read the
 * log; the HMAC key never leaves the database document.
 */
function sealed(db, value) {
  db.meta.audit_key ??= randomBytes(32).toString('hex');
  return createHmac('sha256', db.meta.audit_key).update(canonicalize(value)).digest('hex');
}

/** Free text never enters the immutable chain unbounded. */
function clipMeta(meta) {
  return Object.fromEntries(Object.entries(meta ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v]));
}

export function audit(ctx, { action, tenant_id, subject_ref, before = null, after = null, policy_decision = 'allow', meta = {} }) {
  const { db } = ctx;
  const prev = db.audit.at(-1);
  const body = {
    id: randomUUID(),
    seq: db.audit.length + 1,
    tenant_id: tenant_id ?? ctx.actor?.tenant_id ?? null,
    actor: ctx.actor ? { id: ctx.actor.id, role: ctx.actor.role } : { id: null, role: 'anonymous' },
    subject_ref: subject_ref ?? null,
    action,
    before_hash: before === null ? null : sealed(db, before),
    after_hash: after === null ? null : sealed(db, after),
    policy_decision,
    meta: clipMeta(meta),
    correlation_id: ctx.requestId ?? null,
    timestamp: ctx.now.toISOString(),
    prev_hash: prev ? prev.hash : GENESIS,
  };
  db.audit.push({ ...body, hash: hashOf(body) });
}

export function verifyAuditChain(db) {
  let prev = GENESIS;
  for (let i = 0; i < db.audit.length; i++) {
    const { hash, ...body } = db.audit[i];
    if (body.prev_hash !== prev || body.seq !== i + 1 || hashOf(body) !== hash) return { ok: false, broken_at_seq: i + 1, length: db.audit.length };
    prev = hash;
  }
  return { ok: true, length: db.audit.length };
}

/** Queue a domain event with minimised payload (ids and states only). */
export function emit(ctx, event_type, aggregate_id, payload = {}, tenant_id = null) {
  const { db } = ctx;
  const idempotency_key = hashOf([event_type, aggregate_id, payload]).slice(0, 32) + `:${db.outbox.length + 1}`;
  db.outbox.push({
    id: randomUUID(),
    event_type,
    schema_version: 1,
    aggregate_id,
    tenant_id: tenant_id ?? ctx.actor?.tenant_id ?? null,
    actor: ctx.actor ? { id: ctx.actor.id, role: ctx.actor.role } : null,
    correlation_id: ctx.requestId ?? null,
    payload,
    idempotency_key,
    created_at: ctx.now.toISOString(),
    published_at: null,
    retry_count: 0,
    last_error: null,
  });
}

/**
 * Deliver unpublished events to in-process subscribers. A failing subscriber leaves the event
 * queued with retry_count+1 (at-least-once); consumers must be idempotent. They never mutate
 * sealed scores: subscribers only receive the minimised event.
 */
export function drainOutbox(db, subscribers, now) {
  let delivered = 0;
  for (const ev of db.outbox) {
    if (ev.published_at) continue;
    try {
      for (const sub of subscribers) sub(db, ev, now);
      ev.published_at = now.toISOString();
      ev.last_error = null;
      delivered++;
    } catch (e) {
      ev.retry_count += 1;
      ev.last_error = String(e.message).slice(0, 200);
    }
  }
  return delivered;
}

/** Journey Engine stand-in: records milestones; the real Journey Engine owns stage logic. */
export function journeySubscriber(db, ev, now) {
  const milestones = {
    'discovery.session.submitted': 'journey.module_completed',
    'discovery.score.ready': 'journey.profile_updated',
    'discovery.recommendation.generated': 'journey.majors_explored',
    'discovery.report.approved': 'journey.report_approved',
    'discovery.consent.withdrawn': 'journey.consent_withdrawn',
  };
  const key = milestones[ev.event_type];
  const studentId = ev.payload?.student_id;
  if (!key || !studentId) return;
  const list = (db.journey[studentId] ??= []);
  if (list.some((m) => m.event_id === ev.id)) return; // idempotent
  list.push({ event_id: ev.id, key, event_type: ev.event_type, at: now.toISOString() });
}
