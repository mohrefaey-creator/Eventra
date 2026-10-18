// Minimal HTTP plumbing (no framework): routing, auth/CSRF, rate limit, idempotency,
// RFC 7807 errors, security headers, static files.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { AppError, toProblem, unauthorized, forbidden } from './errors.js';
import { audit, drainOutbox, journeySubscriber } from './audit.js';
import { sweepExpiredRules } from './services/admin.js';
import { hashOf } from '../domain/util.js';
import { POLICY } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Everything is served from our own origin; no inline script or style is allowed.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export class Reply {
  constructor(status, body, headers = {}) {
    Object.assign(this, { status, body, headers });
  }
}
export const reply = (status, body, headers) => new Reply(status, body, headers);

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler, opts = {}) {
      const keys = [];
      const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
      routes.push({ method, pattern, re, keys, handler, opts: { tx: method !== 'GET', ...opts } });
    },
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        try {
          return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        } catch {
          return { route: r, params: null }; // malformed %-encoding: the caller answers 400
        }
      }
      return { route: null, pathMatched };
    },
  };
}

export function createSessions({ ttlMs = POLICY.session_ttl_ms, clock }) {
  const sessions = new Map();
  return {
    login(personaId) {
      if (sessions.size >= 2000) {
        for (const [k, v] of sessions) if (+clock() - v.created_at > ttlMs) sessions.delete(k);
        if (sessions.size >= 2000) sessions.delete(sessions.keys().next().value); // oldest first
      }
      const token = randomBytes(32).toString('hex');
      const s = { token, persona_id: personaId, csrf: randomBytes(16).toString('hex'), created_at: +clock(), bucket: { count: 0, resetAt: 0 } };
      sessions.set(token, s);
      return s;
    },
    fromRequest(req) {
      const cookie = req.headers.cookie ?? '';
      const m = /(?:^|;\s*)sd_session=([a-f0-9]{64})/.exec(cookie);
      if (!m) return null;
      const s = sessions.get(m[1]);
      if (!s) return null;
      if (+clock() - s.created_at > ttlMs) {
        sessions.delete(m[1]);
        return null;
      }
      return s;
    },
    destroy(token) {
      sessions.delete(token);
    },
  };
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, 'payload_too_large', 'Payload too large', `Body exceeds ${limit} bytes.`);
    chunks.push(c);
  }
  if (!size) return undefined;
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new AppError(415, 'unsupported_media_type', 'Unsupported media type', 'Send application/json.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'invalid_json', 'Invalid JSON', 'The request body is not valid JSON.');
  }
}

function send(res, status, body, extraHeaders = {}, contentType = 'application/json; charset=utf-8') {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(payload);
}

