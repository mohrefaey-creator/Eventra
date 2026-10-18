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
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { route: r, params };
      }
      return { route: null, pathMatched };
    },
  };
}

export function createSessions({ ttlMs = POLICY.session_ttl_ms, clock }) {
  const sessions = new Map();
  return {
    login(personaId) {
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
    let rel = decodeURIComponent(pathname);
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

  async function handleApi(req, res, url, requestId) {
    const now = clock();
    const { route, params, pathMatched } = router.match(req.method, url.pathname);
    const base = { requestId, now, config, store, db: store.db, actor: null };
    try {
      if (!route) {
        throw pathMatched ? new AppError(405, 'method_not_allowed', 'Method not allowed') : new AppError(404, 'not_found', 'Not found', 'No such endpoint.');
      }
      const session = sessions.fromRequest(req);
      const actor = session ? (store.db.users[session.persona_id] ?? null) : null;
      base.actor = actor;
      if (!route.opts.public && !actor) throw unauthorized();

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && !route.opts.noCsrf) {
        if (!session || req.headers['x-csrf-token'] !== session.csrf) throw forbidden('csrf', 'Missing or invalid CSRF token.');
      }
      // fixed-window rate limit per session (or per remote address when signed out)
      const bucket = session ? session.bucket : (sessions.anonBucket ??= { count: 0, resetAt: 0 });
      if (+now >= bucket.resetAt) Object.assign(bucket, { count: 0, resetAt: +now + 60000 });
      if (++bucket.count > config.rateLimitPerMinute) throw new AppError(429, 'rate_limited', 'Too many requests', 'Slow down and retry shortly.');

      if (store.db.meta.kill_switch.enabled && !route.opts.allowDuringIncident) {
        throw new AppError(503, 'module_suspended', 'Module suspended', 'Student Discovery is temporarily unavailable.', { public: { reason: store.db.meta.kill_switch.reason } });
      }

      const body = mutating ? await readJson(req, POLICY.body_limit_bytes) : undefined;
      const query = Object.fromEntries(url.searchParams);
      const idemHeader = req.headers['idempotency-key'];

      const run = (db) => {
        const ctx = { ...base, db, params, query, body, headers: req.headers, session };
        if (mutating && idemHeader && route.opts.tx) {
          const k = `${actor?.id ?? 'anon'}:${idemHeader}`;
          const fp = hashOf([req.method, url.pathname, body ?? null]);
          const prior = db.idempotency[k];
          if (prior) {
            if (prior.fingerprint !== fp) throw new AppError(422, 'idempotency_key_reuse', 'Idempotency key reused', 'This key was used with a different request.');
            return new Reply(prior.status, prior.body, { 'Idempotent-Replayed': 'true' });
          }
          const out = route.handler(ctx);
          const r = out instanceof Reply ? out : new Reply(200, out);
          db.idempotency[k] = { fingerprint: fp, status: r.status, body: r.body, at: now.toISOString() };
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
