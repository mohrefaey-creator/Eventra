# MirrorLink

Pair two devices with a 6-digit code (or a QR scan) and mirror a screen into any browser.
The picture travels **peer-to-peer over WebRTC**; the server only handles pairing.

```
 device being mirrored                              computer / TV / any screen
┌──────────────────────┐   pairing code / QR     ┌──────────────────────────┐
│  /send  (sender)     │ ──────────────────────▶ │  /receive  (receiver)    │
│  captures the screen │ ◀────── approve ─────── │  shows code, asks "allow?"│
└──────────┬───────────┘                         └────────────▲─────────────┘
           └───────────── WebRTC video (direct, encrypted) ───┘
                          server relays only the handshake
```

## Quick start

```bash
npm install
npm start
```

1. On the screen that should **show** the mirror, open the receiver URL printed in the terminal
   (`http://localhost:3000/receive`). It shows a code and a QR.
2. On the device being **mirrored**, scan the QR or open the HTTPS sender URL
   (`https://<your-LAN-IP>:3443/send`) and enter the code. The first visit shows a
   certificate warning (the server makes its own certificate): accept it once.
3. Click **Choose screen & connect**, pick what to share, then click **Allow** on the receiver.

Both devices need a network path to each other: the same Wi-Fi, or the internet via a hosted deployment.

## What works where (read this first)

| | |
|---|---|
| **Bluetooth** | **Not used, and it can't be.** Bluetooth bandwidth is far too low for live screen video, and browsers can't act as a Bluetooth peripheral or use it as a media transport (Web Bluetooth is Chromium-only, absent on iOS Safari, and is a central/GATT client only). MirrorLink uses Wi-Fi/IP instead. |
| **Receiver** (shows the mirror) | Any modern browser: laptop, desktop, smart-TV browser, tablet. |
| **Sender: desktop browsers** | Chrome, Edge, Firefox, Safari on Mac/Windows/Linux. Works today. |
| **Sender: Android phones and tablets** | **The Android app in [`android/`](android/README.md)** (Samsung, Honor, any Android 8+). A web page cannot capture a phone's screen, so the app does it and uses the same pairing and receiver. On a phone, the sender page offers an **Open in the MirrorLink app** button. |
| **Sender: iPhone / iPad** | **Not built yet.** It needs a native app too (an iOS ReplayKit Broadcast Upload Extension) and cannot be built or tested on Linux. [`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the spec it will follow. Until then use the built-in AirPlay. |
| **Sender: phone/tablet browsers** | Not possible: `getDisplayMedia` is unavailable in iOS Safari and Chrome for Android. The sender page detects this and points to the app. |

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (use for the receiver on the same machine) |
| `HTTPS_PORT` | `3443` | HTTPS port with an auto-generated self-signed certificate (use for senders on the LAN) |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `TLS` | on | `TLS=off` disables the HTTPS listener (do this behind a TLS-terminating proxy) |
| `PUBLIC_URL` | – | Public HTTPS origin senders should use, e.g. `https://mirror.example.com` |
| `ICE_SERVERS` | Google STUN | JSON array of STUN/TURN servers. Add a **TURN** server for devices on different networks / strict firewalls |
| `TRUST_PROXY` | off | `1` to use `X-Forwarded-For` for rate limiting (only behind a proxy you control) |
| `ANDROID_APP_URL` / `IOS_APP_URL` | – | Where to get the sender app; the sender page shows a **Get the app** link on phones |
| `ANDROID_CERT_SHA256` | – | SHA-256 fingerprint(s) of the Android app's signing key (comma-separated). Publishes `/.well-known/assetlinks.json` so a scanned QR opens the app directly |
| `ANDROID_PACKAGE` | `app.mirrorlink` | Android package name used in `assetlinks.json` |

**Why HTTPS?** Browsers only allow screen capture on secure origins. `http://localhost` counts, but
`http://192.168.x.x` does not, so senders on the LAN must use the HTTPS port. The certificate is cached in `.certs/`
and regenerated when your LAN addresses change.

**Hosting it publicly:** run behind a reverse proxy that terminates TLS and forwards WebSockets (`/ws`), set
`TLS=off`, `PUBLIC_URL`, `TRUST_PROXY=1`, and provide a TURN server. Serverless platforms that can't hold WebSockets
open (for example Vercel functions) are not suitable for this server.

## Security model

- A code is 6 random digits, valid for 10 minutes while unused, one sender at a time.
- **The receiver must click Allow for every connection**, so a guessed code alone never shows anything.
- Wrong guesses are rate limited per IP; open codes are capped per IP.
- WebSocket handshakes from browser pages on other origins are refused.
- Video is end-to-end encrypted by WebRTC (DTLS-SRTP) and never touches the server.
- Strict CSP (no inline scripts or styles), no third-party scripts, no analytics.

## Troubleshooting

- **"Could not open a direct connection"**: the devices can't reach each other (different networks, guest Wi-Fi
  with client isolation, VPN). Use the same network or configure a TURN server in `ICE_SERVERS`.
- **Certificate warning on every visit**: it should appear once per device. If it returns, the server's LAN IP changed
  and the certificate was regenerated; accept it again.
- **Sender button is disabled**: read the notice on the page: it's either plain HTTP or a browser with no screen capture.
- **No sound**: the receiver starts muted (browser autoplay rules). Click **Unmute**. Sender-side audio capture is
  browser/OS dependent (best on Chrome/Edge, tab or system audio).

## Development

```bash
npm test            # 27 unit + integration tests (pairing logic, server, security checks, app links)
npm run test:e2e    # real browsers: pairing + WebRTC video through the real server (needs Chromium)
cd android && ./gradlew -PcoreOnly :core:test   # 24 tests for the Android pairing core, incl. against the real server
```

`test:e2e` uses `$CHROMIUM_PATH`, or a Chromium under `$PLAYWRIGHT_BROWSERS_PATH`, or Playwright's default install.
Only screen *capture* is faked (a canvas stream); signaling, approval, WebRTC and playback are real.

```
server/index.js      HTTP + HTTPS + static files + /ws upgrade
server/signaling.js  pairing codes, approval, signal relay (no I/O: unit-testable)
server/tls.js        self-signed certificate cache
android/             Android sender app (see android/README.md)
public/              receiver, sender and landing pages (plain ES modules, no build step)
docs/PROTOCOL.md     wire protocol for writing a native sender
test/                node:test suite + Playwright e2e
```