export function createHandler({ store, config, router, sessions, clock, webRoot }) {
  const staticCache = new Map();

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, toProblem(new AppError(405, 'method_not_allowed', 'Method not allowed'), null), {}, 'application/problem+json');
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bad request');
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(webRoot, rel));
    if (!file.startsWith(webRoot + path.sep) && file !== webRoot) {
      res.writeHead(404);
      return res.end();
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    if (!stat.isFile()) {
      res.writeHead(404);
      return res.end();
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    if (!staticCache.has(file) || staticCache.get(file).mtime !== stat.mtimeMs) staticCache.set(file, { mtime: stat.mtimeMs, buf: fs.readFileSync(file) });
    return res.end(staticCache.get(file).buf);
  }

  function maintenance(base) {
    const { db } = store;
    const pendingOutbox = db.outbox.some((e) => !e.published_at);
    const overdue = Object.values(db.rule_snapshots).some((r) => r.state === 'published' && !r.expiry_notified_at && new Date(r.review_due_at) <= base.now);
    if (!pendingOutbox && !overdue) return;
    store.tx((d) => {
      sweepExpiredRules({ ...base, db: d });
      drainOutbox(d, [journeySubscriber], base.now);
    });
  }

  // Fixed-window limits keyed by CLIENT (remote address) and by session. A fresh login does not reset the
  // client limit, and one noisy anonymous caller cannot lock everyone else out of signing in.
  const windows = new Map();
  function take(key, limit, now) {
    if (windows.size > 5000) for (const [k, w] of windows) if (+now >= w.resetAt) windows.delete(k);
    let w = windows.get(key);
    if (!w || +now >= w.resetAt) windows.set(key, (w = { count: 0, resetAt: +now + 60000 }));
    return ++w.count <= limit;
  }

  // Idempotent replays are only honoured while nothing that could change authorization has changed.
  const authEpoch = (db) => Object.keys(db.consent_records).length + db.guardian_links.length + db.counselor_assignments.length;
  const IDEM_TTL_MS = 10 * 60 * 1000;
  const IDEM_PER_ACTOR = 100;

  const incident = (db, route) => {
    if (db.meta.kill_switch.enabled && !route.opts.allowDuringIncident) {
      throw new AppError(503, 'module_suspended', 'Module suspended', 'Student Discovery is temporarily unavailable.');
    }
  };

  async function handleApi(req, res, url, requestId) {
    const now = clock();
    const { route, params, pathMatched } = router.match(req.method, url.pathname);
    const base = { requestId, now, config, store, db: store.db, actor: null };
    try {
      if (!route) {
        throw pathMatched ? new AppError(405, 'method_not_allowed', 'Method not allowed') : new AppError(404, 'not_found', 'Not found', 'No such endpoint.');
      }
      if (params === null) throw new AppError(400, 'bad_request', 'Bad request', 'Malformed URL encoding.');
      const resolve = () => {
        const sess = sessions.fromRequest(req);
        return { sess, who: sess ? (store.db.users[sess.persona_id] ?? null) : null };
      };
      let { sess: session, who: actor } = resolve();
      base.actor = actor;
      if (!route.opts.public && !actor) throw unauthorized();

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && !route.opts.noCsrf) {
        if (!session || req.headers['x-csrf-token'] !== session.csrf) throw forbidden('csrf', 'Missing or invalid CSRF token.');
      }
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!take(`ip:${ip}`, config.rateLimitPerMinute * 3, now) || (session && !take(`sess:${session.token}`, config.rateLimitPerMinute, now)) || (route.opts.noCsrf && route.opts.public && !take(`login:${ip}`, config.loginLimitPerMinute, now))) {
        throw new AppError(429, 'rate_limited', 'Too many requests', 'Slow down and retry shortly.');
      }

      incident(store.db, route); // refuse early...
      const body = mutating ? await readJson(req, POLICY.body_limit_bytes) : undefined;
      // ...and again: a body can arrive minutes later, after the module was suspended or the user signed out.
      ({ sess: session, who: actor } = resolve());
      base.actor = actor;
      if (!route.opts.public && !actor) throw unauthorized();
      incident(store.db, route);

      const query = Object.fromEntries(url.searchParams);
      const idemHeader = req.headers['idempotency-key'];

      const run = (db) => {
        const ctx = { ...base, db, params, query, body, headers: req.headers, session };
        if (mutating && idemHeader && route.opts.tx) {
          const k = `${actor?.id ?? 'anon'}:${idemHeader}`;
          const fp = hashOf([req.method, url.pathname, body ?? null]);
          const epoch = authEpoch(db);
          const prior = db.idempotency[k];
          if (prior && prior.epoch === epoch && +now - +new Date(prior.at) < IDEM_TTL_MS) {
            if (prior.fingerprint !== fp) throw new AppError(422, 'idempotency_key_reuse', 'Idempotency key reused', 'This key was used with a different request.');
            return new Reply(prior.status, JSON.parse(prior.body_json), { 'Idempotent-Replayed': 'true' });
          }
          if (prior) delete db.idempotency[k]; // stale (consent or relationships changed, or expired): run the handler again, with authorization
          const out = route.handler(ctx);
          const r = out instanceof Reply ? out : new Reply(200, out);
          const bodyJson = JSON.stringify(r.body ?? null);
          if (bodyJson.length <= POLICY.body_limit_bytes) {
            // snapshot, not a live reference; prune expired entries and cap what one actor can store
            const mine = Object.entries(db.idempotency).filter(([key, v]) => key.startsWith(`${actor?.id ?? 'anon'}:`) || +now - +new Date(v.at) >= IDEM_TTL_MS);
            for (const [key, v] of mine) if (+now - +new Date(v.at) >= IDEM_TTL_MS) delete db.idempotency[key];
            const live = Object.entries(db.idempotency).filter(([key]) => key.startsWith(`${actor?.id ?? 'anon'}:`));
            if (live.length >= IDEM_PER_ACTOR) delete db.idempotency[live.sort((a, b) => a[1].at.localeCompare(b[1].at))[0][0]];
            db.idempotency[k] = { fingerprint: fp, status: r.status, body_json: bodyJson, at: now.toISOString(), epoch: authEpoch(db) };
          }
          return r;
        }
        return route.handler(ctx);
      };
      const out = route.opts.tx ? store.tx(run) : run(store.db);
      const r = out instanceof Reply ? out : new Reply(200, out);
      maintenance({ ...base, db: store.db });
      return send(res, r.status, r.body, r.headers);
    } catch (e) {
      const err = e instanceof AppError ? e : null;
      if (!err) {
        console.error(`[${requestId}]`, e);
      }
      const ev = err?.extra?.securityEvent;
      if (ev) {
        try {
          store.tx((db) => audit({ ...base, db }, { ...ev, policy_decision: 'deny' }));
        } catch (auditErr) {
          console.error('audit of denial failed', auditErr);
        }
      }
      const problem = err ?? new AppError(500, 'internal_error', 'Internal error', 'Something went wrong. Quote the request id when reporting it.');
      return send(res, problem.status, toProblem(problem, requestId), {}, 'application/problem+json');
    }
  }

  return async function handler(req, res) {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    securityHeaders(res);
    // The persona stand-in has no real authentication, so only loopback hosts are served. A hostile web page
    // that rebinds its DNS name to 127.0.0.1 would otherwise be able to drive the app from a victim's browser.
    if (!config.allowAnyHost) {
      const host = String(req.headers.host ?? '').toLowerCase();
      const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
        return send(res, 403, toProblem(new AppError(403, 'access_denied', 'Access denied', 'This prototype only answers on localhost.'), requestId), {}, 'application/problem+json');
      }
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, toProblem(new AppError(400, 'bad_url', 'Bad request'), requestId), {}, 'application/problem+json');
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url, requestId);
    return serveStatic(req, res, url.pathname);
  };
}
