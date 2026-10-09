// Pairing + WebRTC signaling. Pure logic, no HTTP: index.js feeds it WebSockets.
// Wire protocol is documented in docs/PROTOCOL.md.
import { randomInt, randomUUID } from 'node:crypto';

export const DEFAULTS = {
  codeTtlMs: 10 * 60_000, // how long an unused pairing code stays valid
  pendingTtlMs: 60_000, // how long a join request may wait for the receiver to answer
  maxRoomsPerIp: 10,
  maxJoinFailures: 8, // wrong codes allowed per window, per IP
  failureWindowMs: 60_000,
};

const OPEN = 1;

export function createSignaling(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rooms = new Map(); // code -> room
  const roomsPerIp = new Map(); // ip -> count
  const failures = new Map(); // ip -> { count, resetAt }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of failures) if (f.resetAt <= now) failures.delete(ip);
  }, opts.failureWindowMs);
  sweeper.unref();

  const send = (ws, msg) => {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (ws, code, extra = {}) => send(ws, { type: 'error', code, ...extra });

  function newCode() {
    for (let i = 0; i < 20; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!rooms.has(code)) return code;
    }
    throw new Error('could not allocate a pairing code');
  }

  const cleanName = (name) =>
    String(name ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 40) || 'Unnamed device';

  const normalizeCode = (code) => String(code ?? '').replace(/\D/g, '');

  function armExpiry(room) {
    clearTimeout(room.expiryTimer);
    room.expiresAt = Date.now() + opts.codeTtlMs;
    room.expiryTimer = setTimeout(() => {
      if (room.peer) return; // a session is in progress; the code no longer matters
      send(room.host, { type: 'code-expired' });
      deleteRoom(room);
    }, opts.codeTtlMs);
    room.expiryTimer.unref();
  }

  function deleteRoom(room) {
    clearTimeout(room.expiryTimer);
    rooms.delete(room.code);
    const n = (roomsPerIp.get(room.ip) ?? 1) - 1;
    if (n <= 0) roomsPerIp.delete(room.ip);
    else roomsPerIp.set(room.ip, n);
    if (room.host.room === room) room.host.room = null;
  }

  function freePeer(room) {
    const peer = room.peer;
    if (!peer) return;
    clearTimeout(peer.pendingTimer);
    room.peer = null;
    if (peer.ws.peerState === peer) peer.ws.peerState = null;
    if (rooms.get(room.code) === room) armExpiry(room);
  }

  function registerFailure(ip) {
    const now = Date.now();
    let f = failures.get(ip);
    if (!f || f.resetAt <= now) f = { count: 0, resetAt: now + opts.failureWindowMs };
    f.count++;
    failures.set(ip, f);
  }

  function isThrottled(ip) {
    const f = failures.get(ip);
    return !!f && f.resetAt > Date.now() && f.count >= opts.maxJoinFailures;
  }

  function hostRoom(ws, ip) {
    if (ws.room || ws.peerState) return fail(ws, 'already-registered');
    if ((roomsPerIp.get(ip) ?? 0) >= opts.maxRoomsPerIp) return fail(ws, 'too-many-rooms');
    const room = { code: newCode(), host: ws, ip, peer: null, expiryTimer: null, expiresAt: 0 };
    rooms.set(room.code, room);
    roomsPerIp.set(ip, (roomsPerIp.get(ip) ?? 0) + 1);
    ws.room = room;
    armExpiry(room);
    send(ws, { type: 'hosted', code: room.code, ttlMs: opts.codeTtlMs, expiresAt: room.expiresAt });
  }

  function join(ws, ip, msg) {
    if (ws.room || ws.peerState) return fail(ws, 'already-registered');
    if (isThrottled(ip)) return fail(ws, 'rate-limited');
    const room = rooms.get(normalizeCode(msg.code));
    if (!room) {
      registerFailure(ip);
      return fail(ws, 'bad-code');
    }
    if (room.peer) return fail(ws, 'busy');

    const peer = { id: randomUUID(), ws, name: cleanName(msg.name), accepted: false, pendingTimer: null };
    room.peer = peer;
    ws.peerState = peer;
    peer.room = room;
    clearTimeout(room.expiryTimer);
    peer.pendingTimer = setTimeout(() => {
      if (room.peer !== peer || peer.accepted) return;
      send(ws, { type: 'rejected', reason: 'timeout' });
      send(room.host, { type: 'peer-left', peerId: peer.id });
      freePeer(room);
    }, opts.pendingTtlMs);
    peer.pendingTimer.unref();

    send(room.host, { type: 'join-request', peerId: peer.id, name: peer.name });
    send(ws, { type: 'waiting' });
  }

  function fromHost(ws, msg) {
    const room = ws.room;
    const peer = room?.peer;
    switch (msg.type) {
      case 'accept':
        if (!peer || peer.id !== msg.peerId || peer.accepted) return fail(ws, 'no-such-peer');
        peer.accepted = true;
        clearTimeout(peer.pendingTimer);
        send(peer.ws, { type: 'accepted' });
        return;
      case 'reject':
        if (!peer || peer.id !== msg.peerId || peer.accepted) return fail(ws, 'no-such-peer');
        send(peer.ws, { type: 'rejected', reason: 'denied' });
        freePeer(room);
        return;
      case 'end':
        if (!peer) return;
        send(peer.ws, { type: 'ended' });
        freePeer(room);
        return;
      case 'refresh': {
        if (room.peer) return fail(ws, 'busy');
        deleteRoom(room);
        return hostRoom(ws, room.ip);
      }
      case 'signal':
        if (!peer?.accepted) return fail(ws, 'not-paired');
        send(peer.ws, { type: 'signal', data: msg.data });
        return;
      default:
        return fail(ws, 'bad-message');
    }
  }

  function fromPeer(ws, msg) {
    const peer = ws.peerState;
    const room = peer.room;
    switch (msg.type) {
      case 'leave':
        send(room.host, { type: 'peer-left', peerId: peer.id });
        freePeer(room);
        return;
      case 'signal':
        if (!peer.accepted) return fail(ws, 'not-paired');
        send(room.host, { type: 'signal', peerId: peer.id, data: msg.data });
        return;
      default:
        return fail(ws, 'bad-message');
    }
  }

  function handleMessage(ws, ip, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail(ws, 'bad-message');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return fail(ws, 'bad-message');
    if (msg.type === 'signal' && (typeof msg.data !== 'object' || msg.data === null)) {
      return fail(ws, 'bad-message');
    }

    if (msg.type === 'host') return hostRoom(ws, ip);
    if (msg.type === 'join') return join(ws, ip, msg);
    if (ws.room) return fromHost(ws, msg);
    if (ws.peerState) return fromPeer(ws, msg);
    return fail(ws, 'not-registered');
  }

  function handleClose(ws) {
    if (ws.room) {
      const room = ws.room;
      if (room.peer) send(room.peer.ws, { type: 'host-left' });
      if (room.peer) {
        const peer = room.peer;
        clearTimeout(peer.pendingTimer);
        room.peer = null;
        peer.ws.peerState = null;
      }
      deleteRoom(room);
    } else if (ws.peerState) {
      const peer = ws.peerState;
      send(peer.room.host, { type: 'peer-left', peerId: peer.id });
      freePeer(peer.room);
    }
  }

  return {
    /** Attach a freshly upgraded WebSocket. `ip` is used for rate limiting only. */
    handleConnection(ws, ip) {
      ws.room = null; // set when this socket is a receiver
      ws.peerState = null; // set when this socket is a sender
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return fail(ws, 'bad-message');
        handleMessage(ws, ip, raw.toString());
      });
      ws.on('close', () => handleClose(ws));
      ws.on('error', () => {});
    },
    stats: () => ({ rooms: rooms.size }),
    close() {
      clearInterval(sweeper);
      for (const room of rooms.values()) {
        clearTimeout(room.expiryTimer);
        if (room.peer) clearTimeout(room.peer.pendingTimer);
      }
      rooms.clear();
    },
  };
}
