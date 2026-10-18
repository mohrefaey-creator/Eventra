import { createApp } from '../../server/app.js';
import { getInstrument } from '../../domain/instruments/registry.js';

export const BASE = '/api/v1/discovery';
export const T0 = new Date('2026-10-17T12:00:00Z');

export async function startApp(opts = {}) {
  const time = { now: new Date(T0) };
  const app = createApp({ dataFile: null, clock: () => new Date(time.now), ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app,
    origin,
    time,
    advance: (ms) => (time.now = new Date(+time.now + ms)),
    close: () => new Promise((r) => app.server.close(r)),
    async as(personaId) {
      const res = await fetch(`${origin}/api/v1/identity-stub/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona_id: personaId }) });
      const cookie = res.headers.get('set-cookie').split(';')[0];
      const { csrf_token } = await res.json();
      return client(origin, cookie, csrf_token);
    },
    anon: () => client(origin, null, null),
  };
}

function client(origin, cookie, csrf) {
  async function call(method, path, body, extra = {}) {
    const headers = { ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body: json, headers: res.headers, text };
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b = {}, h) => call('PUT', p, b, h),
    patch: (p, b = {}, h) => call('PATCH', p, b, h),
    del: (p, h) => call('DELETE', p, undefined, h),
    raw: call,
  };
}

export const ivid = (id) => getInstrument(id).instrument_version_id;

export async function startSession(c, instrumentId, key = `k-${Math.random().toString(36).slice(2, 12)}`, locale = 'en') {
  return c.post(`${BASE}/sessions`, { instrument_version_id: ivid(instrumentId), locale, idempotency_key: key });
}

/** Answer every item of an instrument with fn(item, idx) and optionally submit. */
export async function answerAll(c, sessionId, instrumentId, fn, { submit = true, ack = false } = {}) {
  const inst = getInstrument(instrumentId);
  let idx = 0;
  for (const it of inst.items) {
    const v = fn(it, idx++);
    if (v === undefined) continue;
    const r = await c.put(`${BASE}/sessions/${sessionId}/responses/${it.item_id}`, { value: v });
    if (r.status !== 200) throw new Error(`answer failed ${it.item_id}: ${r.status} ${r.text}`);
  }
  return submit ? c.post(`${BASE}/sessions/${sessionId}/submit`, ack ? { acknowledge_incomplete: true } : {}) : null;
}

export const grantAll = async (student, guardian) => {
  const id = (await student.get('/api/v1/identity-stub/me')).body.persona.id;
  for (const scope of ['assessment_processing', 'counselor_sharing', 'guardian_summary_sharing', 'advisor_explanation', 'aggregate_analytics']) {
    const r = await student.post(`${BASE}/students/${id}/consent`, { scope, granted: true });
    if (r.status !== 200) throw new Error(`grant ${scope}: ${r.status} ${r.text}`);
  }
  if (guardian) await guardian.post(`${BASE}/students/${id}/consent`, { scope: 'assessment_processing', granted: true });
};
