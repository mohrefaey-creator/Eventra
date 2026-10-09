// Receiver: hosts a pairing code, approves one sender, and plays their screen.
import { $, connectSignal, loadInfo } from './signal.js';

const els = {
  pairing: $('pairing'),
  stage: $('stage'),
  video: $('video'),
  code: $('code'),
  qr: $('qr'),
  senderUrl: $('sender-url'),
  originField: $('origin-field'),
  origin: $('origin'),
  newCode: $('new-code'),
  status: $('status'),
  warning: $('warning'),
  request: $('request'),
  requester: $('requester'),
  who: $('who'),
  stats: $('stats'),
  toolbar: $('toolbar'),
  overlay: $('overlay'),
  mute: $('mute'),
  fullscreen: $('fullscreen'),
  disconnect: $('disconnect'),
};

let info = null;
let sig = null;
let currentCode = '';
let pc = null;
let pendingPeer = null; // { id, name } while the approval dialog is open
let signalChain = Promise.resolve();
let statsTimer = null;
let waitTimer = null;
let idleTimer = null;
let wakeLock = null;
let reconnectDelay = 1000;

const setStatus = (text, kind = '') => {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
};

// ---------------------------------------------------------------- pairing UI

function senderBase() {
  return els.origin.value || info.senderOrigins[0] || location.origin;
}

function renderPairing() {
  if (!currentCode) return;
  const url = `${senderBase()}/send?code=${currentCode}`;
  els.code.textContent = `${currentCode.slice(0, 3)} ${currentCode.slice(3)}`;
  els.senderUrl.textContent = `${senderBase().replace(/^https?:\/\//, '')}/send`;
  els.qr.src = `/api/qr.svg?text=${encodeURIComponent(url)}`;
}

function setupOrigins() {
  const origins = info.senderOrigins.length ? info.senderOrigins : [location.origin];
  els.origin.replaceChildren(
    ...origins.map((o) => Object.assign(document.createElement('option'), { value: o, textContent: o })),
  );
  els.originField.hidden = origins.length < 2;
  if (!info.secureSenderAvailable) {
    els.warning.hidden = false;
    els.warning.textContent =
      'Other devices will not be able to capture their screen: browsers only allow that on HTTPS pages. ' +
      'Start the server with TLS enabled (the default) or put it behind an HTTPS address and set PUBLIC_URL.';
  }
}

// ----------------------------------------------------------------- signaling

async function start() {
  try {
    info ??= await loadInfo();
    if (!els.origin.options.length) setupOrigins();
    sig = await connectSignal();
  } catch {
    setStatus('Cannot reach the MirrorLink server. Retrying…', 'error');
    scheduleReconnect();
    return;
  }
  reconnectDelay = 1000;

  sig
    .on('hosted', (msg) => {
      currentCode = msg.code;
      renderPairing();
      if (!pc) setStatus('Waiting for a device…');
    })
    .on('code-expired', () => sig.send({ type: 'host' }))
    .on('join-request', onJoinRequest)
    .on('peer-left', (msg) => {
      if (pendingPeer?.id === msg.peerId) closeDialog();
      if (pc) endSession('The device disconnected.');
    })
    .on('signal', (msg) => {
      signalChain = signalChain.then(() => handleSignal(msg.data)).catch((err) => console.error(err));
    })
    .on('error', (msg) => console.warn('server error', msg.code));

  sig.onClose = () => {
    teardownPeer();
    showPairing();
    setStatus('Lost connection to the server. Reconnecting…', 'error');
    scheduleReconnect();
  };
  sig.send({ type: 'host' });
}

