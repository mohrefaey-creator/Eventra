// Shared by the receiver and sender pages: WebSocket signaling + server info.

export const ERROR_TEXT = {
  'bad-code': "That code isn't valid, or it has expired. Check the number on the receiving screen.",
  busy: 'That screen is already receiving from another device.',
  'rate-limited': 'Too many wrong codes. Wait a minute and try again.',
  'too-many-rooms': 'Too many pairing codes are open from this network.',
  'already-registered': 'This page is already connected. Reload it and try again.',
  'bad-message': 'Something went wrong talking to the server. Reload the page and try again.',
};

/** Open the signaling socket. Resolves once connected; rejects if the server is unreachable. */
export function connectSignal() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    const handlers = new Map();
    const api = {
      onClose: null,
      send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
      on(type, fn) {
        handlers.set(type, fn);
        return api;
      },
      close: () => ws.close(),
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('Could not reach the MirrorLink server.'));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      const handler = handlers.get(msg.type);
      if (handler) handler(msg);
    };
    ws.onclose = () => {
      if (api.onClose) api.onClose();
    };
  });
}

/** { iceServers, senderOrigins, secureSenderAvailable } from the server. */
export async function loadInfo() {
  const res = await fetch('/api/info', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load server info.');
  return res.json();
}

export const $ = (id) => document.getElementById(id);

export function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

export function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // private mode / blocked storage: the convenience just doesn't persist
  }
}
