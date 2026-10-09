// Sender: captures this device's screen and streams it to an approved receiver.
import { $, connectSignal, ERROR_TEXT, loadInfo, readStore, writeStore } from './signal.js';

const els = {
  form: $('form'),
  code: $('code'),
  name: $('name'),
  quality: $('quality'),
  audio: $('audio'),
  start: $('start'),
  stop: $('stop'),
  status: $('status'),
  unsupported: $('unsupported'),
  unsupportedText: $('unsupported-text'),
  appActions: $('app-actions'),
  openApp: $('open-app'),
  getApp: $('get-app'),
};

// bitrate caps are per-stream; "saver" also halves the pixel count's worth of data
const QUALITY = {
  sharp: { hint: 'detail', maxBitrate: 8_000_000, scale: 1 },
  balanced: { hint: '', maxBitrate: 4_000_000, scale: 1 },
  saver: { hint: 'motion', maxBitrate: 1_500_000, scale: 1.5 },
};

let stream = null;
let sig = null;
let pc = null;
let iceServers = [];
let signalChain = Promise.resolve();
let active = false;

const setStatus = (text, kind = '') => {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
};

// --------------------------------------------------------------- capability

const isAndroid = /Android/i.test(navigator.userAgent);
// iPadOS Safari reports itself as a Mac, so look for touch as well.
const isApple = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function explainUnsupported() {
  if (!window.isSecureContext) {
    showNotice(
      'This page was opened over plain HTTP, so the browser blocks screen capture. ' +
        'Open the https:// address instead and accept the certificate warning once.',
    );
  } else if (!navigator.mediaDevices?.getDisplayMedia) {
    const mobile = isAndroid || isApple;
    showNotice(
      mobile
        ? "This browser can't capture its own screen, which is normal for phones and tablets. Use the MirrorLink app instead."
        : "This browser can't capture its own screen. Try a current desktop browser such as Chrome, Edge, Firefox or Safari on a computer.",
    );
    if (mobile) offerApp();
  }
}

function showNotice(text) {
  els.unsupportedText.textContent = text;
  els.unsupported.hidden = false;
  els.start.disabled = true;
}

/** Buttons that hand this pairing over to the native app (and where to get it). */
async function offerApp() {
  els.appActions.hidden = false;
  const link = () => {
    const code = els.code.value.replace(/\D/g, '');
    return `mirrorlink://join?server=${encodeURIComponent(location.origin)}` + (code ? `&code=${code}` : '');
  };
  els.openApp.href = link();
  els.code.addEventListener('input', () => (els.openApp.href = link()));
  try {
    const { appLinks } = await loadInfo();
    const url = (isApple && appLinks.ios) || (isAndroid && appLinks.android) || appLinks.android || appLinks.ios;
    if (url) {
      els.getApp.href = url;
      els.getApp.hidden = false;
    }
  } catch {
    // no download link is not fatal: "Open in the app" still works for people who have it
  }
}

// --------------------------------------------------------------------- form

const params = new URLSearchParams(location.search);
const prefill = (params.get('code') ?? '').replace(/\D/g, '').slice(0, 6);
if (prefill) els.code.value = `${prefill.slice(0, 3)} ${prefill.slice(3)}`.trim();
els.name.value = readStore('mirrorlink.name') ?? '';

els.code.addEventListener('input', () => {
  const digits = els.code.value.replace(/\D/g, '').slice(0, 6);
  els.code.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
});

explainUnsupported();

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (active || els.start.disabled) return;

  const code = els.code.value.replace(/\D/g, '');
  if (code.length !== 6) {
    setStatus('Enter the 6-digit code shown on the receiving screen.', 'error');
    els.code.focus();
    return;
  }
  const name = els.name.value.trim() || defaultName();
  writeStore('mirrorlink.name', els.name.value.trim());

  // Must happen inside this click handler: browsers only open the screen picker on a user gesture.
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: els.audio.checked,
    });
  } catch (err) {
    setStatus(
      err.name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : `Could not capture the screen (${err.name}).`,
      'error',
    );
    return;
  }
  stream.getVideoTracks()[0].addEventListener('ended', () => stop('Sharing stopped.'));

  active = true;
  setBusy(true);
  setStatus('Connecting…');
  try {
    iceServers = (await loadInfo()).iceServers;
    sig = await connectSignal();
  } catch {
    stop('Cannot reach the MirrorLink server.', true);
    return;
  }
  wireSignaling();
  sig.send({ type: 'join', code, name });
});

els.stop.addEventListener('click', () => {
  sig?.send({ type: 'leave' });
  stop('Stopped sharing.');
});

function defaultName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'device';
  return `${platform} browser`;
}

function setBusy(busy) {
  els.start.hidden = busy;
  els.stop.hidden = !busy;
  for (const el of [els.code, els.name, els.quality, els.audio]) el.disabled = busy;
}

// ---------------------------------------------------------------- signaling

function wireSignaling() {
  sig
    .on('waiting', () => setStatus('Waiting for the receiving screen to approve…'))
    .on('accepted', startPeer)
    .on('rejected', (msg) =>
      stop(msg.reason === 'timeout' ? 'Nobody approved the request in time.' : 'The receiving screen declined.', true),
    )
    .on('ended', () => stop('The receiving screen ended the session.'))
    .on('host-left', () => stop('The receiving screen went away.', true))
    .on('signal', (msg) => {
      signalChain = signalChain.then(() => handleSignal(msg.data)).catch((err) => console.error(err));
    })
    .on('error', (msg) => stop(ERROR_TEXT[msg.code] ?? 'Something went wrong.', true));
  sig.onClose = () => active && stop('Lost connection to the server.', true);
}

async function startPeer() {
  const q = QUALITY[els.quality.value] ?? QUALITY.balanced;
  pc = new RTCPeerConnection({ iceServers });
  const mine = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: 'signal', data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc !== mine) return;
    if (mine.connectionState === 'connected') setStatus('Mirroring. Your screen is visible on the receiver.', 'ok');
    else if (mine.connectionState === 'failed') {
      sig.send({ type: 'leave' });
      stop('Could not open a direct connection. Are both devices on the same network?', true);
    }
  };

  for (const track of stream.getTracks()) {
    if (track.kind === 'video') track.contentHint = q.hint;
    const sender = pc.addTrack(track, stream);
    if (track.kind === 'video') await tuneSender(sender, q);
  }
  await pc.setLocalDescription(await pc.createOffer());
  sig.send({ type: 'signal', data: { description: pc.localDescription } });
  setStatus('Approved. Connecting…');
}

async function tuneSender(sender, q) {
  try {
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = q.maxBitrate;
    params.encodings[0].scaleResolutionDownBy = q.scale;
    await sender.setParameters(params);
  } catch (err) {
    console.warn('could not apply quality settings', err); // non-fatal: defaults still work
  }
}

async function handleSignal(data) {
  if (!pc) return;
  if (data.description) await pc.setRemoteDescription(data.description);
  else if (data.candidate) await pc.addIceCandidate(data.candidate);
}

// ----------------------------------------------------------------- teardown

function stop(message, isError = false) {
  if (!active && !stream) return;
  active = false;
  if (pc) {
    pc.onconnectionstatechange = pc.onicecandidate = null;
    pc.close();
    pc = null;
  }
  if (sig) {
    sig.onClose = null;
    sig.close();
    sig = null;
  }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  signalChain = Promise.resolve();
  setBusy(false);
  setStatus(message, isError ? 'error' : '');
}
