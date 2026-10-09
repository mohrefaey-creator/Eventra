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
| **Sender: iPhone / iPad / Android browsers** | **Not possible from a web page.** `getDisplayMedia` is unavailable in iOS Safari and Chrome for Android, so a website cannot capture a phone's or tablet's screen. The sender page detects this and says so. |

To mirror a phone or tablet you need one of:

- **The system feature**: AirPlay (iPhone/iPad), Cast / Smart View (Android). No code from this project.
- **A thin native sender app** that speaks the protocol in [`docs/PROTOCOL.md`](docs/PROTOCOL.md): an iOS
  ReplayKit *Broadcast Upload Extension* or Android `MediaProjection` capturing the screen, feeding a
  native WebRTC stack. The receiver, pairing and approval flow in this repo work unchanged with it.

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
npm test            # 24 unit + integration tests (pairing logic, server, security checks)
npm run test:e2e    # real browsers: pairing + WebRTC video through the real server (needs Chromium)
```

`test:e2e` uses `$CHROMIUM_PATH`, or a Chromium under `$PLAYWRIGHT_BROWSERS_PATH`, or Playwright's default install.
Only screen *capture* is faked (a canvas stream); signaling, approval, WebRTC and playback are real.

```
server/index.js      HTTP + HTTPS + static files + /ws upgrade
server/signaling.js  pairing codes, approval, signal relay (no I/O: unit-testable)
server/tls.js        self-signed certificate cache
public/              receiver, sender and landing pages (plain ES modules, no build step)
docs/PROTOCOL.md     wire protocol for writing a native sender
test/                node:test suite + Playwright e2e
```