function scheduleReconnect() {
  setTimeout(start, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
}

// --------------------------------------------------------------- approval UI

function onJoinRequest({ peerId, name }) {
  pendingPeer = { id: peerId, name };
  els.requester.textContent = name;
  els.request.returnValue = '';
  els.request.showModal();
}

function closeDialog() {
  pendingPeer = null;
  if (els.request.open) els.request.close('');
}

els.request.addEventListener('close', () => {
  const peer = pendingPeer;
  if (!peer) return; // closed programmatically (sender left)
  pendingPeer = null;
  if (els.request.returnValue === 'allow') {
    startPeer(peer);
    sig.send({ type: 'accept', peerId: peer.id });
  } else {
    sig.send({ type: 'reject', peerId: peer.id });
  }
});

// -------------------------------------------------------------------- WebRTC

function startPeer(peer) {
  teardownPeer();
  els.who.textContent = peer.name;
  setStatus(`Connecting to ${peer.name}…`);
  pc = new RTCPeerConnection({ iceServers: info.iceServers });
  const mine = pc;
  watchFirstPicture(mine, peer.name);

  pc.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: 'signal', data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    els.video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  pc.onconnectionstatechange = () => {
    if (pc !== mine) return;
    const state = mine.connectionState;
    if (state === 'connected') {
      els.overlay.hidden = true;
    } else if (state === 'disconnected') {
      showOverlay('Connection interrupted - trying to recover…');
    } else if (state === 'failed') {
      sig.send({ type: 'end' });
      endSession(
        'Could not open a direct connection. Make sure both devices are on the same network, or configure a TURN server.',
        true,
      );
    }
  };
}

/**
 * Until the first picture plays, say how far along the connection is. A still screen sends nothing, so
 * "connected but no picture yet" is a state worth showing rather than a frozen "Connecting…".
 */
function watchFirstPicture(mine, name) {
  clearInterval(waitTimer);
  let connectedFor = 0;
  waitTimer = setInterval(async () => {
    if (pc !== mine || !els.stage.hidden) {
      clearInterval(waitTimer);
      return;
    }
    let bytes = 0;
    let decoded = 0;
    try {
      for (const s of (await mine.getStats()).values()) {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          bytes = s.bytesReceived ?? 0;
          decoded = s.framesDecoded ?? 0;
        }
      }
    } catch {
      return;
    }
    if (mine.connectionState !== 'connected') {
      setStatus(`Connecting to ${name}… (${mine.iceConnectionState})`);
      return;
    }
    connectedFor += 1.5;
    const kb = `${Math.round(bytes / 1024)} KB received`;
    const hint = connectedFor > 6 ? " If nothing appears, touch the other device's screen." : '';
    setStatus(
      decoded
        ? `Connected to ${name}. Starting the picture…`
        : `Connected to ${name}. Waiting for the first picture… (${kb}).${hint}`,
    );
  }, 1500);
}

async function handleSignal(data) {
  if (!pc) return;
  if (data.description) {
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      sig.send({ type: 'signal', data: { description: pc.localDescription } });
    }
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  }
}

els.video.addEventListener('playing', showStage);

function showStage() {
  els.pairing.hidden = true;
  els.stage.hidden = false;
  document.title = `Mirroring ${els.who.textContent} - MirrorLink`;
  startStats();
  requestWakeLock();
  wakeToolbar();
}

function showPairing() {
  els.stage.hidden = true;
  els.pairing.hidden = false;
  document.title = 'Receive - MirrorLink';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function teardownPeer() {
  clearInterval(statsTimer);
  clearInterval(waitTimer);
  waitTimer = null;
  clearTimeout(idleTimer);
  statsTimer = null;
  if (pc) {
    pc.onconnectionstatechange = pc.ontrack = pc.onicecandidate = null;
    pc.close();
    pc = null;
  }
  els.video.srcObject = null;
  els.stats.textContent = '';
  els.overlay.hidden = true;
  signalChain = Promise.resolve();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function endSession(message, isError = false) {
  teardownPeer();
  showPairing();
  setStatus(message, isError ? 'error' : '');
}

els.disconnect.addEventListener('click', () => {
  sig.send({ type: 'end' });
  endSession('Disconnected. Ready for the next device.');
});

// ----------------------------------------------------------------- stage UI

function showOverlay(text) {
  els.overlay.textContent = text;
  els.overlay.hidden = false;
}

function wakeToolbar() {
  els.toolbar.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => els.toolbar.classList.add('idle'), 3500);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
  els.stage.addEventListener(ev, wakeToolbar, { passive: true });
}
document.addEventListener('keydown', wakeToolbar);

els.mute.addEventListener('click', () => {
  els.video.muted = !els.video.muted;
  els.mute.textContent = els.video.muted ? 'Unmute' : 'Mute';
  els.mute.setAttribute('aria-pressed', String(els.video.muted));
});

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.stage.requestFullscreen();
  } catch {
    // fullscreen can be refused (e.g. embedded); the stage already fills the window
  }
}
els.fullscreen.addEventListener('click', toggleFullscreen);
els.video.addEventListener('dblclick', toggleFullscreen);

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pc && !wakeLock) requestWakeLock();
});

function startStats() {
  clearInterval(statsTimer);
  let last = null;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    for (const s of report.values()) {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') continue;
      const mbps = last ? ((s.bytesReceived - last.bytes) * 8) / ((s.timestamp - last.ts) * 1000) : 0;
      last = { bytes: s.bytesReceived, ts: s.timestamp };
      els.stats.textContent = [
        s.frameWidth && `${s.frameWidth}×${s.frameHeight}`,
        s.framesPerSecond && `${Math.round(s.framesPerSecond)} fps`,
        mbps && `${mbps.toFixed(1)} Mbps`,
      ]
        .filter(Boolean)
        .join(' · ');
    }
  }, 1000);
}

// ------------------------------------------------------------------ controls

els.newCode.addEventListener('click', () => sig?.send({ type: 'refresh' }));
els.origin.addEventListener('change', renderPairing);

start();
