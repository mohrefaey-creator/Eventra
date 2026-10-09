import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { createHmac } from 'node:crypto';
import { normalizeFingerprint, startServer, turnCredentials } from '../server/index.js';
import { createSignaling } from '../server/signaling.js';

// ---------------------------------------------------------------- unit: logic

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  say(type, extra = {}) {
    this.emit('message', Buffer.from(JSON.stringify({ type, ...extra })), false);
  }
  last(type) {
    return this.sent.findLast((m) => m.type === type);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function setup(opts) {
  const sig = createSignaling(opts);
  const connect = (ip = '10.0.0.1') => {
    const ws = new FakeSocket();
    sig.handleConnection(ws, ip);
    return ws;
  };
  return { sig, connect };
}

function pair(connect) {
  const host = connect();
  host.say('host');
  const code = host.last('hosted').code;
  const peer = connect();
  peer.say('join', { code, name: 'Phone' });
  return { host, peer, code };
}

describe('pairing', () => {
  it('issues a 6-digit code to a host', () => {
    const { sig, connect } = setup();
    const host = connect();
    host.say('host');
    assert.match(host.last('hosted').code, /^\d{6}$/);
    sig.close();
  });

  it('asks the host to approve, then lets both sides exchange signals', () => {
    const { sig, connect } = setup();
    const { host, peer } = pair(connect);

    assert.equal(peer.last('waiting').type, 'waiting');
    const req = host.last('join-request');
    assert.equal(req.name, 'Phone');

    host.say('accept', { peerId: req.peerId });
    assert.ok(peer.last('accepted'));

    peer.say('signal', { data: { description: { type: 'offer', sdp: 'x' } } });
    assert.deepEqual(host.last('signal').data.description, { type: 'offer', sdp: 'x' });
    assert.equal(host.last('signal').peerId, req.peerId);

    host.say('signal', { data: { description: { type: 'answer', sdp: 'y' } } });
    assert.deepEqual(peer.last('signal').data.description, { type: 'answer', sdp: 'y' });
    sig.close();
  });

  it('accepts codes typed with spaces or dashes', () => {
    const { sig, connect } = setup();
    const host = connect();
    host.say('host');
    const code = host.last('hosted').code;
    const peer = connect();
    peer.say('join', { code: `${code.slice(0, 3)} - ${code.slice(3)}`, name: 'x' });
    assert.ok(host.last('join-request'));
    sig.close();
  });

  it('refuses signals until the host has accepted', () => {
    const { sig, connect } = setup();
    const { host, peer } = pair(connect);
    peer.say('signal', { data: { candidate: {} } });
    assert.equal(peer.last('error').code, 'not-paired');
    host.say('signal', { data: { candidate: {} } });
    assert.equal(host.last('error').code, 'not-paired');
    assert.equal(host.last('signal'), undefined);
    sig.close();
  });

  it('rejects unknown codes', () => {
    const { sig, connect } = setup();
    const peer = connect();
    peer.say('join', { code: '000000', name: 'x' });
    assert.equal(peer.last('error').code, 'bad-code');
    sig.close();
  });

  it('throttles an IP that keeps guessing, even for a correct code afterwards', () => {
    const { sig, connect } = setup({ maxJoinFailures: 3 });
    const host = connect('10.0.0.9');
    host.say('host');
    const code = host.last('hosted').code;
    const wrong = code === '111111' ? '222222' : '111111';
    const guesser = connect('10.0.0.5');
    for (let i = 0; i < 3; i++) guesser.say('join', { code: wrong, name: 'x' });
    guesser.say('join', { code, name: 'x' });
    assert.equal(guesser.last('error').code, 'rate-limited');
    assert.equal(host.last('join-request'), undefined);
    // a different IP is unaffected
    connect('10.0.0.6').say('join', { code, name: 'x' });
    assert.ok(host.last('join-request'));
    sig.close();
  });

  it('allows one sender at a time', () => {
    const { sig, connect } = setup();
    const { code } = pair(connect);
    const second = connect();
    second.say('join', { code, name: 'Tablet' });
    assert.equal(second.last('error').code, 'busy');
    sig.close();
  });

  it('lets a declined sender try again', () => {
    const { sig, connect } = setup();
    const { host, peer, code } = pair(connect);
    host.say('reject', { peerId: host.last('join-request').peerId });
    assert.equal(peer.last('rejected').reason, 'denied');
    peer.say('join', { code, name: 'Phone' });
    assert.equal(host.sent.filter((m) => m.type === 'join-request').length, 2);
    sig.close();
  });

  it('tells the host when a sender leaves and frees the slot', () => {
    const { sig, connect } = setup();
    const { host, peer, code } = pair(connect);
    host.say('accept', { peerId: host.last('join-request').peerId });
    peer.close();
    assert.ok(host.last('peer-left'));
    const next = connect();
    next.say('join', { code, name: 'Next' });
    assert.ok(next.last('waiting'));
    sig.close();
  });

  it('tells the sender when the host disappears, and retires the code', () => {
    const { sig, connect } = setup();
    const { host, peer, code } = pair(connect);
    host.say('accept', { peerId: host.last('join-request').peerId });
    host.close();
    assert.ok(peer.last('host-left'));
    const late = connect();
    late.say('join', { code, name: 'x' });
    assert.equal(late.last('error').code, 'bad-code');
    assert.equal(sig.stats().rooms, 0);
    sig.close();
  });

  it('lets the host end an active session', () => {
    const { sig, connect } = setup();
    const { host, peer } = pair(connect);
    host.say('accept', { peerId: host.last('join-request').peerId });
    host.say('end');
    assert.ok(peer.last('ended'));
    peer.say('signal', { data: {} });
    assert.equal(peer.last('error').code, 'not-registered');
    sig.close();
  });

  it('issues a fresh code on refresh and invalidates the old one', () => {
    const { sig, connect } = setup();
    const host = connect();
    host.say('host');
    const old = host.last('hosted').code;
    host.say('refresh');
    const fresh = host.last('hosted').code;
    assert.notEqual(fresh, old);
    const peer = connect();
    peer.say('join', { code: old, name: 'x' });
    assert.equal(peer.last('error').code, 'bad-code');
    assert.equal(sig.stats().rooms, 1);
    sig.close();
  });

  it('refuses to refresh while a sender is connected', () => {
    const { sig, connect } = setup();
    const { host } = pair(connect);
    host.say('refresh');
    assert.equal(host.last('error').code, 'busy');
    sig.close();
  });

  it('expires unused codes', async () => {
    const { sig, connect } = setup({ codeTtlMs: 30 });
    const host = connect();
    host.say('host');
    const code = host.last('hosted').code;
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(host.last('code-expired'));
    const peer = connect();
    peer.say('join', { code, name: 'x' });
    assert.equal(peer.last('error').code, 'bad-code');
    sig.close();
  });

  it('times out join requests nobody answers', async () => {
    const { sig, connect } = setup({ pendingTtlMs: 30 });
    const { host, peer } = pair(connect);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(peer.last('rejected').reason, 'timeout');
    assert.ok(host.last('peer-left'));
    sig.close();
  });

  it('caps open codes per IP', () => {
    const { sig, connect } = setup({ maxRoomsPerIp: 2 });
    for (let i = 0; i < 2; i++) connect().say('host');
    const extra = connect();
    extra.say('host');
    assert.equal(extra.last('error').code, 'too-many-rooms');
    sig.close();
  });

  it('cleans device names', () => {
    const { sig, connect } = setup();
    const host = connect();
    host.say('host');
    const peer = connect();
    peer.say('join', { code: host.last('hosted').code, name: `  Eve\u0007${'x'.repeat(100)}  ` });
    const name = host.last('join-request').name;
    assert.ok(name.startsWith('Eve'));
    assert.ok(name.length <= 40);
    assert.ok(!/[\u0000-\u001f]/.test(name));
    sig.close();
  });

  it('survives garbage', () => {
    const { sig, connect } = setup();
    const ws = connect();
    ws.emit('message', Buffer.from('{not json'), false);
    assert.equal(ws.last('error').code, 'bad-message');
    ws.emit('message', Buffer.from('[]'), false);
    ws.emit('message', Buffer.from('{"type":5}'), false);
    ws.emit('message', Buffer.from([1, 2, 3]), true);
    ws.say('accept', { peerId: 'nope' });
    assert.equal(ws.last('error').code, 'not-registered');
    sig.close();
  });
});

// ----------------------------------------------------- integration: real server

describe('server', async () => {
  const server = await startServer({ port: 0, tls: false, quiet: true, host: '127.0.0.1' });
  after(() => server.close());
  const base = `http://127.0.0.1:${server.httpPort}`;

  const rawGet = (path) =>
    new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: server.httpPort, path }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
        .on('error', reject)
        .end();
    });

  it('serves the pages with a strict CSP', async () => {
    for (const path of ['/', '/receive', '/tv', '/send', '/check']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
      assert.match(await res.text(), /<!doctype html>/i);
    }
  });

  it('blocks path traversal and handles bad URLs', async () => {
    // The URL parser collapses %2e%2e into the public root, so this can only 404...
    assert.equal(await rawGet('/%2e%2e/package.json'), 404);
    // ...while an encoded slash survives parsing and must hit the directory guard.
    assert.equal(await rawGet('/..%2f..%2fpackage.json'), 403);
    assert.equal(await rawGet('/..%2fserver%2findex.js'), 403);
    assert.equal(await rawGet('/%E0%A4%A'), 400);
    assert.equal(await rawGet('/nope.js'), 404);
  });

  it('exposes ICE servers and sender origins', async () => {
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.ok(Array.isArray(info.iceServers) && info.iceServers.length > 0);
    assert.ok(Array.isArray(info.senderOrigins));
    assert.equal(typeof info.secureSenderAvailable, 'boolean');
  });

  it('renders QR codes as SVG', async () => {
    const res = await fetch(`${base}/api/qr.svg?text=${encodeURIComponent('https://example.test/send?code=123456')}`);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.match(await res.text(), /<svg/);
    assert.equal((await fetch(`${base}/api/qr.svg`)).status, 400);
  });

  it('rejects WebSocket handshakes from other origins', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpPort}/ws`, { origin: 'http://evil.example' });
    ws.on('error', () => {}); // aborting the handshake reports an error; that is the point
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 403);
    ws.terminate();
  });

  it('pairs two real WebSocket clients end to end', async () => {
    const open = async (origin) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.httpPort}/ws`, origin ? { origin } : undefined);
      ws.inbox = [];
      ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
      await once(ws, 'open');
      return ws;
    };
    const next = async (ws, type) => {
      for (let i = 0; i < 100; i++) {
        const found = ws.inbox.find((m) => m.type === type);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${type}`);
    };

    const host = await open(`http://127.0.0.1:${server.httpPort}`); // same-origin, like a browser
    host.send(JSON.stringify({ type: 'host' }));
    const { code } = await next(host, 'hosted');

    const peer = await open(); // native client: no Origin header
    peer.send(JSON.stringify({ type: 'join', code, name: 'Native sender' }));
    const req = await next(host, 'join-request');
    assert.equal(req.name, 'Native sender');
    host.send(JSON.stringify({ type: 'accept', peerId: req.peerId }));
    await next(peer, 'accepted');

    host.close();
    peer.close();
  });
});

