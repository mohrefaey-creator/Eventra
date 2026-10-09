// End-to-end: a real receiver page and a real sender page, real WebRTC, real server (HTTP + HTTPS).
// Only screen *capture* is faked (a canvas stream), because a headless browser has no screen picker.
//   npm run test:e2e        (uses $CHROMIUM_PATH, or Playwright's own browser if installed)
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../server/index.js';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-'))) {
      const exe = join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined; // let Playwright look in its default cache
}

const server = await startServer({
  port: 0,
  httpsPort: 0,
  quiet: true,
  host: '127.0.0.1',
  appLinks: { android: 'https://example.test/mirrorlink.apk' },
});
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});

let failed = false;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const receiver = await ctx.newPage();
  const sender = await ctx.newPage();
  for (const [name, page] of [['receiver', receiver], ['sender', sender]]) {
    page.on('pageerror', (e) => console.error(`[${name}] page error:`, e.message));
    page.on('console', (m) => m.type() === 'error' && console.error(`[${name}] console:`, m.text()));
  }

  // Fake getDisplayMedia with an animated 1280x720 canvas.
  await sender.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
      const g = canvas.getContext('2d');
      let t = 0;
      setInterval(() => {
        g.fillStyle = `hsl(${(t += 5) % 360} 80% 50%)`;
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff';
        g.font = '64px sans-serif';
        g.fillText('MirrorLink e2e', 100, 360);
      }, 33);
      return canvas.captureStream(30);
    };
  });

  // --- receiver shows a code and a QR that points at the HTTPS sender page
  await receiver.goto(`http://127.0.0.1:${server.httpPort}/receive`);
  await receiver.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('code').textContent));
  const code = (await receiver.textContent('#code')).replace(/\D/g, '');
  assert.equal(code.length, 6);
  const qr = await receiver.getAttribute('#qr', 'src');
  assert.match(decodeURIComponent(qr), new RegExp(`https://.+/send\\?code=${code}`));
  console.log('ok  receiver shows code + QR');

  // --- deny first, then retry and allow
  await sender.goto(`https://127.0.0.1:${server.httpsPort}/send?code=${code}`);
  assert.equal(await sender.inputValue('#code'), `${code.slice(0, 3)} ${code.slice(3)}`, 'QR prefill');
  await sender.fill('#name', 'Test iPad');
  await sender.click('#start');
  await receiver.waitForSelector('#request[open]');
  assert.equal(await receiver.textContent('#requester'), 'Test iPad');
  await receiver.click('#request button[value=deny]');
  await sender.waitForFunction(() => /declined/.test(document.getElementById('status').textContent));
  console.log('ok  deny is reported to the sender');

  await sender.click('#start');
  await receiver.waitForSelector('#request[open]');
  await receiver.click('#request button[value=allow]');

  // --- video arrives
  await receiver.waitForFunction(() => !document.getElementById('stage').hidden, null, { timeout: 20_000 });
  await receiver.waitForFunction(
    () => {
      const v = document.getElementById('video');
      return v.videoWidth === 1280 && v.videoHeight === 720 && v.currentTime > 0.5;
    },
    null,
    { timeout: 20_000 },
  );
  await sender.waitForFunction(() => /Mirroring/.test(document.getElementById('status').textContent), null, {
    timeout: 20_000,
  });
  console.log('ok  1280x720 video is playing on the receiver');

  // frames keep changing (not a frozen first frame)
  const frames = await receiver.evaluate(
    () => new Promise((resolve) => {
      const v = document.getElementById('video');
      const start = v.getVideoPlaybackQuality().totalVideoFrames;
      setTimeout(() => resolve(v.getVideoPlaybackQuality().totalVideoFrames - start), 1500);
    }),
  );
  assert.ok(frames >= 10, `expected a live stream, got ${frames} frames in 1.5s`);
  console.log(`ok  live stream (${frames} frames in 1.5s)`);

  await receiver.waitForFunction(() => /fps/.test(document.getElementById('stats').textContent), null, { timeout: 5000 });
  console.log(`ok  stats overlay: ${await receiver.textContent('#stats')}`);

  // --- receiver disconnects; both sides return to idle and the code works again
  await receiver.mouse.move(600, 300); // the toolbar auto-hides; moving the pointer wakes it
  await receiver.click('#disconnect');
  await sender.waitForFunction(() => /ended/.test(document.getElementById('status').textContent));
  assert.equal(await receiver.isVisible('#pairing'), true);
  console.log('ok  receiver can disconnect; sender is told');

  // --- sender stops itself
  await sender.click('#start');
  await receiver.waitForSelector('#request[open]');
  await receiver.click('#request button[value=allow]');
  await receiver.waitForFunction(() => !document.getElementById('stage').hidden, null, { timeout: 20_000 });
  await sender.click('#stop');
  await receiver.waitForFunction(() => !document.getElementById('pairing').hidden, null, { timeout: 5000 });
  console.log('ok  sender can stop; receiver returns to pairing');

  // --- wrong code
  await sender.fill('#code', '000000');
  await sender.click('#start');
  await sender.waitForFunction(() => /isn't valid/.test(document.getElementById('status').textContent));
  console.log('ok  wrong code shows a clear error');

  // --- sender on a browser without capture gets an explanation, not a dead button
  const bare = await ctx.newPage();
  await bare.addInitScript(() => delete MediaDevices.prototype.getDisplayMedia);
  await bare.goto(`https://127.0.0.1:${server.httpsPort}/send`);
  assert.match(await bare.textContent('#unsupported'), /can't capture its own screen/);
  assert.equal(await bare.isDisabled('#start'), true);
  console.log('ok  unsupported browsers get an explanation');

  // --- a phone browser is handed over to the native app, with the pairing carried along
  const phone = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    hasTouch: true,
    isMobile: true,
    viewport: { width: 412, height: 900 },
  });
  const phonePage = await phone.newPage();
  await phonePage.addInitScript(() => delete MediaDevices.prototype.getDisplayMedia);
  await phonePage.goto(`https://127.0.0.1:${server.httpsPort}/send?code=${code}`);
  assert.match(await phonePage.textContent('#unsupported-text'), /Use the MirrorLink app/);
  await phonePage.waitForSelector('#get-app:not([hidden])');
  assert.equal(await phonePage.getAttribute('#get-app', 'href'), 'https://example.test/mirrorlink.apk');
  const deepLink = new URL(await phonePage.getAttribute('#open-app', 'href'));
  assert.equal(deepLink.protocol, 'mirrorlink:');
  assert.equal(deepLink.searchParams.get('server'), `https://127.0.0.1:${server.httpsPort}`);
  assert.equal(deepLink.searchParams.get('code'), code);
  await phonePage.fill('#code', '654321'); // typing a new code updates the link
  assert.equal(new URL(await phonePage.getAttribute('#open-app', 'href')).searchParams.get('code'), '654321');
  console.log('ok  phones are offered the app, with server and code in the deep link');

  // --- a TV: big-print layout at /tv, and an approval box that works even without <dialog>
  const tv = await ctx.newPage();
  tv.on('pageerror', (e) => console.error('[tv] page error:', e.message));
  await tv.addInitScript(() => {
    delete HTMLDialogElement.prototype.showModal;
    delete HTMLDialogElement.prototype.close;
  });
  await tv.setViewportSize({ width: 1280, height: 720 });
  await tv.goto(`http://127.0.0.1:${server.httpPort}/tv`);
  await tv.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('code').textContent));
  assert.equal(await tv.evaluate(() => document.documentElement.classList.contains('tv')), true, 'TV layout at /tv');
  assert.equal(await tv.evaluate(() => getComputedStyle(document.documentElement).fontSize), '24px', 'TV text is larger');
  const tvCode = (await tv.textContent('#code')).replace(/\D/g, '');
  const tvSender = await ctx.newPage();
  await tvSender.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
      const g = canvas.getContext('2d');
      setInterval(() => {
        g.fillStyle = `hsl(${Math.random() * 360} 80% 50%)`;
        g.fillRect(0, 0, 640, 360);
      }, 33);
      return canvas.captureStream(30);
    };
  });
  await tvSender.goto(`https://127.0.0.1:${server.httpsPort}/send?code=${tvCode}`);
  await tvSender.fill('#name', 'Remote test');
  await tvSender.click('#start');
  await tv.waitForSelector('dialog.fallback[open]');
  assert.equal(await tv.textContent('#requester'), 'Remote test');
  await tv.click('#request button[value=allow]');
  await tv.waitForFunction(
    () => {
      const v = document.getElementById('video');
      return v.videoWidth === 640 && v.currentTime > 0.5;
    },
    null,
    { timeout: 20_000 },
  );
  console.log('ok  TV layout at /tv; approval works without <dialog>; video plays');

  // --- the screen-check page says "should work" in a modern browser and is not blocked by the CSP
  const check = await ctx.newPage();
  check.on('console', (m) => m.type() === 'error' && console.error('[check] console:', m.text()));
  await check.goto(`http://127.0.0.1:${server.httpPort}/check`);
  await check.waitForFunction(() => document.getElementById('verdict').className === 'good');
  assert.match(await check.textContent('#verdict'), /should work/);
  console.log('ok  /check recognises a capable browser');
} catch (err) {
  failed = true;
  console.error('\nE2E FAILED:', err);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
