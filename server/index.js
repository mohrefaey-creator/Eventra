// MirrorLink server: static files, a tiny JSON API, and the pairing/signaling WebSocket.
// Video never passes through here - it flows peer-to-peer between the two browsers.
import { createHmac, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { createSignaling } from './signaling.js';
import { loadOrCreateCert } from './tls.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const PAGES = { '/': 'index.html', '/receive': 'receive.html', '/send': 'send.html' };

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'display-capture=(self), camera=(), microphone=()',
};

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // Home/office networks first; VPN and container ranges last.
  return out.sort((a, b) => Number(PRIVATE_V4.test(b)) - Number(PRIVATE_V4.test(a)));
}

/** "ab:cd:…" or a bare 64-hex string -> "AB:CD:…", or null if it is not a SHA-256 fingerprint. */
export function normalizeFingerprint(raw) {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 64 ? hex.match(/../g).join(':') : null;
}

/**
 * Short-lived TURN credentials in the format coturn's `use-auth-secret` mode expects
 * (https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00): username = expiry:label,
 * credential = base64(HMAC-SHA1(secret, username)). Nothing is stored, and a leaked credential
 * stops working after `ttlSeconds`, unlike a fixed password published to every visitor.
 */
export function turnCredentials(secret, ttlSeconds = 3600, now = Date.now()) {
  const username = `${Math.floor(now / 1000) + ttlSeconds}:${randomBytes(4).toString('hex')}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

const isLoopbackHost = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '');

/**
 * Start the server. Options mirror the environment variables documented in the README.
 * Resolves to { httpPort, httpsPort, close() }.
 */
export async function startServer(options = {}) {
  const {
    host = '0.0.0.0',
    port = 3000,
    httpsPort = 3443,
    tls = true,
    publicUrl = '',
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }],
    trustProxy = false,
    // Native sender apps: where to get them, and which Android signing certificates may claim
    // https://<this server>/send links (Android App Links), so a scanned QR opens the app directly.
    // TURN relay for devices on different networks: { urls: [...], secret, ttlSeconds? }.
    // Credentials are minted per request from the shared secret, so none is ever stored or reused.
    turn = null,
    appLinks = {},
    androidPackage = 'app.mirrorlink',
    androidCertSha256 = [],
    signaling: signalingOptions,
    quiet = false,
  } = options;
  const certFingerprints = androidCertSha256.map(normalizeFingerprint).filter(Boolean);
  if (!quiet && certFingerprints.length !== androidCertSha256.length) {
    console.warn('ANDROID_CERT_SHA256: ignoring entries that are not SHA-256 fingerprints (64 hex digits).');
  }

  const lan = lanAddresses();
  const signaling = createSignaling(signalingOptions);
  let boundHttpsPort = null;

  function senderOrigins(req) {
    if (publicUrl) return [publicUrl.replace(/\/$/, '')];
    const reqHost = req.headers.host;
    const viaTls = Boolean(req.socket.encrypted);
    if (viaTls && !isLoopbackHost(reqHost)) return [`https://${reqHost}`];
    if (boundHttpsPort) return lan.map((ip) => `https://${ip}:${boundHttpsPort}`);
    return lan.map((ip) => `http://${ip}:${port}`);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
      return;
    }

    if (url.pathname === '/api/info') {
      const origins = senderOrigins(req);
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      const relay = turn?.secret && turn.urls?.length
        ? [{ urls: turn.urls, ...turnCredentials(turn.secret, turn.ttlSeconds) }]
        : [];
      res.end(
        JSON.stringify({
          iceServers: [...iceServers, ...relay],
          senderOrigins: origins,
          secureSenderAvailable: origins.some((o) => o.startsWith('https:')),
          appLinks: { android: appLinks.android || '', ios: appLinks.ios || '' },
        }),
      );
      return;
    }

    if (url.pathname === '/.well-known/assetlinks.json') {
      if (certFingerprints.length === 0) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not configured');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'public, max-age=300' });
      res.end(
        JSON.stringify([
          {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: certFingerprints },
          },
        ]),
      );
      return;
    }

    if (url.pathname === '/api/qr.svg') {
      const text = url.searchParams.get('text') ?? '';
      if (!text || text.length > 512) {
        res.writeHead(400).end();
        return;
      }
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'no-store' });
      res.end(svg);
      return;
    }

    let rel = PAGES[url.pathname];
    if (!rel) {
      try {
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      } catch {
        res.writeHead(400).end();
        return;
      }
    }
    const file = normalize(join(PUBLIC_DIR, rel));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  const onRequest = (req, res) =>
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const clientIp = (req) =>
    (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  // Browsers send Origin on WebSocket handshakes. Reject pages served from elsewhere so a
  // random website cannot drive this server from a visitor's browser. Native clients send none.
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      if (publicUrl && o.host === new URL(publicUrl).host) return true;
      return o.host === req.headers.host;
    } catch {
      return false;
    }
  }

  function onUpgrade(req, socket, head) {
    if (new URL(req.url, 'http://x').pathname !== '/ws' || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      signaling.handleConnection(ws, clientIp(req));
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const servers = [];
  const listen = (server, p) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, host, () => resolve(server.address().port));
    });

  const httpServer = createHttpServer(onRequest);
  httpServer.on('upgrade', onUpgrade);
  servers.push(httpServer);

  if (tls) {
    const { key, cert } = await loadOrCreateCert(lan);
    const httpsServer = createHttpsServer({ key, cert }, onRequest);
    httpsServer.on('upgrade', onUpgrade);
    boundHttpsPort = await listen(httpsServer, httpsPort);
    servers.push(httpsServer);
  }
  const boundHttpPort = await listen(httpServer, port);

  if (!quiet) {
    console.log('\nMirrorLink is running\n');
    console.log(`  Receiver (open on the screen that will display the mirror):`);
    console.log(`    http://localhost:${boundHttpPort}/receive`);
    if (boundHttpsPort) {
      console.log(`  Sender (open on the device being mirrored):`);
      for (const ip of lan) console.log(`    https://${ip}:${boundHttpsPort}/send`);
      console.log('    (self-signed certificate: accept the browser warning once per device)');
    } else {
      console.log('  TLS is off: senders must reach this server over HTTPS (reverse proxy / PUBLIC_URL).');
    }
    console.log('');
  }

  return {
    httpPort: boundHttpPort,
    httpsPort: boundHttpsPort,
    signaling,
    async close() {
      clearInterval(heartbeat);
      signaling.close();
      for (const ws of wss.clients) ws.terminate();
      await Promise.all(
        servers.map((s) => new Promise((resolve) => (s.closeAllConnections?.(), s.close(resolve)))),
      );
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  let iceServers;
  if (env.ICE_SERVERS) {
    try {
      iceServers = JSON.parse(env.ICE_SERVERS);
    } catch {
      console.error('ICE_SERVERS must be valid JSON, e.g. [{"urls":"stun:stun.example.com:3478"}]');
      process.exit(1);
    }
  }
  startServer({
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    httpsPort: Number(env.HTTPS_PORT ?? 3443),
    tls: env.TLS !== 'off',
    publicUrl: env.PUBLIC_URL || '',
    trustProxy: env.TRUST_PROXY === '1',
    turn: env.TURN_URLS && env.TURN_SECRET
      ? {
          urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
          secret: env.TURN_SECRET,
          ttlSeconds: Number(env.TURN_TTL) || 3600,
        }
      : null,
    appLinks: { android: env.ANDROID_APP_URL || '', ios: env.IOS_APP_URL || '' },
    androidPackage: env.ANDROID_PACKAGE || 'app.mirrorlink',
    androidCertSha256: (env.ANDROID_CERT_SHA256 || '').split(',').filter((v) => v.trim()),
    ...(iceServers && { iceServers }),
  }).catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port already in use: ${err.message}` : err);
    process.exit(1);
  });
}