// ------------------------------------------------------- native app support

describe('debug log for new sender apps', async () => {
  const off = await startServer({ port: 0, tls: false, quiet: true, host: '127.0.0.1' });
  const on = await startServer({ port: 0, tls: false, quiet: true, host: '127.0.0.1', diag: true });
  after(async () => {
    await off.close();
    await on.close();
  });

  it('does not exist unless it is switched on', async () => {
    const res = await fetch(`http://127.0.0.1:${off.httpPort}/api/diag`, { method: 'POST', body: 'hello' });
    assert.equal(res.status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${off.httpPort}/api/diag`)).status, 404);
  });

  it('keeps what an app posts and shows it back, bounded', async () => {
    const url = `http://127.0.0.1:${on.httpPort}/api/diag`;
    assert.equal((await fetch(url, { method: 'POST', body: '[ext] started\nsecond line' })).status, 204);
    assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(5000) })).status, 204);
    const text = await (await fetch(url)).text();
    assert.match(text, /\[ext\] started second line/);
    assert.ok(text.split('\n').every((line) => line.length < 1100), 'lines are cut to a sane length');
    for (let i = 0; i < 320; i++) await fetch(url, { method: 'POST', body: `line ${i}` });
    const lines = (await (await fetch(url)).text()).trim().split('\n');
    assert.equal(lines.length, 300);
    assert.match(lines.at(-1), /line 319$/);
  });
});

describe('native app support', async () => {
  const fp = 'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90';

  it('normalizes SHA-256 fingerprints and rejects anything else', () => {
    assert.equal(normalizeFingerprint(fp), fp);
    assert.equal(normalizeFingerprint(fp.toLowerCase()), fp);
    assert.equal(normalizeFingerprint(fp.replaceAll(':', '')), fp);
    assert.equal(normalizeFingerprint('AB:CD'), null);
    assert.equal(normalizeFingerprint(''), null);
    assert.equal(normalizeFingerprint(undefined), null);
  });

  it('serves nothing at assetlinks.json until a certificate is configured', async () => {
    const server = await startServer({ port: 0, tls: false, quiet: true, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${server.httpPort}/.well-known/assetlinks.json`);
      assert.equal(res.status, 404);
      const info = await (await fetch(`http://127.0.0.1:${server.httpPort}/api/info`)).json();
      assert.deepEqual(info.appLinks, { android: '', ios: '' });
    } finally {
      await server.close();
    }
  });

  it('publishes Android App Links and download links when configured', async () => {
    const server = await startServer({
      port: 0,
      tls: false,
      quiet: true,
      host: '127.0.0.1',
      androidPackage: 'com.example.mirror',
      androidCertSha256: [fp.toLowerCase(), 'not-a-fingerprint'],
      appLinks: { android: 'https://example.test/app.apk', ios: 'https://apps.apple.com/app/id1' },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.httpPort}/.well-known/assetlinks.json`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await res.json(), [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: 'com.example.mirror', sha256_cert_fingerprints: [fp] },
        },
      ]);
      const info = await (await fetch(`http://127.0.0.1:${server.httpPort}/api/info`)).json();
      assert.deepEqual(info.appLinks, { android: 'https://example.test/app.apk', ios: 'https://apps.apple.com/app/id1' });
    } finally {
      await server.close();
    }
  });
});

// ------------------------------------------------------------ hosting support

describe('hosting support', async () => {
  it('derives TURN credentials the way coturn verifies them', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    const { username, credential } = turnCredentials('s3cret', 3600, now);
    const [expiry, label] = username.split(':');
    assert.equal(Number(expiry), Math.floor(now / 1000) + 3600);
    assert.match(label, /^[0-9a-f]{8}$/);
    assert.equal(credential, createHmac('sha1', 's3cret').update(username).digest('base64'));
    assert.notEqual(turnCredentials('s3cret', 3600, now).username, username, 'each call gets its own username');
  });

  it('adds fresh TURN credentials to /api/info only when configured', async () => {
    const plain = await startServer({ port: 0, tls: false, quiet: true, host: '127.0.0.1' });
    const relay = await startServer({
      port: 0,
      tls: false,
      quiet: true,
      host: '127.0.0.1',
      turn: { urls: ['turn:turn.example.test:3478', 'turns:turn.example.test:5349'], secret: 'k', ttlSeconds: 600 },
    });
    try {
      const before = await (await fetch(`http://127.0.0.1:${plain.httpPort}/api/info`)).json();
      assert.ok(before.iceServers.every((s) => !s.credential), 'no TURN entry unless configured');

      const a = await (await fetch(`http://127.0.0.1:${relay.httpPort}/api/info`)).json();
      const b = await (await fetch(`http://127.0.0.1:${relay.httpPort}/api/info`)).json();
      const turnA = a.iceServers.find((s) => s.credential);
      const turnB = b.iceServers.find((s) => s.credential);
      assert.deepEqual(turnA.urls, ['turn:turn.example.test:3478', 'turns:turn.example.test:5349']);
      assert.equal(turnA.credential, createHmac('sha1', 'k').update(turnA.username).digest('base64'));
      assert.ok(Number(turnA.username.split(':')[0]) <= Math.floor(Date.now() / 1000) + 600);
      assert.notEqual(turnA.username, turnB.username);
      assert.ok(a.iceServers.length > 1, 'public STUN is still offered next to the relay');
    } finally {
      await plain.close();
      await relay.close();
    }
  });

  it('answers health checks', async () => {
    const server = await startServer({ port: 0, tls: false, quiet: true, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${server.httpPort}/healthz`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    } finally {
      await server.close();
    }
  });
});
